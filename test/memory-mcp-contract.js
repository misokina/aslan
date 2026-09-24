#!/usr/bin/env node
'use strict';

// bin/mcp-memory.js 和 bin/memory-check.js 的契约。零依赖；Jev 和 Gemini 都指到这里起的本地假服务，不往外发。
//
// 钉住的是这些，每一条都是做错过、或者差点做错的：
//   ① 协议层：握手缺字段，客户端会当整个 server 坏了
//   ② 默认只搜自己的；显式 include_other 才带别人的；索引文件不是记忆
//   ③ 场合只提醒、不过滤：inside / outside 召回的东西必须一样，只差一句提醒
//   ④ 名字不能决定路径
//   ⑤ 标签覆盖不删：心情追加、改动留旧值和时间；绝不写别人的目录
//   ⑥ 类型决定判断器怎么问（thing / cause）；有 Jev 就按 Jev 排
//   ⑦ Jev 挂了退到向量，而且要说出来
//   ⑧ about 先筛候选 —— 发出去的候选里都不能有别的；只给 about 不调接口
//   ⑨ key 只发去该去的地方，回复里不出现；关掉之后一个请求都不发
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'bin', 'mcp-memory.js');
const groups = [];
const group = (name, fn) => groups.push([name, fn]);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-memory-mcp-'));
const configDir = path.join(tmp, 'config');
const memoryRoot = path.join(tmp, 'memory');
const mine = path.join(memoryRoot, 'dawn');
const theirs = path.join(memoryRoot, 'lumen');
for (const d of [configDir, path.join(mine, 'meta'), theirs]) fs.mkdirSync(d, { recursive: true });

function note(dir, name, desc, about) {
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${desc}\n---\n\nBODY_OF_${name}\n`, 'utf8');
  if (about) fs.writeFileSync(path.join(dir, 'meta', `${name}.json`), JSON.stringify({ tags: { about } }), 'utf8');
}
note(mine, 'thing-note', 'thing-note 讲的就是这件事 widget', ['owner']);
note(mine, 'cause-note', 'cause-note 是那个情况的原因', ['project']);
note(mine, 'vec-note', 'vec-note 只有向量认得出', ['lumen']);
note(mine, 'plain-note', 'plain-note 普通的一条', null);
note(theirs, 'their-note', 'their-note 另一个人关于 widget 的一条', null);
fs.writeFileSync(path.join(theirs, 'INDEX.md'), '# 索引\n\n`their-note | …`\n', 'utf8');

// 假服务：Jev 按问法打分（问因果 → cause-note 高；问「值不值得看」→ thing-note 高）；向量只认 vec-note
const seen = [];
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/jev') {
      seen.push({ kind: 'jev', auth: req.headers.authorization, body });
      if (/FAIL_JEV/.test(body.state)) return reply(500, { detail: 'boom' });
      const lines = body.state.split('\n').filter((l) => /^\[\d+\] /.test(l));
      const answers = {};
      for (const [qid, q] of Object.entries(body.questions)) {
        const line = lines[Number(qid.split('_')[1])] || '';
        const causal = /可能原因/.test(q.instructions);
        let p = 0.1;
        if (causal && /cause-note/.test(line)) p = 0.95;
        if (!causal && /thing-note/.test(line)) p = 0.9;
        answers[qid] = { noul: p };
      }
      return reply(200, { answers, usage: { input_tokens: 1 } });
    }
    if (req.url.endsWith(':batchEmbedContents')) {
      seen.push({ kind: 'embed', auth: req.headers['x-goog-api-key'], body });
      return reply(200, { embeddings: body.requests.map((r) => ({
        values: /vec-note|FAIL_JEV/.test(r.content.parts[0].text) ? [1, 0] : [0, 1],
      })) });
    }
    return reply(404, {});
  });
});

function baseEnv(extra = {}) {
  const env = { ...process.env };
  // 不许从外面继承 key 或 key 文件 —— 测试绝不能读到真 key
  for (const k of ['JEV_API_KEY', 'TYPESAFE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'JEV_API_KEY_FILE', 'GEMINI_API_KEY_FILE', 'ASLAN_MEMORY_KEY_FILES', 'ASLAN_MEMORY_DIR']) delete env[k];
  return {
    ...env,
    ASLAN_CONFIG_DIR: configDir,
    ASLAN_DATA_DIR: tmp,
    ASLAN_SHARED_MEMORY_DIR: memoryRoot,
    ASLAN_MEMORY_WHO: 'dawn',
    ASLAN_MEMORY_SCOPE: 'inside',
    ASLAN_MEMORY_SEMANTIC: 'off',
    ASLAN_MEMORY_PROXY: 'none',
    ...extra,
  };
}

// 起一个 mcp-memory，把请求全写进去、关 stdin，收齐回复（它会等手上的都回完再退）
function mcp(requests, env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const out = new Map();
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) { const m = JSON.parse(line); if (m.id !== undefined) out.set(m.id, m); }
      }
    });
    proc.on('close', () => resolve(out));
    proc.stdin.end(`${[{ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }, ...requests]
      .map((x) => JSON.stringify(x)).join('\n')}\n`);
  });
}
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const text = (out, id) => out.get(id)?.result?.content?.[0]?.text || '';
const names = (s) => (s.match(/^\d+\. \[\w+\] ([\w-]+)/gm) || []).sort().join(',');
const first = (s) => (s.match(/^1\. \[\w+\] ([\w-]+)/m) || [])[1];
const semanticEnv = (port, extra = {}) => baseEnv({
  ASLAN_MEMORY_SEMANTIC: 'on',
  ASLAN_MEMORY_HTTP_TIMEOUT_MS: '5000',
  ASLAN_JEV_URL: `http://127.0.0.1:${port}/jev`,
  ASLAN_GEMINI_BASE: `http://127.0.0.1:${port}/gemini`,
  JEV_API_KEY: 'test-jev-key',
  GEMINI_API_KEY: 'test-gem-key',
  ...extra,
});
async function run(args, env) {
  const before = seen.length;
  const out = await mcp([call(1, 'recall_memory', args)], env);
  return { text: text(out, 1), reqs: seen.slice(before) };
}
const jevReqs = (reqs) => reqs.filter((r) => r.kind === 'jev');
const states = (reqs) => jevReqs(reqs).map((r) => r.body.state).join('\n');
const instructions = (reqs) => jevReqs(reqs).flatMap((r) => Object.values(r.body.questions).map((q) => q.instructions));

group('protocol', async () => {
  const out = await mcp([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], baseEnv());
  const init = out.get(0)?.result;
  assert.ok(init?.serverInfo?.name && init?.protocolVersion && init?.capabilities?.tools, 'initialize 缺字段，客户端会当 server 坏了');
  const tools = (out.get(1)?.result?.tools || []).map((t) => t.name).sort().join(',');
  assert.equal(tools, 'read_memory,recall_memory,tag_memory');
});

group('own-only by default, scope reminds but never filters', async () => {
  const reqs = [
    call(1, 'recall_memory', { query: 'widget' }),
    call(2, 'recall_memory', { query: 'widget', include_other: true }),
    call(3, 'read_memory', { name: 'thing-note' }),
    call(4, 'read_memory', { name: '../../etc/passwd' }),
    call(5, 'read_memory', { name: 'their-note', who: 'lumen' }),
  ];
  const inside = await mcp(reqs, baseEnv());
  const outside = await mcp(reqs, baseEnv({ ASLAN_MEMORY_SCOPE: 'outside' }));
  assert.ok(/thing-note/.test(text(inside, 1)) && !/their-note/.test(text(inside, 1)),
    "默认只搜自己的 —— 别人的库要显式 include_other");
  assert.ok(/\[lumen\] their-note/.test(text(inside, 2)), 'include_other: true 要能搜到别人的库');
  assert.ok(!/BODY_OF/.test(text(inside, 1)), '召回只回摘要，正文要另调 read_memory');
  assert.ok(/BODY_OF_thing-note/.test(text(inside, 3)), 'read_memory 要回正文');
  assert.ok(/BODY_OF_their-note/.test(text(inside, 5)), '互相可读：显式指明 who 就能读别人的');
  assert.equal(names(text(inside, 1)), names(text(outside, 1)), '场合只是提醒，不是过滤 —— 里外召回必须一样');
  assert.ok(/注意往外说多少/.test(text(outside, 1)) && /注意往外说多少/.test(text(outside, 3)), '外面：召回和读正文都要带提醒');
  assert.ok(!/注意往外说多少/.test(text(inside, 1)), '里面不带提醒，否则提醒就不再有意义');
  const traversal = inside.get(4)?.result;
  assert.ok(traversal?.isError && /不合法/.test(traversal.content[0].text), '名字不能决定路径');
});

group('tags overwrite, never delete, never touch others', async () => {
  const out = await mcp([
    call(1, 'tag_memory', { name: 'plain-note', mood: { strength: 'strong', direction: '-', note: '怕' } }),
    call(2, 'tag_memory', { name: 'plain-note', mood: { strength: 'mild', direction: '+' }, why: '回头看没那么可怕' }),
    call(3, 'tag_memory', { name: 'plain-note', about: ['owner'] }),
    // ⚠ 别在这里给它标 lumen —— 后面「关于谁先筛」那组要靠 lumen 只筛出 vec-note（第一版就是这样撞上的）
    call(4, 'tag_memory', { name: 'plain-note', about: ['owner', 'project'] }),
    call(5, 'tag_memory', { name: 'their-note', mood: { strength: 'strong', direction: '+' } }),
    call(6, 'tag_memory', { name: 'plain-note', mood: { strength: 'strong', direction: 'sad' } }),
  ], baseEnv());
  // ⚠ 请求是并发处理的，心情的先后看写进去的时间，这里只核内容
  const side = JSON.parse(fs.readFileSync(path.join(mine, 'meta', 'plain-note.json'), 'utf8'));
  assert.equal(side.moodHistory.length, 2, '心情永远是追加：强烈的怕要留在后来的平静底下');
  assert.deepEqual(side.moodHistory.map((m) => m.direction).sort(), ['+', '-']);
  assert.ok(side.moodHistory.every((m) => /[+-]\d\d:\d\d$/.test(m.at)), '时间带本地偏移，深夜改的不会落到前一天');
  assert.ok(Array.isArray(side.tagHistory) && side.tagHistory.some((c) => c.field === 'about'), '改「关于」要留旧值和时间');
  assert.ok(out.get(5)?.result?.isError && /只有他自己能标/.test(text(out, 5)), '别人的记忆由他自己标');
  assert.ok(out.get(6)?.result?.isError, '方向只能是 + / - / ±');
  assert.ok(!fs.existsSync(path.join(theirs, 'meta')), '绝不写别人的目录');
  assert.ok(!fs.readdirSync(path.join(mine, 'meta')).some((f) => f.endsWith('.lock') || f.endsWith('.tmp')), '不留锁和临时文件');
  const after = await mcp([call(1, 'recall_memory', { query: 'plain-note' }), call(2, 'read_memory', { name: 'plain-note' })], baseEnv());
  assert.ok(/↳ .*改过/.test(text(after, 1)), '改过的要在召回时说「底下还有」');
  assert.ok(/── 标签 ──/.test(text(after, 2)) && /回头看没那么可怕/.test(text(after, 2)), 'read_memory 要回全部历史');
});

group('type decides how Jev is asked; Jev leads the order', async () => {
  const port = fake.address().port;
  const thing = await run({ query: '随便找找' }, semanticEnv(port));
  assert.equal(first(thing.text), 'thing-note');
  assert.ok(instructions(thing.reqs).length && instructions(thing.reqs).every((s) => /值不值得拿出来看/.test(s) && !/可能原因/.test(s)),
    'thing 问「值不值得拿出来看」，不能混进因果问法');
  assert.ok(!thing.reqs.some((r) => r.kind === 'embed'), '默认只交给 Jev，Jev 回来了就不调向量');
  assert.ok(jevReqs(thing.reqs).every((r) => r.auth === 'Bearer test-jev-key'), 'Jev 的 key 只发给 Jev');
  assert.ok(!/their-note|INDEX/.test(states(thing.reqs)), '默认连发都不发别人的记忆；索引文件不是记忆');
  const cause = await run({ intents: [{ text: '为什么会那样', type: 'cause' }] }, semanticEnv(port));
  assert.equal(first(cause.text), 'cause-note', '同一个判断器，问法对了才找得到原因');
  assert.ok(instructions(cause.reqs).every((s) => /可能原因/.test(s)), 'cause 问「是不是一个可能原因」');
});

group('about filters first; about-only calls nothing', async () => {
  const port = fake.address().port;
  const filtered = await run({ query: '随便找找', about: ['lumen'] }, semanticEnv(port));
  assert.ok(/vec-note/.test(states(filtered.reqs)) && !/thing-note|cause-note|plain-note/.test(states(filtered.reqs)),
    '「关于谁」要在发给判断器之前就筛掉');
  const only = await run({ about: ['owner'] }, semanticEnv(port));
  assert.equal(only.reqs.length, 0, '只给 about 是标签筛选，不调任何接口');
  assert.ok(/thing-note/.test(only.text) && !/cause-note|vec-note/.test(only.text));
});

group('fallback is said out loud; keys never leak; off sends nothing', async () => {
  const port = fake.address().port;
  const fallback = await run({ query: 'FAIL_JEV 找东西' }, semanticEnv(port));
  assert.ok(jevReqs(fallback.reqs).length >= 1 && fallback.reqs.some((r) => r.kind === 'embed'), 'Jev 挂了要退到向量');
  assert.equal(first(fallback.text), 'vec-note', '退了之后按向量排');
  assert.ok(/Jev这次没回来/.test(fallback.text) && /改用向量/.test(fallback.text), '退路要说出来，不能悄悄换');
  assert.ok(fallback.reqs.filter((r) => r.kind === 'embed').every((r) => r.auth === 'test-gem-key'), 'Gemini 的 key 只发给 Gemini');
  assert.ok(!/test-jev-key|test-gem-key/.test(fallback.text), '回复里绝不能出现 key');
  const off = await run({ query: 'plain-note' }, semanticEnv(port, { ASLAN_MEMORY_SEMANTIC: 'off' }));
  assert.equal(off.reqs.length, 0, '关掉之后一个请求都不发');
  assert.ok(first(off.text) === 'plain-note' && /只按字面匹配/.test(off.text), '关掉也照样按字面召回，并说明');
});

group('memory-check dry run', async () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'memory-check.js'), '--dry'], {
    env: baseEnv(), encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.ok(/dawn 4/.test(r.stdout) && /lumen 1/.test(r.stdout), `要按参与者分别数：${r.stdout}`);
  assert.ok(/要比 10 对/.test(r.stdout) && /没有调 API/.test(r.stdout), '--dry 只算对数，不调接口');
});

(async () => {
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  try {
    for (const [name, fn] of groups) {
      try { await fn(); } catch (err) { err.message = `${name}: ${err.message}`; throw err; }
    }
  } finally {
    fake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`Memory MCP contract checks passed (${groups.length} groups): protocol, own-only, scope, tags, typed questions, about, fallback, dry check.`);
})().catch((err) => { console.error(err); process.exit(1); });
