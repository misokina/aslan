'use strict';

/**
 * 唤醒：到点了把一句话交给 agent，让他自己接着往下走。
 *
 * ⚠ **这个模块不叫醒任何人。** 它只回答三个问题：
 *   现在该触发哪一条、哪些已经过期该作废、上次崩在半路的那条怎么办。
 * 真正「怎么叫」——起进程、投消息、还是别的什么——是宿主的事，
 * 因为那取决于宿主怎么跑 agent，而这一层不该知道。
 *
 * 这个切分是有代价的：宿主必须按顺序调用（见 planTick 的注释），
 * 漏一步就会留下永远停在 `running` 的条目。换来的是这一整套判断可以纯函数地测，
 * 而唤醒恰恰是**最没人看着的时候才发生**的功能 —— 出了错没有人会当场发现。
 *
 * 一个待办条目：
 *   { id, text, date: 'YYYY-MM-DD', time: 'HH:MM', wake: true, done: false,
 *     sessionId?, wakeState?, firedAt? }
 */

const fs = require('fs');
const path = require('path');

/** 服务停了太久，过期的条目直接作废 —— 别在开机时补触发一大堆。 */
const WAKE_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * 触发时刻的抖动：60–600 秒，**从 id 哈希派生，不是随机数**。
 *
 * ⚠ 两个理由，都不能用 Math.random 替代：
 *   1. 整点准时触发太像脚本了 —— 一个每天 09:00:00 整响的闹钟，读起来不像有人醒来。
 *   2. 派生出来的偏移**重启后不变**。用随机数的话，同一条待办在每次重启后
 *      都会挪到一个新的时刻，于是它可能提前触发，也可能被反复触发。
 */
function wakeJitterMs(id) {
  let h = 0;
  const str = String(id || '');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return (60 + (h % 540)) * 1000;
}

/**
 * 条目该在什么时候响。⚠ 按**本地时间**算 —— `2026-09-10T09:00:00` 不带时区，
 * 所以「早上九点」指的是这台机器上的九点，这正是闹钟该有的语义。
 */
function wakeFireTime(item) {
  if (!item || !item.date) return NaN;
  const at = Date.parse(`${item.date}T${item.time || '09:00'}:00`);
  if (!Number.isFinite(at)) return NaN;
  return at + wakeJitterMs(item.id);
}

/**
 * 已经了结了，不该再看它。
 * ⚠ `firedAt` 有值但没有 wakeState 的，是更早版本留下的形状，也算终态 ——
 *   不然升级之后所有历史条目会集体重响一次。
 */
function isWakeTerminal(item) {
  if (!item) return true;
  if (item.wakeState === 'delivered' || item.wakeState === 'expired') return true;
  if (item.firedAt && !item.wakeState) return true;
  return false;
}

// ── agenda 的读写 ─────────────────────────────────────────────────

/**
 * ⚠ 两个数组，视角是 **agent 的**：`mine` 是他自己的待办和唤醒表，
 *   `yours` 是人的。调度只扫 `mine` —— 放错数组，闹钟不会响，而且没有任何报错。
 *
 * 早期版本用的是 `hers`/`mine` 且归属相反。见到 `hers` 就认定是旧文件并对调。
 * ⚠ 不能只改键名：两个数组的归属是互换的，直接 rename 会把唤醒条目挪到人名下。
 */
function migrateAgendaShape(a) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  if (a && Object.prototype.hasOwnProperty.call(a, 'hers')) {
    return { mine: arr(a.hers), yours: arr(a.mine), migrated: true };
  }
  return { mine: arr(a && a.mine), yours: arr(a && a.yours), migrated: false };
}

function agendaPath(dir) {
  return path.join(dir, 'agenda.json');
}

/** 读不到、读坏了都返回空表 —— 闹钟不响好过拿半个文件去猜。 */
function loadAgenda(dir) {
  try {
    return migrateAgendaShape(JSON.parse(fs.readFileSync(agendaPath(dir), 'utf8')));
  } catch {
    return { mine: [], yours: [], migrated: false };
  }
}

/** ⚠ 原子写：调度每分钟都在读它，非原子写会让某一拍读到半截 JSON。 */
function saveAgenda(dir, agenda) {
  fs.mkdirSync(dir, { recursive: true });
  const file = agendaPath(dir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    mine: Array.isArray(agenda.mine) ? agenda.mine : [],
    yours: Array.isArray(agenda.yours) ? agenda.yours : [],
  }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ── 一拍 ──────────────────────────────────────────────────────────

/**
 * 这一拍该做什么。**纯函数，不改 agenda，也不写盘。**
 *
 * @returns {{ due: object|null, expired: object[] }}
 *   `due`     这一拍该叫醒的那**一条**（见下面为什么只有一条）
 *   `expired` 已经过期太久、该作废的条目
 *
 * ⚠ **一拍只触发一条。** 服务停了一整夜再起来，可能有五条同时到点 ——
 *   一次全叫醒的话，五个进程同时抢同一个会话，而且那五句话会挤在一起到达。
 *   剩下的下一拍再说，反正拍是每分钟一次。
 *
 * 宿主拿到结果之后必须按这个顺序做，漏一步就会留下停在 `running` 的条目：
 *   1. `markExpired` 每一条 expired，然后 `saveAgenda`
 *   2. `markRunning(due)` 并**立刻 saveAgenda** —— 先落盘再去叫醒，
 *      这样即使叫醒的过程中整个进程崩了，重启后 `recoverInterrupted` 也认得出来
 *   3. 真的去叫醒
 *   4. 按结果 `markDelivered` 或 `markFailed`，再 `saveAgenda`
 */
function planTick(agenda, now = Date.now()) {
  const mine = Array.isArray(agenda && agenda.mine) ? agenda.mine : [];
  const expired = [];
  let due = null;

  for (const item of mine) {
    if (!item || !item.wake || item.done || isWakeTerminal(item)) continue;
    const fireAt = wakeFireTime(item);
    if (!Number.isFinite(fireAt) || now < fireAt) continue;

    if (now - fireAt > WAKE_STALE_MS) {
      expired.push(item);
      continue;
    }
    // ⚠ 过期的照样全部收集，只有「要叫醒」的那条取第一个就停。
    //   作废是纯记账，不花任何代价，没有理由拖到下一拍。
    if (!due) due = item;
  }
  return { due, expired };
}

/**
 * 上一次跑到一半就没了的条目：`running` 说明标记落了盘，但结果从来没被写回。
 *
 * ⚠ 记成 `failed` 而不是 `delivered` —— 我们并不知道那句话到底有没有送到。
 *   记成成功的话，一次没送达的唤醒会被永久当成已完成，而且不留任何痕迹。
 * ⚠ 也不重试：谁知道它已经跑到哪一步了。留下 `failed` 让人看得见，比猜一次好。
 *
 * @returns {object[]} 被改写的条目（空数组表示不用存盘）
 */
function recoverInterrupted(agenda) {
  const mine = Array.isArray(agenda && agenda.mine) ? agenda.mine : [];
  const fixed = [];
  for (const item of mine) {
    if (!item || !item.wake || item.done) continue;
    if (item.wakeState === 'running') {
      item.wakeState = 'failed';
      fixed.push(item);
    }
  }
  return fixed;
}

// ── 状态迁移 ──────────────────────────────────────────────────────
// 就地改条目并返回它。分成四个显式的动作而不是一个 setState，
// 是为了让「先落盘再叫醒」那个顺序在调用处看得见。

function markRunning(item, sessionId, now = new Date()) {
  item.wakeState = 'running';
  item.firedAt = now.toISOString();
  if (sessionId) item.sessionId = sessionId;
  return item;
}

function markDelivered(item) {
  item.wakeState = 'delivered';
  return item;
}

function markFailed(item) {
  item.wakeState = 'failed';
  return item;
}

function markExpired(item, now = new Date()) {
  item.wakeState = 'expired';
  item.firedAt = item.firedAt || now.toISOString();
  return item;
}

module.exports = {
  WAKE_STALE_MS,
  wakeJitterMs,
  wakeFireTime,
  isWakeTerminal,
  migrateAgendaShape,
  loadAgenda,
  saveAgenda,
  planTick,
  recoverInterrupted,
  markRunning,
  markDelivered,
  markFailed,
  markExpired,
};
