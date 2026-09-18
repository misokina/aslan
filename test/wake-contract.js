#!/usr/bin/env node
'use strict';

// 唤醒的断言。大部分是纯函数；读写 agenda 的那几条用临时目录，不碰任何真实数据。
//
// ⚠ 唤醒是**最没人看着的时候才发生**的功能：出了错，没有人会当场发现。
//   所以这里钉得比别处细一些 —— 尤其是「不该响的时候不响」那几条。

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wake = require('../lib/wake');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`\n✗ ${name}\n  ${err.message}\n`);
    process.exitCode = 1;
  }
}

// ── 抖动 ──────────────────────────────────────────────────────────

// ⚠ 从 id 哈希派生，不是随机数。用随机数的话，同一条待办每次重启都挪到新时刻 ——
//   于是它可能提前响，也可能响两次。这条断言就是拦住「顺手换成 Math.random」的。
test('抖动从 id 派生，重启后不变', () => {
  assert.equal(wake.wakeJitterMs('h1'), wake.wakeJitterMs('h1'), '同一个 id 必须永远算出同一个偏移');
  assert.notEqual(wake.wakeJitterMs('h1'), wake.wakeJitterMs('h2'), '不同 id 该分散开');
});

test('抖动落在 60–600 秒之间', () => {
  for (const id of ['a', 'b', 'zzz', '闹钟', '1', '', 'x'.repeat(50)]) {
    const ms = wake.wakeJitterMs(id);
    assert.ok(ms >= 60000 && ms <= 600000, `${JSON.stringify(id)} 的偏移 ${ms}ms 越界了`);
  }
});

// ── 触发时刻 ──────────────────────────────────────────────────────

test('按本地时间算，并且带上抖动', () => {
  const item = { id: 'h1', date: '2026-09-10', time: '09:00' };
  const base = Date.parse('2026-09-10T09:00:00');   // 不带时区 = 本地时间
  assert.equal(wake.wakeFireTime(item), base + wake.wakeJitterMs('h1'));
});

test('不写时间默认早上九点', () => {
  const at = wake.wakeFireTime({ id: 'h1', date: '2026-09-10' });
  assert.equal(at, Date.parse('2026-09-10T09:00:00') + wake.wakeJitterMs('h1'));
});

test('日期不合法就返回 NaN，不猜一个时刻出来', () => {
  assert.ok(Number.isNaN(wake.wakeFireTime({ id: 'h1', date: '不是日期' })));
  assert.ok(Number.isNaN(wake.wakeFireTime({ id: 'h1' })));
  assert.ok(Number.isNaN(wake.wakeFireTime(null)));
});

// ── 终态 ──────────────────────────────────────────────────────────

test('三种终态都认得出来', () => {
  assert.equal(wake.isWakeTerminal({ wakeState: 'delivered' }), true);
  assert.equal(wake.isWakeTerminal({ wakeState: 'expired' }), true);
  // ⚠ 旧格式：有 firedAt 但没有 wakeState。不认的话，升级之后历史条目会集体重响。
  assert.equal(wake.isWakeTerminal({ firedAt: '2026-09-10T01:00:00Z' }), true);
});

test('失败和进行中都不是终态 —— 它们还需要被看见', () => {
  assert.equal(wake.isWakeTerminal({ wakeState: 'failed' }), false);
  assert.equal(wake.isWakeTerminal({ wakeState: 'running' }), false);
  assert.equal(wake.isWakeTerminal({}), false);
});

// ── agenda 形状迁移 ───────────────────────────────────────────────

// ⚠ 两个数组的归属是**互换**的，不是改个名字。
//   直接 rename 会把唤醒条目挪到人名下，而调度只扫 mine —— 闹钟从此静默失效。
test('旧格式的 hers/mine 要对调，不是改名', () => {
  const old = { hers: [{ id: 'agent-的' }], mine: [{ id: '人的' }] };
  const m = wake.migrateAgendaShape(old);
  assert.equal(m.migrated, true);
  assert.equal(m.mine[0].id, 'agent-的', 'agent 的待办要落到 mine 里 —— 调度只扫这个数组');
  assert.equal(m.yours[0].id, '人的');
});

test('新格式原样返回，不标记迁移', () => {
  const m = wake.migrateAgendaShape({ mine: [{ id: 'a' }], yours: [] });
  assert.equal(m.migrated, false);
  assert.equal(m.mine[0].id, 'a');
});

test('缺字段、烂类型都退化成空表', () => {
  for (const bad of [null, {}, { mine: 'x' }, { mine: null, yours: 3 }]) {
    const m = wake.migrateAgendaShape(bad);
    assert.deepEqual(m.mine, []);
    assert.deepEqual(m.yours, []);
  }
});

// ── 一拍 ──────────────────────────────────────────────────────────

const at = (date, time, over) => ({ id: `${date}-${time}`, text: '醒来', date, time, wake: true, done: false, ...over });
const after = (item, ms = 1000) => wake.wakeFireTime(item) + ms;

test('还没到点就不响', () => {
  const item = at('2026-09-10', '09:00');
  const { due } = wake.planTick({ mine: [item] }, wake.wakeFireTime(item) - 1000);
  assert.equal(due, null);
});

test('到点了就该响', () => {
  const item = at('2026-09-10', '09:00');
  const { due } = wake.planTick({ mine: [item] }, after(item));
  assert.equal(due && due.id, item.id);
});

// ⚠ 服务停了一整夜再起来，可能有五条同时到点。一次全叫醒的话，
//   五个进程会抢同一个会话，那五句话也会挤在一起到达。剩下的下一拍再说。
test('一拍只叫醒一条', () => {
  const items = ['09:00', '10:00', '11:00'].map((t) => at('2026-09-10', t));
  const now = Math.max(...items.map(wake.wakeFireTime)) + 1000;
  const { due } = wake.planTick({ mine: items }, now);
  assert.ok(due, '总得挑出一条');
  assert.equal(typeof due.id, 'string');
  // 挑的是 mine 里排在最前的那条到点条目
  assert.equal(due.id, items[0].id);
});

// ⚠ 但**过期作废要一次收干净**：那是纯记账，不花任何代价，
//   拖到下一拍的话，一次长时间停机之后要花很多拍才能清完。
test('过期条目一次全部收集', () => {
  const items = ['09:00', '10:00', '11:00'].map((t) => at('2026-09-10', t));
  const now = wake.wakeFireTime(items[2]) + wake.WAKE_STALE_MS + 1000;
  const { due, expired } = wake.planTick({ mine: items }, now);
  assert.equal(expired.length, 3, '三条都过期太久了，应该一次全部作废');
  assert.equal(due, null, '全过期了就没有该叫醒的');
});

test('刚过点但没超过作废窗口的，仍然要响', () => {
  const item = at('2026-09-10', '09:00');
  const { due, expired } = wake.planTick({ mine: [item] }, wake.wakeFireTime(item) + wake.WAKE_STALE_MS - 1000);
  assert.equal(due && due.id, item.id);
  assert.equal(expired.length, 0);
});

test('不是唤醒条目、已完成、已终态的一律跳过', () => {
  const now = Date.parse('2026-09-20T12:00:00');
  const mine = [
    at('2026-09-10', '09:00', { wake: false }),                    // 只是待办，不是闹钟
    at('2026-09-10', '09:01', { done: true }),                     // 已完成
    at('2026-09-10', '09:02', { wakeState: 'delivered' }),         // 已送达
    at('2026-09-10', '09:03', { wakeState: 'expired' }),           // 已作废
    at('2026-09-10', '09:04', { firedAt: '2026-09-10T01:00:00Z' }), // 旧格式的终态
  ];
  const { due, expired } = wake.planTick({ mine }, now);
  assert.equal(due, null, '这五条没有一条该被碰');
  assert.equal(expired.length, 0, '也不该被作废 —— 它们已经了结了');
});

test('日期烂掉的条目被跳过，不会拖垮整拍', () => {
  const good = at('2026-09-10', '09:00');
  const mine = [{ id: 'bad', text: 'x', date: '???', wake: true, done: false }, good];
  const { due } = wake.planTick({ mine }, after(good));
  assert.equal(due && due.id, good.id, '烂条目要跳过，后面的好条目照常响');
});

test('空 agenda 不炸', () => {
  for (const a of [null, {}, { mine: [] }, { mine: null }]) {
    const r = wake.planTick(a, Date.now());
    assert.equal(r.due, null);
    assert.deepEqual(r.expired, []);
  }
});

// ── 崩溃恢复 ──────────────────────────────────────────────────────

// ⚠ 记成 failed 而不是 delivered：我们并不知道那句话到底送到没有。
//   记成成功的话，一次没送达的唤醒会被永久当成已完成，而且不留痕迹。
test('崩在半路的记成 failed，不是 delivered', () => {
  const agenda = { mine: [at('2026-09-10', '09:00', { wakeState: 'running' })] };
  const fixed = wake.recoverInterrupted(agenda);
  assert.equal(fixed.length, 1);
  assert.equal(agenda.mine[0].wakeState, 'failed', '不知道有没有送到，就不能记成送到了');
});

test('恢复不碰别的状态', () => {
  const agenda = { mine: [
    at('2026-09-10', '09:00', { wakeState: 'delivered' }),
    at('2026-09-10', '09:01', { wakeState: 'failed' }),
    at('2026-09-10', '09:02', { wakeState: 'running', done: true }),
  ] };
  assert.equal(wake.recoverInterrupted(agenda).length, 0, '没有需要恢复的，就不该报告改动');
  assert.equal(agenda.mine[0].wakeState, 'delivered');
  assert.equal(agenda.mine[2].wakeState, 'running', '已完成的条目不归它管');
});

// ── 状态迁移 ──────────────────────────────────────────────────────

test('markRunning 记下时刻和会话', () => {
  const item = at('2026-09-10', '09:00');
  wake.markRunning(item, 'sess-1', new Date('2026-09-10T09:03:00Z'));
  assert.equal(item.wakeState, 'running');
  assert.equal(item.sessionId, 'sess-1');
  assert.equal(item.firedAt, '2026-09-10T09:03:00.000Z');
});

test('markExpired 不覆盖已有的 firedAt', () => {
  const item = at('2026-09-10', '09:00', { firedAt: '2026-09-10T09:03:00.000Z' });
  wake.markExpired(item, new Date('2026-09-20T00:00:00Z'));
  assert.equal(item.wakeState, 'expired');
  assert.equal(item.firedAt, '2026-09-10T09:03:00.000Z', '第一次触发的时刻是事实，不该被作废时刻盖掉');
});

// ── 读写 ──────────────────────────────────────────────────────────

test('读写一个来回，内容不变', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-wake-'));
  try {
    const agenda = { mine: [at('2026-09-10', '09:00')], yours: [{ id: 'y1', text: '人的待办' }] };
    wake.saveAgenda(dir, agenda);
    const back = wake.loadAgenda(dir);
    assert.equal(back.mine[0].id, agenda.mine[0].id);
    assert.equal(back.yours[0].text, '人的待办');
    // ⚠ 原子写：不能留下 .tmp
    assert.deepEqual(fs.readdirSync(dir), ['agenda.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文件不存在或读坏了，返回空表而不是抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-wake-'));
  try {
    assert.deepEqual(wake.loadAgenda(dir).mine, [], '没有文件就是空表');
    fs.writeFileSync(path.join(dir, 'agenda.json'), '{ 半截 JSON', 'utf8');
    assert.deepEqual(wake.loadAgenda(dir).mine, [],
      '读坏了也返回空表 —— 闹钟不响，好过拿半个文件去猜该叫谁');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('存盘时把旧格式一并写成新格式', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-wake-'));
  try {
    fs.writeFileSync(path.join(dir, 'agenda.json'),
      JSON.stringify({ hers: [{ id: 'agent-的' }], mine: [{ id: '人的' }] }), 'utf8');
    const loaded = wake.loadAgenda(dir);
    assert.equal(loaded.migrated, true);
    wake.saveAgenda(dir, loaded);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'agenda.json'), 'utf8'));
    assert.equal(raw.mine[0].id, 'agent-的');
    assert.ok(!('hers' in raw), '写回去之后不该再有旧键');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 交接纸条 ──────────────────────────────────────────────────────
//
// ⚠ 这几条钉的不是文案，是**纸条和代码之间的那条契约**：
//   纸条教人怎么改期，而改期到底成不成由 isWakeTerminal 说了算。
//   两边只要有一边先改，纸条就会变成一句「照做了却不起作用」的指令 —— 而且不报错。

test('交接纸条先说这段字是谁写的', () => {
  const note = wake.buildHandoff(
    { id: 'h1', text: '醒来了。今天不用干活。', date: '2026-09-19', time: '09:00' },
    { host: '某宿主', human: '某人' },
  );
  assert.ok(note.startsWith('【某宿主 闹钟交接 · 不是 某人 新说的话】'),
    '它坐的是「平时人说话」的那个位置，没有信封就会被当成人刚下达的指令');
  assert.ok(note.includes('醒来了。今天不用干活。'), '上一个他写的原话要原样带着，不能被概括');
  assert.ok(note.includes('2026-09-19 09:00'), '得说清楚这闹钟本来排在什么时候');
  assert.ok(note.includes('由你定'), '做不做是他的事 —— 这正是交接而不是重新叫醒的理由');
});

test('没给人名就不假装有人说过话', () => {
  const note = wake.buildHandoff({ id: 'h1', text: 'x' }, { host: '宿主' });
  assert.ok(note.startsWith('【宿主 闹钟交接】'), '不知道那个位置平时是谁，就别编一个名字进去');
  assert.ok(note.includes('（没写日期）'), '没有日期要如实说，不能拿今天顶上');
});

test('没有正文就没有纸条', () => {
  assert.equal(wake.buildHandoff({ id: 'h1' }), null, '空信封不如不发 —— 调用方据此退回原样投递');
  assert.equal(wake.buildHandoff(null), null);
});

// ⚠⚠ 这一条是上面那几条里唯一**不测字符串**的：它照着纸条说的做一遍，看闹钟会不会真的再响。
//   光断言「纸条里出现了 wakeState 和 firedAt」只能证明那两个词在，证明不了那句话是对的。
test('照纸条说的改期，闹钟真的会再响；只改一半则不会', () => {
  const at = (offsetMs) => {
    const d = new Date(Date.now() + offsetMs);
    const p = (n) => String(n).padStart(2, '0');
    return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
  };
  const fired = {
    id: 'h1', text: '醒来了', wake: true, done: false,
    ...at(-60 * 60 * 1000), wakeState: 'delivered', firedAt: new Date().toISOString(),
  };
  assert.equal(wake.planTick({ mine: [fired] }).due, null, '已经送达过的条目不该再响');

  // ① 只改时间（纸条里明确警告过的那一半）
  const halfDone = { ...fired, ...at(-20 * 60 * 1000) };
  assert.equal(wake.planTick({ mine: [halfDone] }).due, null,
    '只改 date/time 的话它仍然是终态 —— 纸条必须把这件事说出来，否则人照做了却一声不响地失效');

  // ② 按纸条说的，把两个字段一起删掉
  const rescheduled = { ...halfDone };
  delete rescheduled.wakeState;
  delete rescheduled.firedAt;
  assert.equal(wake.planTick({ mine: [rescheduled] }).due, rescheduled,
    '清掉 wakeState 和 firedAt 之后必须真的重新排队 —— 这就是纸条给出的那条指令');

  // ③ 纸条给的另一条出路：不要了就标 done
  assert.equal(wake.planTick({ mine: [{ ...rescheduled, done: true }] }).due, null,
    '标了 done 就不该再响');
});

if (!process.exitCode) {
  console.log(`Wake contract checks passed (${passed} groups): jitter, fire time, terminal states, migration, tick, recovery, persistence, handoff.`);
}
