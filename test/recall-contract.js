#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function importProbe() {
  const saved = {
    read: fs.readFileSync, list: fs.readdirSync, write: fs.writeFileSync,
    stdout: process.stdout.write, stderr: process.stderr.write, argv: process.argv,
  };
  const forbidden = () => { throw new Error('Import performed data I/O or wrote output'); };
  try {
    fs.readFileSync = function (file, ...args) {
      const name = String(file);
      if (!name.endsWith('.js') && path.basename(name) !== 'package.json') forbidden();
      return saved.read.call(this, file, ...args);
    };
    fs.readdirSync = forbidden;
    fs.writeFileSync = forbidden;
    process.stdout.write = forbidden;
    process.stderr.write = forbidden;
    process.argv = [process.execPath, 'import-probe', '--json', 'needle'];
    const library = require('../lib');
    assert.equal(library.recall, require('../lib/recall'));
    assert.equal(typeof library.recall.rankMemories, 'function');
    assert.equal(typeof require('../bin/recall').main, 'function');
  } finally {
    fs.readFileSync = saved.read;
    fs.readdirSync = saved.list;
    fs.writeFileSync = saved.write;
    process.stdout.write = saved.stdout;
    process.stderr.write = saved.stderr;
    process.argv = saved.argv;
  }
}

function main() {
  const { splitQuery, scoreMemory, rankMemories } = require('../lib/recall');
  const today = Object.freeze({ year: 2026, month: 9, day: 10 });
  const memory = (id, extra = {}) => ({
    id, name: id, description: '', kind: 'chat', strength: 0,
    lastRecalled: null, occurredAt: null, topics: [], place: '', mood: {}, ...extra,
  });
  let passed = 0;
  const test = (name, fn) => {
    try { fn(); passed += 1; }
    catch (error) { error.message = `${name}: ${error.message}`; throw error; }
  };

  test('query normalization and deduplication', () => {
    assert.deepEqual(splitQuery(' ＡＩ，ai;tag tag；安全、API,api'), ['ai', 'ai;tag', 'tag', '安全', 'api']);
    assert.deepEqual(splitQuery(''), []);
    assert.deepEqual(splitQuery('ＡＩ ai，安全、API api'), ['ai', '安全', 'api']);
  });
  test('scoring contributions remain unchanged', () => {
    const item = memory('one', { description: 'API guide', topics: ['ＡＰＩ'], strength: 9, lastRecalled: '2026-09-10' });
    const result = scoreMemory(item, splitQuery('api other'), today);
    assert.equal(result.relevance, 1.5);
    assert.equal(result.rawScore, 3.3);
    assert.deepEqual(result.why.contributions, { topic: 1, literal: 0.5, recency: 1, strength: 0.8 });
    assert.equal(result.why.strengthRatio, 1);
  });
  test('recency decay distinguishes fact and chat; promises retain weight', () => {
    const old = { lastRecalled: '2026-08-11' };
    assert.equal(scoreMemory(memory('chat', old), [], today).why.recency, Math.exp(-1));
    assert.equal(scoreMemory(memory('fact', { ...old, kind: 'fact' }), [], today).why.recency, Math.exp(-30 / 90));
    assert.equal(scoreMemory(memory('promise', { kind: 'promise' }), [], today).why.recency, 1);
    assert.equal(scoreMemory(memory('future', { lastRecalled: '2026-09-11' }), [], today).why.deltaDays, 0);
    assert.equal(scoreMemory(memory('invalid', { lastRecalled: 'not-a-date' }), [], today).why.deltaDays, null);
  });
  test('strength alone cannot make an unrelated memory relevant', () => {
    const records = [memory('unrelated', { strength: 5, kind: 'promise' }), memory('match', { topics: ['query'] })];
    assert.deepEqual(rankMemories(records, ['query'], today).map((m) => m.id), ['match']);
  });
  test('related lane has a stable tie break and a cap of eight', () => {
    const records = Array.from({ length: 10 }, (_, i) => memory(`m${9 - i}`, { topics: ['query'] }));
    const ranked = rankMemories(records, ['query'], today);
    assert.deepEqual(ranked.map((m) => m.id), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    assert.ok(ranked.every((m) => m.lane === 'related' && m.score === 1));
  });
  test('related scores are normalized against the selected maximum', () => {
    const result = rankMemories([memory('weak', { topics: ['q'] }), memory('strong', { topics: ['q'], strength: 5 })], ['q'], today);
    assert.equal(result[0].id, 'strong');
    assert.equal(result[0].score, 1);
    assert.equal(result[1].score, 2 / 2.8);
  });
  test('associations are separate, capped, and do not duplicate related entries', () => {
    const records = [
      memory('related', { topics: ['park'], place: 'park', occurredAt: '2025-09-10' }),
      memory('both', { place: 'park', occurredAt: '2024-09-10' }),
      memory('recent', { occurredAt: '2025-09-10' }),
      memory('older', { occurredAt: '2023-09-10' }),
    ];
    const ranked = rankMemories(records, ['park'], today);
    assert.deepEqual(ranked.map((m) => m.id), ['related', 'both', 'recent']);
    assert.deepEqual(ranked.map((m) => m.lane), ['related', 'association', 'association']);
    assert.equal(ranked[1].score, 2, 'association counts are not normalized related scores');
  });
  test('empty query may still return date associations, not arbitrary memories', () => {
    const ranked = rankMemories([memory('date', { occurredAt: '2020-09-10' }), memory('other')], [], today);
    assert.deepEqual(ranked.map((m) => m.id), ['date']);
    assert.equal(ranked[0].lane, 'association');
    assert.deepEqual(rankMemories([], [], today), []);
  });
  test('ranking does not mutate supplied records, query or date', () => {
    const record = Object.freeze(memory('frozen', { topics: Object.freeze(['q']) }));
    const records = Object.freeze([record]);
    const query = Object.freeze(['q']);
    const before = JSON.stringify({ records, query, today });
    rankMemories(records, query, today);
    assert.equal(JSON.stringify({ records, query, today }), before);
  });
  test('root, ranking module and CLI imports are inert in a fresh process', () => {
    const result = spawnSync(process.execPath, [__filename, '--import-probe'], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  const tempBase = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempBase, 'promise-recall-'));
  try {
    const body = '---\nname: memo\ndescription: searchable summary\n---\nPRIVATE_TEST_BODY_NOT_FOR_OUTPUT\n';
    fs.writeFileSync(path.join(root, 'memo.md'), body);
    const cli = (...args) => {
      const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'recall.js'), ...args], {
        encoding: 'utf8', windowsHide: true, timeout: 10_000,
        env: { ...process.env, ASLAN_MEMORY_DIR: root },
      });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      assert.equal(result.stderr, '');
      return result.stdout;
    };
    test('CLI JSON remains metadata-only and includes explanation on request', () => {
      const raw = cli('--dir', root, '--json', '--why', 'searchable');
      assert.ok(!raw.includes('PRIVATE_TEST_BODY_NOT_FOR_OUTPUT'));
      const [item] = JSON.parse(raw);
      assert.equal(item.name, 'memo');
      assert.equal(item.score, 1);
      assert.equal(item.why.rawScore, 0.5);
      assert.equal(item.why.normalizationMax, 0.5);
      assert.equal(item.why.literalHit, true);
    });
    test('human and empty-query CLI behavior is preserved', () => {
      const text = cli('--dir', root, 'searchable');
      assert.ok(text.includes('searchable summary'));
      assert.ok(!text.includes('PRIVATE_TEST_BODY_NOT_FOR_OUTPUT'));
      assert.deepEqual(JSON.parse(cli('--dir', root, '--json')), []);
      assert.ok(cli('--help').includes('node bin/recall.js'));
    });
    test('CLI env fallback reads the selected library without writes', () => {
      assert.equal(JSON.parse(cli('--json', 'searchable'))[0].name, 'memo');
      assert.deepEqual(fs.readdirSync(root), ['memo.md']);
      assert.equal(fs.readFileSync(path.join(root, 'memo.md'), 'utf8'), body);
    });
  } finally {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), tempBase);
    assert.ok(path.basename(resolved).startsWith('promise-recall-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  console.log(`Recall contract checks passed (${passed} groups): ranking, inert imports, CLI compatibility, read-only metadata output.`);
}

if (process.argv[2] === '--import-probe') importProbe();
else main();
