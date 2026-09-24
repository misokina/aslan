#!/usr/bin/env node
'use strict';
//
// 朝花的记忆 MCP server（stdio）。给 agent 三个工具：
//   recall_memory  按意思召回，**只回摘要**（名字 + 一句话描述 + 关于谁）
//   read_memory    按名字读正文，末尾带标签和它们的全部历史
//   tag_memory     给**自己的**记忆改标签，覆盖不删、留时间 —— 唯一会写的那个，只写自己的 meta/
//
// ⚠ 两层是故意的：索引该常驻（一睁眼就看得见，不需要先想起来去查），正文按需取。
//   **MCP 解决「能查」，不解决「会想起来查」** —— 它不替代常驻索引，是补在它后面。
// ⚠⚠ stdout 是 JSON-RPC 通道，往里写任何杂物都会让连接坏掉。日志一律走 stderr。
//
// ── 按意思召回怎么判 ──
// 只按字面匹配的话，要用描述里原本的词才找得到，换个说法就找不到 —— 而那句描述和常驻索引几乎是同一句话，
// 所以找得到的本来就看得见。现在的做法（设计和评测记录见 README「按意思召回」）：
//   · 调用方先写一句「我想找什么」；想找好几件事就拆成几条 intents，每条单独判；
//   · 每条带类型：thing = 找讲这件事、或能解释它的记忆；cause = 找可能导致它的「那件事」。
//     **类型决定判断器怎么问** —— 构造的因果题上，同一个判断器用通用问法 1/5，专门问「是不是一个可能原因」5/5，
//     向量检索 1/5（总把字面沾边的排第一）；但因果问法对「教训」类记忆会普遍给高分，所以找教训用 thing；
//   · 默认交给 Jev（一个只出校准概率的判断模型）；它挂了退到向量（Gemini embedding），再不行退到字面匹配，
//     而且**退了要在回复里说出来**；
//   · 合并时有 Jev 就听 Jev 的（「为什么」题上 8/8，几路平均看 7/8 —— 会被向量拖下去）；
//   · 「关于谁」用侧车里的 about 标签先筛候选，不交给判断器（人名这种宽词，按「只提到不算」的问法它不给分）。
// ⚠ 会把候选记忆的**名字 + 一句话描述**、以及意图，发给 Jev 和 Google；正文不发。不想发就 ASLAN_MEMORY_SEMANTIC=off。
//
// ── 场合：只提醒，不过滤 ──
// inside / outside 召回的东西**完全一样**，outside 只多一句「注意往外说多少」。
// 要管的是**说出去多少**，不是**看到多少** —— 看得全才判断得好，判断该说什么是 agent 的事，不是拦截器的事。
// （做错过两版：一版在外面一条都不给，一版只给 3 条、不带别人的。都被纠了回来。）
//
// env（都有默认值）：
//   ASLAN_MEMORY_WHO         我是谁（参与者 id），默认 config/group.json 里第一个 agent
//   ASLAN_SHARED_MEMORY_DIR  记忆根：每个 agent 一个子目录 <根>/<id>，默认 ASLAN_DATA_DIR/memory
//   ASLAN_MEMORY_DIR         我自己的目录，默认 <根>/<我>
//   ASLAN_MEMORY_SCOPE       inside（默认）| outside
//   ASLAN_MEMORY_SEMANTIC    on（默认）| off —— off 只走字面匹配，一个请求都不发
//   JEV_API_KEY | JEV_API_KEY_FILE、GEMINI_API_KEY | GEMINI_API_KEY_FILE   key，或者装着 key 的文件
//   ASLAN_MEMORY_KEY_FILES   额外的 .env 风格文件（用系统路径分隔符隔开），从里面找上面那几个名字
//   ASLAN_MEMORY_PROXY       代理；不给就用 HTTPS_PROXY；none = 不走代理
//   ASLAN_JEV_URL / ASLAN_GEMINI_BASE / ASLAN_EMBED_MODEL / ASLAN_MEMORY_HTTP_TIMEOUT_MS

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { execFileSync } = require('child_process');
const { DEFAULT_MEMORY_DIR } = require('../lib/memory-metadata');
const { getParticipantConfig } = require('../lib/participant-config');

const PARTICIPANTS = getParticipantConfig();
const HUMAN = PARTICIPANTS.participants.human;
const WHO = process.env.ASLAN_MEMORY_WHO || PARTICIPANTS.agentIds[0];
const MEMORY_ROOT = process.env.ASLAN_SHARED_MEMORY_DIR || DEFAULT_MEMORY_DIR;
const MEMORY_DIR = process.env.ASLAN_MEMORY_DIR || path.join(MEMORY_ROOT, WHO);
const OTHERS = PARTICIPANTS.agentIds.filter((id) => id !== WHO);
const SCOPE = process.env.ASLAN_MEMORY_SCOPE === 'outside' ? 'outside' : 'inside';
const dirOf = (who) => (who === WHO ? MEMORY_DIR : path.join(MEMORY_ROOT, who));

const PROTOCOL_VERSION = '2024-11-05';
const RECALL = path.join(__dirname, 'recall.js');
const MAX_BODY = 20000;   // 一条正文最多回这么多字符，防止一次把上下文塞爆

function log(...args) {
  try { process.stderr.write(`[mcp-memory] ${args.join(' ')}\n`); } catch { /* 日志失败绝不能影响协议 */ }
}
function send(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`); }
function replyResult(id, result) { if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, error: { code, message } }); }

const OUTSIDE_NOTE = '⚠ 现在是在**外面**的场合：上面这些是内部记忆，'
  + `看可以，**注意往外说多少** —— 个人信息是 ${HUMAN.name} 的，${HUMAN.name} 自己给出去过的才给。`;

// ── 字面匹配（bin/recall.js）：没有 key、关掉了、或者两家都挂了时的退路 ──
function recallFrom(dir, who, query) {
  if (!dir || !fs.existsSync(dir)) return [];
  let out;
  try {
    out = execFileSync(process.execPath, [RECALL, '--dir', dir, '--json', query],
      { encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    log(`recall 失败 dir=${dir}: ${err.message}`);
    return [];
  }
  let items;
  try { items = JSON.parse(out); } catch { log(`recall 输出不是 JSON: ${out.slice(0, 120)}`); return []; }
  return (Array.isArray(items) ? items : []).map((x) => ({ ...x, who }));
}

// ── 按意思召回 ──
const SEMANTIC_ON = (process.env.ASLAN_MEMORY_SEMANTIC || 'on') !== 'off';
const JEV_URL = process.env.ASLAN_JEV_URL || 'https://api.typesafe.ai/v1/systemone';
const GEMINI_BASE = process.env.ASLAN_GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const EMBED_MODEL = process.env.ASLAN_EMBED_MODEL || 'gemini-embedding-2';
const HTTP_TIMEOUT_MS = Number(process.env.ASLAN_MEMORY_HTTP_TIMEOUT_MS) || 25000;
const JEV_BATCH = 12;
const MAX_INTENTS = 5;
const METHODS = ['jev', 'vector', 'literal'];
const METHOD_LABEL = { jev: 'Jev', vector: '向量', literal: '字面匹配' };
const TYPE_LABEL = { thing: '找这件事', cause: '找原因' };

const JEV_ASK = {
  thing: {
    ask: (i) => `如果现在要找 QUERY 说的这件事，记忆 [${i}] 值不值得拿出来看。`,
    yes: '这条记忆讲的就是 QUERY 问的事，或者能直接回答它 —— 换了说法、用了近义词、只讲了其中一面，都算。',
    no: '只是碰巧提到同一个词或同一个人，讲的其实是别的事。',
  },
  // ⚠ 这套是看到通用问法在因果题上失败之后才加的，只在几道构造题上验过 —— 换一批新题再验之前别当定论。
  cause: {
    ask: (i) => `记忆 [${i}] 说的事，是不是 QUERY 那个情况的一个可能原因。`,
    yes: '它描述的事情能直接或间接导致 QUERY 说的情况。',
    no: '它和 QUERY 只是字面或领域上沾边，不会导致那个情况。',
  },
};

function readTextFile(p) {
  try {
    const b = fs.readFileSync(p);
    if (b[0] === 0xff && b[1] === 0xfe) return b.toString('utf16le');   // PowerShell 的 `>` 写的是 UTF-16LE
    return b.toString('utf8');
  } catch { return ''; }
}
function firstValue(text) {
  for (let line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.includes('=')) line = line.slice(line.indexOf('=') + 1).trim();
    return line.replace(/^["']|["']$/g, '') || null;
  }
  return null;
}
// key 的顺序：环境变量 > XXX_FILE 指向的文件 > ASLAN_MEMORY_KEY_FILES 里的 .env 文件。**绝不打印。**
function keyFrom(names, fileVar) {
  for (const n of names) if (process.env[n]) return process.env[n];
  if (process.env[fileVar]) {
    const v = firstValue(readTextFile(process.env[fileVar]));
    if (v) return v;
  }
  for (const f of (process.env.ASLAN_MEMORY_KEY_FILES || '').split(path.delimiter).filter(Boolean)) {
    for (const line of readTextFile(f).replace(/^﻿/, '').split(/\r?\n/)) {
      for (const n of names) {
        const m = line.match(new RegExp(`^\\s*${n}\\s*=\\s*(.+?)\\s*$`));
        if (m) return m[1].replace(/^["']|["']$/g, '');
      }
    }
  }
  return null;
}
const jevKey = () => keyFrom(['JEV_API_KEY', 'TYPESAFE_API_KEY'], 'JEV_API_KEY_FILE');
const geminiKey = () => keyFrom(['GEMINI_API_KEY', 'GOOGLE_API_KEY'], 'GEMINI_API_KEY_FILE');
function proxyUrl() {
  const v = process.env.ASLAN_MEMORY_PROXY;
  if (v !== undefined) return v && v !== 'none' ? v : null;
  return process.env.HTTPS_PROXY || process.env.https_proxy || null;
}

// Node 的 fetch 不认 HTTPS_PROXY，所以自己打 CONNECT 隧道。错误信息里绝不带 key。
function requestJson(urlStr, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const live = [];
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { for (const s of live) { try { s.destroy(); } catch { /* 已经关了 */ } } reject(err); } else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`超时 ${Math.round(HTTP_TIMEOUT_MS / 1000)} 秒`)), HTTP_TIMEOUT_MS);
    const u = new URL(urlStr);
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const opts = {
      method: 'POST',
      path: `${u.pathname}${u.search}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers },
    };
    const onResponse = (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', (e) => finish(e));
      res.on('end', () => {
        if (res.statusCode >= 400) return finish(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(new Error('返回的不是 JSON')); }
      });
    };
    const send = (req) => { live.push(req); req.on('error', (e) => finish(e)); req.end(payload); };
    if (u.protocol === 'http:') { send(http.request({ ...opts, hostname: u.hostname, port: u.port || 80 }, onResponse)); return; }
    const proxy = proxyUrl();
    if (!proxy) { send(https.request({ ...opts, hostname: u.hostname, port: u.port || 443, servername: u.hostname }, onResponse)); return; }
    const p = new URL(proxy);
    const target = `${u.hostname}:${u.port || 443}`;
    const connect = http.request({ hostname: p.hostname, port: p.port || 80, method: 'CONNECT', path: target, headers: { Host: target } });
    live.push(connect);
    connect.on('error', (e) => finish(e));
    connect.on('connect', (res, socket) => {
      live.push(socket);
      if (res.statusCode !== 200) return finish(new Error(`代理没接 CONNECT（${res.statusCode}）`));
      // ⚠⚠ 这里**不能**写 `agent: false`：那样 Node 会新建一个 Agent，用它自己的 createConnection，
      //   把这条隧道忽略掉、直接去连目标。实测一次：直连不通的那家 47 秒超时，能直连的那家看起来一切正常。
      send(https.request({
        ...opts, hostname: u.hostname, port: u.port || 443, servername: u.hostname,
        createConnection: () => tls.connect({ socket, servername: u.hostname }),
      }, onResponse));
    });
    connect.end();
  });
}

// 超时 / 过载 / 5xx 重试一次；其它 4xx（key 不对之类）重试也没用
async function withRetry(fn) {
  try { return await fn(); } catch (e) {
    if (e.status && e.status < 500 && e.status !== 408 && e.status !== 429) throw e;
    await new Promise((r) => setTimeout(r, 1500));
    return fn();
  }
}

// 候选：名字 + 一句话描述 + 「关于」标签。索引文件（MEMORY.md / INDEX.md）不是记忆。
function loadCandidates(withOther) {
  const owners = [WHO, ...(withOther ? OTHERS : [])];
  const out = [];
  for (const who of owners) {
    const dir = dirOf(who);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'INDEX.md').sort(); } catch { continue; }
    for (const f of files) {
      const name = f.slice(0, -3);
      if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
      const m = readTextFile(path.join(dir, f)).match(/^description:\s*(.+?)\s*$/m);
      const side = readSidecar(dir, name);
      out.push({
        key: `${who}/${name}`, who, dir, name,
        desc: m ? m[1].slice(0, 300) : '',
        about: Array.isArray(side?.tags?.about) ? side.tags.about : [],
        occurredAt: side.occurredAt || null,
      });
    }
  }
  return out;
}

const noul = (a) => {
  const v = a == null ? null : (a.noul ?? a.probability ?? a.value ?? a.answer);
  return typeof v === 'number' ? v : null;
};

async function jevScores(it, cands, key) {
  const ask = JEV_ASK[it.type] || JEV_ASK.thing;
  const batches = [];
  for (let s = 0; s < cands.length; s += JEV_BATCH) batches.push(cands.slice(s, s + JEV_BATCH));
  const parts = await Promise.all(batches.map(async (batch) => {
    const questions = {};
    batch.forEach((_, i) => {
      questions[`q_${i}`] = { type: 'noul', instructions: ask.ask(i), criteria: { true: ask.yes, false: ask.no } };
    });
    const state = `<QUERY>\n${it.text}\n</QUERY>\n\n<记忆>\n${batch.map((c, i) => `[${i}] ${c.name}：${c.desc}`).join('\n')}\n</记忆>`;
    const r = await withRetry(() => requestJson(JEV_URL, {
      headers: { Authorization: `Bearer ${key}` },
      body: { model: 'jev-latest', state, questions },
    }));
    return batch.map((c, i) => [c.key, noul(r?.answers?.[`q_${i}`])]);
  }));
  return new Map(parts.flat());
}

const docVectors = new Map();   // 记忆那一侧只嵌一次（按名字 + 描述），同一个进程里反复召回不用重算
async function embed(texts, task, key) {
  const r = await withRetry(() => requestJson(`${GEMINI_BASE}/models/${EMBED_MODEL}:batchEmbedContents`, {
    headers: { 'x-goog-api-key': key },
    body: { requests: texts.map((t) => ({ model: `models/${EMBED_MODEL}`, content: { parts: [{ text: t }] }, taskType: task })) },
  }));
  return (r.embeddings || []).map((e) => e.values);
}
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : null;
}
async function vectorScores(it, cands, key) {
  const docKey = (c) => `${c.key}\n${c.desc}`;
  const missing = cands.filter((c) => !docVectors.has(docKey(c)));
  for (let s = 0; s < missing.length; s += 100) {
    const chunk = missing.slice(s, s + 100);
    const vecs = await embed(chunk.map((c) => `${c.name}：${c.desc}`), 'RETRIEVAL_DOCUMENT', key);
    chunk.forEach((c, i) => docVectors.set(docKey(c), vecs[i]));
  }
  const [q] = await embed([it.text], 'RETRIEVAL_QUERY', key);
  return new Map(cands.map((c) => [c.key, cosine(q, docVectors.get(docKey(c)))]));
}
function literalScores(it, cands) {
  const byDir = new Map();
  for (const c of cands) byDir.set(c.dir, c.who);
  const allowed = new Set(cands.map((c) => c.key));
  const scores = new Map();
  for (const [dir, who] of byDir) {
    recallFrom(dir, who, it.text).forEach((x, rank) => {
      const key = `${who}/${x.name}`;
      if (allowed.has(key) && !scores.has(key)) scores.set(key, 100 - rank);
    });
  }
  return scores;
}

function normalizeIntents(args) {
  const list = [];
  const push = (text, type, via) => {
    const t = String(text || '').trim();
    if (!t) return;
    list.push({
      text: t,
      type: type === 'cause' ? 'cause' : 'thing',
      via: [...new Set((Array.isArray(via) ? via : []).filter((m) => METHODS.includes(m)))],
    });
  };
  push(args.query, args.type, args.via);
  if (Array.isArray(args.intents)) for (const it of args.intents) push(it?.text, it?.type, it?.via);
  return list.slice(0, MAX_INTENTS);
}

// 一条意图：按要的方式跑；要的全挂了就按 Jev → 向量 → 字面 往下退
async function scoreIntent(it, idx, cands, keys, notes) {
  const used = [];
  const tried = new Set();
  const attempt = async (m) => {
    if (tried.has(m)) return false;
    tried.add(m);
    if (m === 'jev' && !keys.jev) return false;
    if (m === 'vector' && !keys.gemini) return false;
    try {
      const scores = m === 'jev' ? await jevScores(it, cands, keys.jev)
        : m === 'vector' ? await vectorScores(it, cands, keys.gemini)
          : literalScores(it, cands);
      used.push({ m, scores });
      return true;
    } catch (e) {
      // ⚠ 有的网络错误 message 是空的 —— 退到 code / 类名，不然只看得到一对空括号
      const why = e.message || e.code || e.name || '原因不明';
      log(`召回 ${m} 失败：${e.stack || why}`);
      notes.push(`意图 ${idx + 1} 的${METHOD_LABEL[m]}这次没回来（${String(why).slice(0, 40)}）`);
      return false;
    }
  };
  const wanted = it.via.length ? it.via : ['jev'];
  const results = await Promise.all(wanted.map(attempt));
  if (!results.some(Boolean)) {
    for (const m of METHODS) {
      if (await attempt(m)) {
        notes.push(`意图 ${idx + 1} 改用${METHOD_LABEL[m]}`);
        break;
      }
    }
  }
  return used;
}

async function doRecall(args) {
  const intents = normalizeIntents(args);
  const about = [...new Set((Array.isArray(args.about) ? args.about : (args.about ? [args.about] : []))
    .map((a) => String(a).trim()).filter((a) => ABOUT_RE.test(a)))];
  if (!intents.length && !about.length) throw new Error('query、intents、about 至少给一个');
  const limit = Math.max(1, Math.min(30, Number(args.limit) || (intents.length ? 8 : 20)));

  // ⚠ 默认**只搜自己的**：互相可读，但默认不交叉召回。关于别人的事，先从自己记下的里面找（about）；
  //   想知道对方当时自己怎么想，才显式传 include_other: true。
  let cands = loadCandidates(args.include_other === true);
  if (about.length) cands = cands.filter((c) => c.about.some((a) => about.includes(a)));
  const tail = SCOPE === 'outside' ? `\n\n${OUTSIDE_NOTE}` : '';
  if (!cands.length) return `没有符合条件的记忆（关于：${about.join('、') || '不限'}）。${tail}`;

  // 只给了「关于谁」：把筛出来的按发生日期列出来，不用判断
  if (!intents.length) {
    cands.sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')) || a.name.localeCompare(b.name));
    return renderRecall(cands.slice(0, limit), `关于 ${about.join('、')} 的记忆一共 ${cands.length} 条（按发生日期，新的在前）`,
      [], null, false) + tail;
  }

  const keys = SEMANTIC_ON ? { jev: jevKey(), gemini: geminiKey() } : { jev: null, gemini: null };
  const notes = [];
  if (!SEMANTIC_ON) notes.push('按意思召回关着（ASLAN_MEMORY_SEMANTIC=off），只按字面匹配');
  else if (!keys.jev && !keys.gemini) notes.push('没找到 Jev / Gemini 的 key，只按字面匹配');

  const usedPerIntent = await Promise.all(intents.map((it, i) => scoreIntent(it, i, cands, keys, notes)));
  const ev = new Map();
  let anyJev = false;
  let anyVec = false;
  usedPerIntent.forEach((used, idx) => {
    for (const { m, scores } of used) {
      if (m === 'jev') anyJev = true;
      if (m === 'vector') anyVec = true;
      for (const [k, s] of scores) {
        if (s == null) continue;
        const e = ev.get(k) || { jev: -1, vec: -1, lit: -1, jevFrom: 0 };
        if (m === 'jev' && s > e.jev) { e.jev = s; e.jevFrom = idx; }
        if (m === 'vector' && s > e.vec) e.vec = s;
        if (m === 'literal' && s > e.lit) e.lit = s;
        ev.set(k, e);
      }
    }
  });
  // 有 Jev 就听 Jev 的，向量、字面只用来打破平分
  const lead = anyJev ? 'jev' : anyVec ? 'vec' : 'lit';
  const ranked = cands.filter((c) => (ev.get(c.key)?.[lead] ?? -1) >= 0).sort((a, b) => {
    const x = ev.get(a.key); const y = ev.get(b.key);
    return (y.jev - x.jev) || (y.vec - x.vec) || (y.lit - x.lit) || a.name.localeCompare(b.name);
  });
  if (!ranked.length) {
    return `没有召回到相关记忆（找的是${intents.map((it) => `「${it.text}」`).join('、')}，场合 ${SCOPE}）。换个说法再试。`
      + (notes.length ? `\n⚠ ${notes.join('；')}` : '') + tail;
  }
  const how = intents.map((it, i) => `${intents.length > 1 ? `意图 ${i + 1} ` : ''}「${it.text}」（${TYPE_LABEL[it.type]}）`).join('；');
  return renderRecall(ranked.slice(0, limit), `召回 ${Math.min(limit, ranked.length)} 条 · ${how}`, notes, ev, intents.length > 1, lead) + tail;
}

const LEGEND = {
  jev: 'Jev 那个数是它判断「相关」的概率；标了「低」的只是排得上，不一定真相关。',
  vec: '向量那个数是「意思像不像」的相似度，不是概率，只看排序；它抓不到因果。',
  lit: '这次是字面匹配：要用描述里原本的词才找得到。',
};

function renderRecall(list, header, notes, ev, multi, lead) {
  const lines = list.map((c, i) => {
    const e = ev && ev.get(c.key);
    const parts = [];
    if (e) {
      if (e.jev >= 0) parts.push(`Jev ${e.jev.toFixed(2)}${e.jev < 0.5 ? '（低）' : ''}${multi ? `·意图 ${e.jevFrom + 1}` : ''}`);
      if (e.vec >= 0) parts.push(`向量 ${e.vec.toFixed(2)}`);
      if (!parts.length && e.lit >= 0) parts.push('字面命中');
    }
    // 「谁写的」和「讲的是谁」分开显示：[id] 是谁写的，「关于」是讲的是谁
    const aboutText = c.about.length ? ` · 关于 ${c.about.join('、')}` : '';
    // 标签改过的，多一行「底下还有」—— 不提示的话，覆盖过的和从没变过的长得一样
    const hint = tagHint(readSidecar(c.dir, c.name));
    return `${i + 1}. [${c.who}] ${c.name}${parts.length ? `（${parts.join('，')}）` : ''}${aboutText}\n`
      + `   ${c.desc || '(没有 description)'}${hint ? `\n   ↳ ${hint}` : ''}`;
  });
  const legend = ev ? `\n（${LEGEND[lead] || ''}只有摘要，要正文调 read_memory。）` : '';
  return `${header}${notes.length ? `\n⚠ ${notes.join('；')}` : ''}${legend}\n\n${lines.join('\n')}`;
}

// ── 读正文 ──
function doRead({ name, who }) {
  const n = String(name || '').trim();
  // ⚠ 只认安全的名字：不许 .. 不许分隔符。这个入口读的是文件，不能让名字决定路径。
  if (!/^[A-Za-z0-9._-]+$/.test(n) || n.includes('..')) throw new Error(`名字不合法：${name}`);
  const owner = who || WHO;
  if (owner !== WHO && !OTHERS.includes(owner)) throw new Error(`不认识这个参与者：${owner}`);
  const target = dirOf(owner);
  const file = path.join(target, `${n}.md`);
  if (!fs.existsSync(file)) throw new Error(`没有这条记忆：${n}`);

  const text = fs.readFileSync(file, 'utf8');
  const body = text.length > MAX_BODY
    ? `${text.slice(0, MAX_BODY)}\n\n…（正文被截断，原文 ${text.length} 字符，在 ${file}）`
    : text;
  // 标签和它们的全部历史 —— 「底下还有东西」要能抓得到，不能只在召回时说一句
  const withTags = body + tagReport(readSidecar(target, n));
  // ⚠ 外面照读不拦，只把提醒带上 —— 管的是往外说多少，不是能看多少
  return SCOPE === 'outside' ? `${withTags}\n\n${OUTSIDE_NOTE}` : withTags;
}

// ── 标签：覆盖不删 ──
// 一个判断变了，不删旧的：覆盖，并记下时间；召回时顺带说一句「这里变过，底下还有」。心情也一样 ——
// 回头看觉得是另一种心情，可以再标一次，旧的留着。
// ⚠ 积累和覆盖**不冲突**：覆盖留下了全部历史，积累就是历史里各类占多少。
//   很久以前一次强烈的怕，现在标成平静了，也还看得见。
// ⚠ 心情**不强迫**：想标的时候才标，只记强弱 + 方向，不用具体的情绪名词。
// ⚠ 只写**自己的**目录。别的 agent 的侧车里可能用 `tags.mood` 记累加次数；这里的心情历史另放
//   `moodHistory`，不碰那个字段。锁和 lib/tags.js 是同一个文件（meta/<名字>.lock），两边同时改一条时排队。
const STRENGTH_LABEL = { strong: '强烈', mild: '一般' };
const DIRECTION_LABEL = { '+': '正', '-': '负', '±': '混' };
const ABOUT_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const LOCK_TIMEOUT_MS = 10000;   // 和 lib/tags.js 一样
const STALE_LOCK_MS = 60000;

function readSidecar(dir, name) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(name || '')) || String(name).includes('..')) return {};
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta', `${name}.json`), 'utf8')) || {}; } catch { return {}; }
}

// 本地时间带偏移（如 +08:00）。⚠ 不用 toISOString 的 `Z`：深夜改的，UTC 日期会差一天
function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const two = (x) => String(Math.floor(Math.abs(x))).padStart(2, '0');
  const local = new Date(d.getTime() + off * 60000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? '+' : '-'}${two(off / 60)}:${two(off % 60)}`;
}
const shortTime = (iso) => String(iso || '').slice(0, 16).replace('T', ' ');

function atomicWriteJson(file, value) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* rename 之后它本来就不在了 */ }
  }
}

async function withEntryLock(dir, name, fn) {
  const metaDir = path.join(dir, 'meta');
  fs.mkdirSync(metaDir, { recursive: true });
  const lock = path.join(metaDir, `${name}.lock`);
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`, 'utf8');
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) { fs.unlinkSync(lock); continue; }
      } catch (statErr) {
        if (statErr && statErr.code === 'ENOENT') continue;
        throw statErr;
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error('这条的标签正被别的工具改着，等了 10 秒，稍后再试');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch { /* 已经没了 */ } }
}

function validMoods(side) {
  return (Array.isArray(side.moodHistory) ? side.moodHistory : [])
    .filter((m) => m && STRENGTH_LABEL[m.strength] && DIRECTION_LABEL[m.direction]);
}
const moodLabel = (m) => `${DIRECTION_LABEL[m.direction]}·${STRENGTH_LABEL[m.strength]}${m.note ? `（${m.note}）` : ''}`;

// 召回时那一行：改过几次、心情现在是什么、**以前的里同一类占多少**、有没有强烈的
function tagHint(side) {
  const parts = [];
  const changes = Array.isArray(side.tagHistory) ? side.tagHistory : [];
  const moods = validMoods(side);
  const overwrites = changes.length + Math.max(0, moods.length - 1);
  if (overwrites) {
    const times = [...changes.map((c) => c.at), ...moods.slice(1).map((m) => m.at)].filter(Boolean).sort();
    parts.push(`标签改过 ${overwrites} 次${times.length ? `（最近 ${String(times[times.length - 1]).slice(0, 10)}）` : ''}，`
      + '底下还有旧的，read_memory 看得到');
  }
  if (moods.length) {
    const now = moods[moods.length - 1];
    let s = `心情现在 ${moodLabel(now)}`;
    const past = moods.slice(0, -1);
    if (past.length) {
      const same = past.filter((m) => m.direction === now.direction).length;
      const counts = {};
      for (const m of past) counts[m.direction] = (counts[m.direction] || 0) + 1;
      const breakdown = Object.entries(counts).sort((a, b) => b[1] - a[1])
        .map(([d, c]) => `${DIRECTION_LABEL[d]} ${c}`).join('、');
      s += `；以前 ${past.length} 次里和现在同一类的 ${same} 次（${Math.round((same / past.length) * 100)}%），${breakdown}`;
      const strong = past.filter((m) => m.strength === 'strong');
      if (strong.length) {
        s += `，其中强烈的 ${strong.length} 次（${[...new Set(strong.map((m) => DIRECTION_LABEL[m.direction]))].join('、')}）`;
      }
    }
    parts.push(s);
  }
  return parts.join('；');
}

// read_memory 末尾的全量：每一次改动都在，从旧到新
function tagReport(side) {
  const tags = side.tags && typeof side.tags === 'object' ? side.tags : {};
  const lines = [];
  if (Array.isArray(tags.about) && tags.about.length) lines.push(`关于：${tags.about.join('、')}`);
  if (side.occurredAt) lines.push(`发生：${side.occurredAt}`);
  if (Array.isArray(tags.topic) && tags.topic.length) lines.push(`话题：${tags.topic.join('、')}`);
  if (typeof tags.place === 'string' && tags.place) lines.push(`地点：${tags.place}`);
  const moods = validMoods(side);
  if (moods.length) {
    lines.push('心情（从旧到新，最后一条是现在的）：');
    for (const m of moods) lines.push(`  ${shortTime(m.at)}  ${moodLabel(m)}${m.why ? ` —— ${m.why}` : ''}`);
  }
  const changes = Array.isArray(side.tagHistory) ? side.tagHistory : [];
  if (changes.length) {
    lines.push('改过的标签（旧 → 新）：');
    for (const c of changes) {
      lines.push(`  ${shortTime(c.at)}  ${c.field}：${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}${c.why ? ` —— ${c.why}` : ''}`);
    }
  }
  const hint = tagHint(side).replace('，read_memory 看得到', '');   // 已经在 read_memory 里了
  if (hint) lines.push(`（${hint}）`);
  return lines.length ? `\n\n── 标签 ──\n${lines.join('\n')}` : '';
}

async function doTag({ name, about, occurredAt, mood, why }) {
  const n = String(name || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(n) || n.includes('..')) throw new Error(`名字不合法：${name}`);
  // ⚠ 只改自己的。别人的记忆由他自己标 —— 这里绝不写别人的目录
  if (!fs.existsSync(path.join(MEMORY_DIR, `${n}.md`))) {
    throw new Error(`我这边没有这条记忆：${n}（别人的记忆只有他自己能标）`);
  }
  const reason = typeof why === 'string' ? why.trim().slice(0, 200) : '';
  let nextAbout = null;
  if (about !== undefined) {
    nextAbout = [...new Set((Array.isArray(about) ? about : [about]).map((a) => String(a).trim()).filter(Boolean))];
    for (const a of nextAbout) if (!ABOUT_RE.test(a)) throw new Error(`「关于」只能是小写英文短词：${a}`);
  }
  if (occurredAt !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(occurredAt))) {
    throw new Error('occurredAt 要写成 YYYY-MM-DD');
  }
  let moodEntry = null;
  if (mood !== undefined) {
    const m = mood && typeof mood === 'object' ? mood : {};
    if (!STRENGTH_LABEL[m.strength]) throw new Error('心情的 strength 只能是 strong 或 mild');
    if (!DIRECTION_LABEL[m.direction]) throw new Error('心情的 direction 只能是 +、- 或 ±');
    moodEntry = { strength: m.strength, direction: m.direction };
    const word = typeof m.note === 'string' ? m.note.trim().slice(0, 20) : '';
    if (word) moodEntry.note = word;
  }
  if (nextAbout === null && occurredAt === undefined && !moodEntry) {
    throw new Error('什么都没给：about / occurredAt / mood 至少给一个');
  }

  return withEntryLock(MEMORY_DIR, n, () => {
    const side = readSidecar(MEMORY_DIR, n);
    side.tags = side.tags && typeof side.tags === 'object' ? side.tags : {};
    const at = localIso();
    const stamp = (x) => (reason ? { ...x, why: reason } : x);
    const history = Array.isArray(side.tagHistory) ? side.tagHistory : [];
    const changed = [];
    if (nextAbout) {
      const prev = Array.isArray(side.tags.about) ? side.tags.about : [];
      if (JSON.stringify(prev) !== JSON.stringify(nextAbout)) {
        history.push(stamp({ field: 'about', from: prev, to: nextAbout, at, by: WHO }));
        side.tags.about = nextAbout;
        changed.push('关于');
      }
    }
    if (occurredAt !== undefined && (side.occurredAt || null) !== occurredAt) {
      history.push(stamp({ field: 'occurredAt', from: side.occurredAt || null, to: occurredAt, at, by: WHO }));
      side.occurredAt = occurredAt;
      changed.push('日期');
    }
    if (moodEntry) {
      // 心情永远是**追加**：现在的是最后一条，以前的全在前面
      side.moodHistory = [...(Array.isArray(side.moodHistory) ? side.moodHistory : []), stamp({ ...moodEntry, at, by: WHO })];
      changed.push('心情');
    }
    if (!changed.length) return `没有变化：${n} 的标签和现在一样。`;
    if (history.length) side.tagHistory = history;
    atomicWriteJson(path.join(MEMORY_DIR, 'meta', `${n}.json`), side);
    const hint = tagHint(side);
    return `改好了：${n} 的${changed.join('、')}（${shortTime(at)}），旧的都留着。${hint ? `\n${hint}` : ''}`;
  });
}

// ── 工具定义 ──
const ABOUT_CHOICES = [...PARTICIPANTS.participantIds, 'project'].join(' / ');
const TOOLS = [
  {
    name: 'recall_memory',
    description: [
      '按意思召回记忆，只返回摘要（名字 + 一句话描述 + 关于谁），不返回正文。',
      '用在「这件事我以前是不是想过 / 踩过 / 听人说过」的时候。可以的话常翻。',
      '',
      '怎么写：先写一句「我想找什么」（整句，不是关键词）。想找好几件事就拆成几条 intents，每条单独判。',
      '  type: thing = 找讲这件事、或者能解释它的记忆（默认；想找一条教训也用 thing）；',
      '        cause = 找可能导致它的「那件事」（「今天不想说话 —— 前面发生了什么」这种）。',
      '  类型决定判断怎么问：找「那件事」用 cause 准得多；但 cause 对教训类记忆会普遍给高分。拿不准就两种各写一条。',
      `  about: 只在「关于谁」的记忆里找（${ABOUT_CHOICES}）；只给 about 就把那些全列出来。`,
      '  via（一般不用填）：默认 Jev 判断；它挂了自动退到向量、再退到字面匹配。想对比可以写 ["jev","vector"]。',
      '',
      '⚠ 返回的是候选，不是答案。分数是相关的概率，标「低」的不一定相关。看到相关的再调 read_memory 取正文。',
      '⚠ 召回不到不等于没有 —— 换个说法再试，报「没有」之前说清楚找了什么。',
      '⚠ 会把候选记忆的名字和一句话描述发给 Jev（typesafe）和 Google；正文不发。',
      '带「↳」那一行的，是标签改过或标过心情的：旧的都还在，read_memory 能看到全部历史。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '一句话写清楚想找什么。只给这个就当一条意图。' },
        type: { type: 'string', enum: ['thing', 'cause'], description: 'query 的类型：thing 找这件事（默认），cause 找原因。' },
        intents: {
          type: 'array',
          description: `想找好几件事时拆开写，每条单独判断，最多 ${MAX_INTENTS} 条。`,
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '这一条想找什么，一句话。' },
              type: { type: 'string', enum: ['thing', 'cause'] },
              via: { type: 'array', items: { type: 'string', enum: METHODS }, description: '一般不填（默认 Jev）。' },
            },
            required: ['text'],
          },
        },
        about: {
          type: 'array', items: { type: 'string' },
          description: `只在关于这些人 / 事的记忆里找：${ABOUT_CHOICES}。`,
        },
        limit: { type: 'number', description: '最多返回几条，默认 8（只给 about 时默认 20），上限 30。' },
        include_other: { type: 'boolean', description: '是否也搜别的 agent 自己的记忆库，默认 false。关于他们的事先从自己的记忆里找（about）；只有想知道对方当时自己怎么想时才开。' },
      },
    },
  },
  {
    name: 'read_memory',
    description: '按名字读一条记忆的正文。名字从 recall_memory 的结果里拿。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '记忆的名字（不带 .md）。' },
        who: { type: 'string', enum: [WHO, ...OTHERS], description: '这条是谁的，默认是自己的。' },
      },
      required: ['name'],
    },
  },
  {
    name: 'tag_memory',
    description: [
      '给**自己的**一条记忆改标签：关于谁、发生日期、心情。**覆盖不删** —— 旧值和改的时间都留着，',
      '召回时会提示「改过」，read_memory 能看到全部历史。',
      '',
      '心情**不是必填，也不是义务**：想标的时候才标。只记强弱（strong / mild）和方向（+ 正 / - 负 / ± 混），',
      '可以带一两个字的 note，不用具体的情绪名词。回忆起一件事、觉得现在是不一样的心情，就再标一次 ——',
      '以前的都在，召回时能看到各类占多少。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '记忆的名字（不带 .md）。只能是自己的。' },
        about: {
          type: 'array', items: { type: 'string' },
          description: `关于谁，可以好几个：${ABOUT_CHOICES}。给了就整组替换，旧的一组留在历史里。`,
        },
        occurredAt: { type: 'string', description: '发生的那天（不是写下的那天），YYYY-MM-DD。' },
        mood: {
          type: 'object',
          properties: {
            strength: { type: 'string', enum: ['strong', 'mild'] },
            direction: { type: 'string', enum: ['+', '-', '±'] },
            note: { type: 'string', description: '一两个字，可以不写。' },
          },
          required: ['strength', 'direction'],
        },
        why: { type: 'string', description: '为什么改，可以不写。' },
      },
      required: ['name'],
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'recall_memory': return doRecall(args);
    case 'read_memory': return doRead(args);
    case 'tag_memory': return doTag(args);
    default: throw new Error(`没有这个工具：${name}`);
  }
}

// ── 协议 ──
// ⚠ 召回要等网络：stdin 一关就 exit 会把还在路上的回复丢掉 —— 等手上的都回完了再退。
let buf = '';
let inflight = 0;
let stdinEnded = false;
const maybeExit = () => { if (stdinEnded && inflight === 0) process.exit(0); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      inflight += 1;
      handleLine(line).finally(() => { inflight -= 1; maybeExit(); });
    }
  }
});
process.stdin.on('end', () => { stdinEnded = true; maybeExit(); });

async function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { log('收到非 JSON 行，忽略'); return; }
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize':
        replyResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'promise-memory', version: '1.0.0' },
        });
        return;
      case 'notifications/initialized':
      case 'initialized':
        return;
      case 'tools/list':
        replyResult(id, { tools: TOOLS });
        return;
      case 'tools/call': {
        const text = await callTool(params?.name, params?.arguments || {});
        replyResult(id, { content: [{ type: 'text', text }] });
        return;
      }
      case 'ping':
        replyResult(id, {});
        return;
      default:
        if (id !== undefined && id !== null) replyError(id, -32601, `不支持的方法：${method}`);
        return;
    }
  } catch (err) {
    log('处理失败：', err.message);
    if (method === 'tools/call') {
      // ⚠ 工具失败作为**工具结果**回去（isError），不是 JSON-RPC 错误 ——
      //   后者会让客户端以为 server 坏了，而这里只是这一次没查到，可以换个说法重试。
      replyResult(id, { content: [{ type: 'text', text: `失败：${err.message}` }], isError: true });
    } else {
      replyError(id, -32603, err.message);
    }
  }
}

log(`started. who=${WHO} scope=${SCOPE} dir=${MEMORY_DIR} root=${MEMORY_ROOT} semantic=${SEMANTIC_ON ? 'on' : 'off'}`);
