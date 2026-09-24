#!/usr/bin/env node
'use strict';
/**
 * 记忆库体检 —— 找出该合并的、两边都记了的、该标过期的、该互相链接的，和拿不准要人看的。
 *
 * ⚠ 跨人重合不算冗余：两个 agent 对同一件事各有一份理解是正常的，该互相链接，不该合并。
 *   合并只在**同一个人自己写重了**时才提。别人的文件一律只提醒，不替他改。
 *
 *   node bin/memory-check.js                    全量两两比
 *   node bin/memory-check.js --new <路径.md>     只比这一条和其余所有（写完一条新记忆时用）
 *   node bin/memory-check.js --out pairs.tsv    全部结果落盘
 *   node bin/memory-check.js --dry              不调 API，只列出会比多少对
 *
 * 判断交给 TypeSafe 的 Jev（只出校准概率、不出文本；几十条记忆全量两两比，一次约两美分）。
 * key：JEV_API_KEY，或 JEV_API_KEY_FILE 指向的文件，或 ASLAN_MEMORY_KEY_FILES 里的 .env 文件。没有就退出，不影响别的功能。
 * 记忆目录：每个 agent 一个子目录 <ASLAN_SHARED_MEMORY_DIR 或 ASLAN_DATA_DIR/memory>/<id>，参与者读 config/group.json。
 *
 * ⚠ 两个阈值是实测来的：
 *   >0.7   自动带结论。阳性对照里真矛盾全 ≥0.88、假矛盾全 ≤0.22，中间是空的
 *   0.3–0.7 拿不准，交给人
 * ⚠ 分数落在不确定带，多半不是模型笨，是那两条本身没把关系写清楚 —— 该改写法，不是调阈值。
 *   （同一件事写成「旧的已退役、现在改成 X」，而不是并列写两个值，「这是取代关系」的置信度从 0.56 跳到 0.96。）
 * ⚠ 返回的是**概率**，不是布尔值。拿 `=== true` 去比会全判错。
 */

const fs = require('fs');
const path = require('path');
const { DEFAULT_MEMORY_DIR } = require('../lib/memory-metadata');
const { getParticipantConfig } = require('../lib/participant-config');

const URL = process.env.ASLAN_JEV_URL || `${process.env.TYPESAFE_API_BASE || 'https://api.typesafe.ai'}/v1/systemone`;
const PER_BATCH = 8;
const CONC = 4;
const BAND = [0.3, 0.7];
const PRICE_PER_MTOK = 0.042;

function readTextFile(p) {
  try {
    const b = fs.readFileSync(p);
    if (b[0] === 0xff && b[1] === 0xfe) return b.toString('utf16le');   // PowerShell 的 `>` 写的是 UTF-16LE
    return b.toString('utf8');
  } catch { return ''; }
}
function readKey() {
  for (const n of ['JEV_API_KEY', 'TYPESAFE_API_KEY']) if (process.env[n]) return process.env[n];
  if (process.env.JEV_API_KEY_FILE) {
    const line = readTextFile(process.env.JEV_API_KEY_FILE).replace(/^﻿/, '').split(/\r?\n/)
      .map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (line) return (line.includes('=') ? line.slice(line.indexOf('=') + 1) : line).trim().replace(/^["']|["']$/g, '');
  }
  for (const f of (process.env.ASLAN_MEMORY_KEY_FILES || '').split(path.delimiter).filter(Boolean)) {
    for (const line of readTextFile(f).replace(/^﻿/, '').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:JEV_API_KEY|TYPESAFE_API_KEY)\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

// 比较单元是 frontmatter 的 description（一条记忆一个命题），不是正文
function loadDir(dir, who) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    if (f === 'INDEX.md' || f === 'MEMORY.md') continue;
    const full = path.join(dir, f);
    const m = readTextFile(full).match(/^description:\s*(.+?)\s*$/m);
    if (!m) continue;
    out.push({ name: path.basename(f, '.md'), who, file: full, desc: m[1].slice(0, 300) });
  }
  return out;
}

// 重复和矛盾是两个独立判断，一条可以同时是两者（语义相同但被取代）。
// 这两段判断标准改写自 Graphiti（graphiti_core/prompts/dedupe_edges.py）的去重 / 失效判断。
function buildQuestions(others) {
  const q = {};
  others.forEach((_, i) => {
    q[`dup_${i}`] = {
      type: 'noul',
      instructions: `记忆 [${i}] 和 TARGET 说的是不是同一件事。`,
      criteria: {
        true: '两条记录的是同一个结论或同一件事，留一条就够。',
        false: '两条有关键差异，或说的是不同的事。相关但不同不算重复。',
      },
    };
    q[`con_${i}`] = {
      type: 'noul',
      instructions: `TARGET 是否推翻了记忆 [${i}]，使它不再成立。`,
      criteria: {
        true: 'TARGET 让那条记忆不再为真，或取代了它（同一件事有了新结论、机制变了、数值改了）。',
        false: '那条记忆仍然成立。角度不同、范围不同、互相补充的都不算推翻。',
      },
    };
    // 第三问：**相关不等于相似**。「重复」问的是同不同，这条问的是有没有关系 ——
    // 不问的话，「同一个毛病的两个变体」「一个导致另一个」这一整类永远浮不上来。
    q[`rel_${i}`] = {
      type: 'noul',
      instructions: `记忆 [${i}] 和 TARGET 之间有没有真实的关联 —— 同一个毛病的不同变体、一个导致另一个、或者同一个主题的两面。`,
      criteria: {
        true: '两条讲的是同一类事，放在一起看比分开看更清楚。即使结论不同、说的不是同一件事也算。',
        false: '只是用词或领域碰巧接近，放在一起并不互相说明。',
      },
    };
  });
  return q;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠ 一定要重试，而且失败的要记下**具体是哪些对**：只留一个「失败 N 批」的计数的话，
//   漏掉的和判过没问题的长得一模一样。
async function askBatch(key, target, others, tries = 3) {
  const lines = others.map((o, i) => `[${i}] ${o.desc}`);
  let last;
  for (let t = 0; t < tries; t++) {
    if (t) await sleep(400 * 2 ** (t - 1));
    try {
      const res = await fetch(URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'jev-latest',
          state: `<TARGET>\n${target.desc}\n</TARGET>\n\n<其它记忆>\n${lines.join('\n')}\n</其它记忆>`,
          questions: buildQuestions(others),
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        last = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw last; // 请求本身不对，重试没用
        continue;
      }
      return JSON.parse(text);
    } catch (e) {
      last = e;
      if (/HTTP 4(?!29)/.test(String(e.message))) throw e;
    }
  }
  throw last;
}

function prob(a) {
  const v = a == null ? null : (a.noul ?? a.probability ?? a.value ?? a.answer);
  return typeof v === 'number' ? v : null;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const newFile = arg('--new', null);
  const outFile = arg('--out', null);

  const root = process.env.ASLAN_SHARED_MEMORY_DIR || DEFAULT_MEMORY_DIR;
  const items = getParticipantConfig().agentIds.flatMap((id) => loadDir(path.join(root, id), id));
  if (items.length < 2) {
    console.log(`只找到 ${items.length} 条记忆，没得比。`);
    return;
  }

  // 要比的配对：给了 --new 就只比那一条，否则全量两两
  const batches = [];
  let pairCount = 0;
  if (newFile) {
    const abs = path.resolve(newFile);
    const target = items.find((x) => path.resolve(x.file) === abs)
      || loadDir(path.dirname(abs), 'new').find((x) => path.resolve(x.file) === abs);
    if (!target) { console.error(`读不到 ${newFile} 的 description`); process.exit(1); }
    const others = items.filter((x) => path.resolve(x.file) !== abs);
    for (let s = 0; s < others.length; s += PER_BATCH) batches.push({ target, others: others.slice(s, s + PER_BATCH) });
    pairCount = others.length;
  } else {
    for (let j = 1; j < items.length; j++) {
      for (let s = 0; s < j; s += PER_BATCH) {
        batches.push({ target: items[j], others: items.slice(s, Math.min(s + PER_BATCH, j)) });
      }
    }
    pairCount = (items.length * (items.length - 1)) / 2;
  }

  const byWho = {};
  for (const x of items) byWho[x.who] = (byWho[x.who] || 0) + 1;
  console.log(`${items.length} 条记忆（${Object.entries(byWho).map(([w, n]) => `${w} ${n}`).join(' / ')}）`);
  console.log(`要比 ${pairCount} 对，分 ${batches.length} 批，约 $${(pairCount * 302 / 1e6 * PRICE_PER_MTOK).toFixed(4)}`);
  if (dry) { console.log('\n--dry，没有调 API。'); return; }

  const key = readKey();
  if (!key) {
    console.log('\n没找到 Jev 的 key（JEV_API_KEY / JEV_API_KEY_FILE / ASLAN_MEMORY_KEY_FILES）。');
    process.exit(1);
  }

  const merge = [], echo = [], stale = [], remind = [], linkable = [], unsure = [], all = [], missed = [];
  let inTok = 0;
  for (let i = 0; i < batches.length; i += CONC) {
    const rs = await Promise.all(batches.slice(i, i + CONC).map((b) =>
      askBatch(key, b.target, b.others).then((r) => ({ b, r })).catch((e) => ({ b, e }))));
    for (const { b, r, e } of rs) {
      if (e) { b.others.forEach((o) => missed.push({ a: o, b: b.target, why: e.message })); continue; }
      inTok += r.usage?.input_tokens || 0;
      b.others.forEach((o, k) => {
        const rec = {
          a: o, b: b.target,
          d: prob(r.answers?.[`dup_${k}`]) ?? 0,
          c: prob(r.answers?.[`con_${k}`]) ?? 0,
          r: prob(r.answers?.[`rel_${k}`]) ?? 0,
          same: o.who === b.target.who,
        };
        all.push(rec);
        if (rec.d > BAND[1]) (rec.same ? merge : echo).push(rec);
        else if (rec.c > BAND[1]) (rec.same ? stale : remind).push(rec);
        else if (rec.r > BAND[1]) linkable.push(rec);   // 不重复不矛盾、但确实相关 —— 该互相链接
        else if (Math.max(rec.d, rec.c, rec.r) >= BAND[0]) unsure.push(rec);
      });
    }
    process.stdout.write(`\r  ${Math.min(i + CONC, batches.length)}/${batches.length} 批`);
  }
  console.log('\n');

  const show = (r) => `  重${r.d.toFixed(2)} 翻${r.c.toFixed(2)} 关${r.r.toFixed(2)}  ${r.a.name} [${r.a.who}]\n                      ↔  ${r.b.name} [${r.b.who}]`;
  const section = (title, list, hint) => {
    console.log(`══ ${title}：${list.length} 对 ══`);
    if (!list.length) console.log('  （没有）');
    else { list.forEach((r) => console.log(show(r))); if (hint) console.log(`  → ${hint}`); }
    console.log('');
  };
  section(`该合并（同一个人写重了，重复 >${BAND[1]}）`, merge, '留一条，另一条的独有内容并进去');
  section(`两边都记了（跨人重合 >${BAND[1]}）`, echo, '⚠ 不要合 —— 各留各的，在正文里互相 [[链接]]');
  section(`可能过期（自己的旧条目被推翻 >${BAND[1]}）`, stale, '旧那条该标明被谁取代，别只删');
  section(`该提醒对方（跨人推翻 >${BAND[1]}）`, remind, '⚠ 别替对方改 —— 那是他的文件。告诉他，让他自己定');
  section(`该互相链接（不重复不矛盾、但相关 >${BAND[1]}）`, linkable,
    '各留各的，在正文里互相 [[链接]]。⚠ 相似不传递（A–B、A–C 高，B–C 不一定高），围着一个核心挂成星形，不是连成链');
  section(`拿不准（${BAND[0]}–${BAND[1]}）`, unsure, '要人看一眼。分数卡在这儿多半是那两条没把关系写清楚');

  if (outFile) {
    all.sort((x, y) => Math.max(y.d, y.c) - Math.max(x.d, x.c));
    fs.writeFileSync(path.resolve(outFile),
      ['dup\tcon\trel\t条目A\t谁\t条目B\t谁',
        ...all.map((r) => `${r.d.toFixed(3)}\t${r.c.toFixed(3)}\t${r.r.toFixed(3)}\t${r.a.name}\t${r.a.who}\t${r.b.name}\t${r.b.who}`)].join('\n'),
      'utf8');
    console.log(`全部 ${all.length} 对已写进 ${outFile}`);
  }
  if (missed.length) {
    console.log(`⚠ 有 ${missed.length} 对**没比过**（重试 3 次仍失败）—— 这些不是「没问题」，是没看过：`);
    for (const m of missed.slice(0, 10)) console.log(`  ${m.a.name} ↔ ${m.b.name}`);
    if (missed.length > 10) console.log(`  …… 还有 ${missed.length - 10} 对`);
    console.log(`  第一条失败原因：${missed[0].why}\n`);
  }
  console.log(`── 比过 ${all.length} 对，漏 ${missed.length} 对 ── ${inTok} tokens · 约 $${(inTok / 1e6 * PRICE_PER_MTOK).toFixed(4)}`);
  if (missed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
