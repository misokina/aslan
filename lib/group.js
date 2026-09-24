#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getParticipantConfig } = require('./participant-config');

const DEFAULT_TALKS_DIR = process.env.ASLAN_TALKS_DIR
  || path.join(process.env.ASLAN_DATA_DIR || path.join(__dirname, '..', 'data'), 'talks');
const PARTICIPANT_CONFIG = getParticipantConfig();
const HUMAN_PARTICIPANT = PARTICIPANT_CONFIG.humanId;
const PARTICIPANTS = PARTICIPANT_CONFIG.participantIds;
const AGENT_PARTICIPANTS = new Set(PARTICIPANT_CONFIG.agentIds);
const MESSAGE_AUTHORS = new Set(PARTICIPANTS);
const CONTROL_AUTHORS = new Set(['aslan', ...PARTICIPANTS]);
const CURSOR_FIELDS = new Set(['contextThrough', 'memoryThrough']);
const DELIVERY_ATTEMPT_STATUSES = new Set(['pending', 'committed', 'failed']);
const DELIVERY_CONFIRMATION_TYPE = 'assistant-output';
const TRIGGER_SOURCES = new Set(['human', 'mention', 'reply', 'handoff', 'wakeup', 'manual']);
const CONTROL_TYPES = new Set([
  'handoff_claimed',
  'handoff_declined',
  'handoff_expired',
  'delivery_failed',
  'episode_paused',
  'quota_warning',
  'runtime_changed',
  'seen',
]);
const NON_BUDGET_CONTROL_TYPES = new Set(['quota_warning', 'runtime_changed', 'seen']);
const ROOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/;
const EVENT_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 1000;
const DEFAULT_CLAIM_LEASE_MS = 5 * 60_000;
const CAPTURED_REPLY_PROVENANCE_TYPE = 'aslan-captured-agent-reply';
const CROCKFORD32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_RANDOM_MASK = (1n << 80n) - 1n;

function cloneJson(value) {
  if (!value || typeof value !== 'object') throw new TypeError('event must be an object');
  return JSON.parse(JSON.stringify(value));
}

function sleep(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function localIso(now = new Date()) {
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
    + `T${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
    + `.${String(now.getMilliseconds()).padStart(3, '0')}`
    + `${sign}${pad2(Math.floor(absoluteOffset / 60))}:${pad2(absoluteOffset % 60)}`;
}

function localDateFromIso(value) {
  assertIsoTimestamp(value, 'timestamp');
  return value.slice(0, 10);
}

function groupsDir(opts = {}) {
  const talksDir = opts.talksDir || DEFAULT_TALKS_DIR;
  return path.resolve(talksDir, 'groups');
}

function validateRoomId(roomId) {
  if (typeof roomId !== 'string' || !ROOM_ID_RE.test(roomId)) {
    throw new Error(`Invalid room id: ${JSON.stringify(roomId)}`);
  }
  return roomId;
}

function roomDir(roomId, opts = {}) {
  return path.join(groupsDir(opts), validateRoomId(roomId));
}

function eventFilePath(roomId, date, opts = {}) {
  if (!DATE_RE.test(date)) throw new Error(`Invalid event date: ${date}`);
  return path.join(roomDir(roomId, opts), `${date}.jsonl`);
}

function cursorsFilePath(roomId, opts = {}) {
  return path.join(roomDir(roomId, opts), 'cursors.json');
}

function deliveryAttemptsFilePath(roomId, opts = {}) {
  return path.join(roomDir(roomId, opts), 'delivery-attempts.json');
}

function roomFilePath(roomId, opts = {}) {
  return path.join(roomDir(roomId, opts), 'room.json');
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function removeAbandonedLock(lockPath) {
  let owner;
  let stat;
  try {
    stat = fs.statSync(lockPath);
    owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    owner = null;
  }

  const age = stat ? Date.now() - stat.mtimeMs : LOCK_STALE_MS + 1;
  if (owner && processIsAlive(owner.pid) && age <= LOCK_STALE_MS) return false;
  if (!owner && age <= LOCK_STALE_MS) return false;

  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'ENOENT');
  }
}

function acquireRoomLock(roomId, opts = {}) {
  const dir = roomDir(roomId, opts);
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, '.group.lock');
  const token = crypto.randomBytes(16).toString('hex');
  const timeoutMs = Number.isFinite(opts.lockTimeoutMs) ? opts.lockTimeoutMs : LOCK_TIMEOUT_MS;
  const deadline = Date.now() + Math.max(0, timeoutMs);

  while (true) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify({
          pid: process.pid,
          token,
          createdAt: new Date().toISOString(),
        }));
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      return { lockPath, token };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      if (removeAbandonedLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for group lock: ${lockPath}`);
      sleep(LOCK_WAIT_MS);
    }
  }
}

function releaseRoomLock(lock) {
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  if (!owner || owner.token !== lock.token) return;
  try {
    fs.unlinkSync(lock.lockPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function withRoomLock(roomId, opts, callback) {
  const lock = acquireRoomLock(roomId, opts);
  let result;
  let callbackError;
  try {
    assertRoomParticipantsLocked(roomId, opts);
    result = callback();
  } catch (error) {
    callbackError = error;
  }
  try {
    releaseRoomLock(lock);
  } catch (releaseError) {
    if (!callbackError) callbackError = releaseError;
  }
  if (callbackError) throw callbackError;
  return result;
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (descriptor !== null && descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

function listEventFiles(roomId, opts = {}) {
  const dir = roomDir(roomId, opts);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => EVENT_FILE_RE.test(name)).sort();
}

function readEventFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  if (!raw) return [];
  const events = [];
  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Malformed group event at ${filePath}:${index + 1}: ${error.message}`);
    }
  }
  return events;
}

function readAllEventsLocked(roomId, opts = {}) {
  const dir = roomDir(roomId, opts);
  const events = [];
  for (const name of listEventFiles(roomId, opts)) {
    events.push(...readEventFile(path.join(dir, name)));
  }
  events.sort((left, right) => String(left.id).localeCompare(String(right.id), 'en'));
  return events;
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function encodeBase32(value, width) {
  let remaining = BigInt(value);
  let output = '';
  for (let index = 0; index < width; index += 1) {
    output = CROCKFORD32[Number(remaining & 31n)] + output;
    remaining >>= 5n;
  }
  if (remaining !== 0n) throw new Error('ULID value overflow');
  return output;
}

function decodeBase32(text) {
  let value = 0n;
  for (const rawCharacter of text) {
    const character = rawCharacter.toUpperCase();
    const digit = CROCKFORD32.indexOf(character);
    if (digit < 0) throw new Error(`Invalid ULID character: ${rawCharacter}`);
    value = (value << 5n) | BigInt(digit);
  }
  return value;
}

function random80Bits() {
  const bytes = crypto.randomBytes(10);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function makeUlid(timestampMs = Date.now(), randomValue = random80Bits()) {
  const time = BigInt(Math.max(0, Math.floor(timestampMs)));
  if (time >= (1n << 48n)) throw new Error('ULID timestamp overflow');
  return encodeBase32(time, 10) + encodeBase32(randomValue & ULID_RANDOM_MASK, 16);
}

function nextMonotonicUlid(previousId, timestampMs = Date.now()) {
  if (!previousId) return makeUlid(timestampMs);
  if (!ULID_RE.test(previousId)) throw new Error(`Invalid previous event id: ${previousId}`);
  const previousTime = decodeBase32(previousId.slice(0, 10));
  const requestedTime = BigInt(Math.max(0, Math.floor(timestampMs)));
  let nextTime = requestedTime > previousTime ? requestedTime : previousTime;
  let nextRandom;
  if (nextTime === previousTime) {
    nextRandom = decodeBase32(previousId.slice(10)) + 1n;
    if (nextRandom > ULID_RANDOM_MASK) {
      nextTime += 1n;
      nextRandom = 0n;
    }
  } else {
    nextRandom = random80Bits();
  }
  return makeUlid(Number(nextTime), nextRandom);
}

function applyRedactions(text, report) {
  let output = String(text);
  const replace = (type, expression) => {
    output = output.replace(expression, () => {
      report.count += 1;
      report.types.add(type);
      return `[REDACTED:${type}]`;
    });
  };

  replace('pem', /-----BEGIN ([A-Z0-9][A-Z0-9 -]{0,80})-----[\s\S]*?-----END \1-----/g);
  replace('authorization', /^\s*Authorization\s*:\s*.*$/gim);
  replace('jwt', /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g);
  replace('anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g);
  replace('openai-key', /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{16,}\b/g);
  replace('github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g);
  replace('aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g);
  replace('slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g);
  replace('google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g);
  replace('bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi);
  return output;
}

function redactValue(value, report) {
  if (typeof value === 'string') return applyRedactions(value, report);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, report));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'redaction') continue;
    output[key] = redactValue(child, report);
  }
  return output;
}

function redactEvent(event) {
  const report = { count: 0, types: new Set() };
  const output = redactValue(event, report);
  if (report.count > 0) {
    output.redaction = {
      applied: true,
      count: report.count,
      types: Array.from(report.types).sort(),
    };
  }
  return output;
}

function assertString(value, label, options = {}) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (!options.allowEmpty && !value) throw new Error(`${label} must not be empty`);
  if (options.maxLength && value.length > options.maxLength) {
    throw new Error(`${label} exceeds ${options.maxLength} characters`);
  }
}

function assertIsoTimestamp(value, label) {
  assertString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || Number.isNaN(new Date(value).getTime())) {
    throw new Error(`${label} must be an ISO timestamp with an offset`);
  }
}

function assertUlidOrNull(value, label) {
  if (value === null) return;
  if (typeof value !== 'string' || !ULID_RE.test(value)) throw new Error(`${label} must be a ULID or null`);
}

function normalizeParticipantArray(value, label, defaultValue) {
  const array = value === undefined ? defaultValue : value;
  if (!Array.isArray(array)) throw new Error(`${label} must be an array`);
  const seen = new Set();
  const output = [];
  for (const participant of array) {
    if (!PARTICIPANTS.includes(participant)) throw new Error(`${label} contains unknown participant: ${participant}`);
    if (!seen.has(participant)) {
      seen.add(participant);
      output.push(participant);
    }
  }
  return output;
}

function findEvent(events, eventId) {
  return events.find((event) => event.id === eventId) || null;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalJson(item));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalJson(value[key]);
  return output;
}

function jsonEquals(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function runtimeChangedComparable(event) {
  return {
    kind: event.kind,
    author: event.author,
    control: event.control,
  };
}

function assertRuntimeChangedIdempotencyMatch(existing, input) {
  if (existing.kind !== 'control' || existing.control?.type !== 'runtime_changed'
    || input.kind !== 'control' || input.control?.type !== 'runtime_changed') {
    throw new Error(`Idempotency conflict for runtime change: ${input.idempotencyKey}`);
  }
  const candidate = {
    kind: input.kind,
    author: input.author,
    control: cloneJson(input.control),
  };
  normalizeControlEvent(candidate);
  const redactedCandidate = redactEvent(candidate);
  if (!jsonEquals(runtimeChangedComparable(existing), runtimeChangedComparable(redactedCandidate))) {
    throw new Error(`Idempotency conflict for runtime change: ${input.idempotencyKey}`);
  }
}

function normalizeEvent(input, events, opts = {}) {
  let event = cloneJson(input);
  event.v = event.v === undefined ? 1 : event.v;
  if (event.v !== 1) throw new Error(`Unsupported group event version: ${event.v}`);

  const hasExplicitIdempotencyKey = event.idempotencyKey !== undefined;
  if (event.idempotencyKey !== undefined) {
    assertString(event.idempotencyKey, 'idempotencyKey', { maxLength: 256 });
    if (!IDEMPOTENCY_KEY_RE.test(event.idempotencyKey)) {
      throw new Error('idempotencyKey contains unsupported characters');
    }
    const existing = events.find((item) => item.idempotencyKey === event.idempotencyKey);
    if (existing) {
      if (existing.control?.type === 'runtime_changed' || event.control?.type === 'runtime_changed') {
        assertRuntimeChangedIdempotencyMatch(existing, event);
      }
      return { existing };
    }
  }

  const now = opts.now instanceof Date ? opts.now : new Date();
  event.at = event.at || localIso(now);
  assertIsoTimestamp(event.at, 'event.at');
  const eventTime = new Date(event.at);
  const previousId = events.length ? events[events.length - 1].id : null;
  if (event.id === undefined) event.id = nextMonotonicUlid(previousId, eventTime.getTime());
  if (!ULID_RE.test(event.id)) throw new Error('event.id must be a ULID');
  if (previousId && event.id <= previousId) throw new Error('event.id must be greater than the latest event id');
  event.idempotencyKey = event.idempotencyKey || `event:${event.id}`;
  event.episodeId = event.episodeId || makeUlid(eventTime.getTime());
  if (!ULID_RE.test(event.episodeId)) throw new Error('episodeId must be a ULID');

  event.inReplyTo = event.inReplyTo === undefined ? null : event.inReplyTo;
  event.causedBy = event.causedBy === undefined ? null : event.causedBy;
  assertUlidOrNull(event.inReplyTo, 'inReplyTo');
  assertUlidOrNull(event.causedBy, 'causedBy');
  if (event.inReplyTo && !findEvent(events, event.inReplyTo)) throw new Error(`inReplyTo event not found: ${event.inReplyTo}`);
  if (event.causedBy && !findEvent(events, event.causedBy)) throw new Error(`causedBy event not found: ${event.causedBy}`);

  if (event.kind === 'message') {
    normalizeMessageEvent(event, events, eventTime);
  } else if (event.kind === 'control') {
    normalizeControlEvent(event);
    if (event.control.type === 'runtime_changed' && !hasExplicitIdempotencyKey) {
      throw new Error('runtime_changed requires an explicit idempotencyKey');
    }
  } else {
    throw new Error(`Unsupported event kind: ${event.kind}`);
  }

  event = redactEvent(event);
  return { event };
}

function normalizeMessageEvent(event, events, eventTime) {
  if (!MESSAGE_AUTHORS.has(event.author)) throw new Error(`Invalid message author: ${event.author}`);
  assertString(event.text === undefined ? '' : event.text, 'message.text', { allowEmpty: true, maxLength: 1_000_000 });
  event.text = event.text === undefined ? '' : event.text;
  event.mentions = normalizeParticipantArray(event.mentions, 'mentions', []);
  event.targets = normalizeParticipantArray(event.targets, 'targets', []);
  event.visibleTo = normalizeParticipantArray(event.visibleTo, 'visibleTo', [...PARTICIPANTS]);
  if (!event.visibleTo.includes(event.author)) throw new Error('visibleTo must include the author');
  event.attachments = event.attachments === undefined ? [] : event.attachments;
  if (!Array.isArray(event.attachments)) throw new Error('attachments must be an array');
  if (!event.text && event.attachments.length === 0) throw new Error('message must contain text or attachments');
  event.provenance = event.provenance === undefined ? null : event.provenance;
  if (event.provenance !== null && (typeof event.provenance !== 'object' || Array.isArray(event.provenance))) {
    throw new Error('provenance must be an object or null');
  }

  const defaultTrigger = event.author === HUMAN_PARTICIPANT ? 'human' : 'manual';
  event.trigger = event.trigger || { source: defaultTrigger, handoffId: null };
  if (!event.trigger || typeof event.trigger !== 'object' || Array.isArray(event.trigger)) {
    throw new Error('trigger must be an object');
  }
  event.trigger.source = event.trigger.source || defaultTrigger;
  event.trigger.handoffId = event.trigger.handoffId === undefined ? null : event.trigger.handoffId;
  if (!TRIGGER_SOURCES.has(event.trigger.source)) throw new Error(`Invalid trigger source: ${event.trigger.source}`);
  assertUlidOrNull(event.trigger.handoffId, 'trigger.handoffId');
  if (event.trigger.source === 'handoff' && !event.trigger.handoffId) {
    throw new Error('handoff trigger requires trigger.handoffId');
  }
  if (event.trigger.source !== 'handoff' && event.trigger.handoffId) {
    throw new Error('trigger.handoffId is only valid for handoff triggers');
  }

  event.handoff = event.handoff === undefined ? null : event.handoff;
  if (event.handoff !== null) {
    if (!AGENT_PARTICIPANTS.has(event.author)) throw new Error('only an agent may create a handoff');
    if (!event.handoff || typeof event.handoff !== 'object' || Array.isArray(event.handoff)) {
      throw new Error('handoff must be an object or null');
    }
    event.handoff.id = event.handoff.id || makeUlid(eventTime.getTime());
    if (!ULID_RE.test(event.handoff.id)) throw new Error('handoff.id must be a ULID');
    if (!AGENT_PARTICIPANTS.has(event.handoff.target)) throw new Error(`Invalid handoff target: ${event.handoff.target}`);
    if (event.handoff.target === event.author) throw new Error('an agent cannot hand off to itself');
    assertIsoTimestamp(event.handoff.expiresAt, 'handoff.expiresAt');
    const expiresAt = new Date(event.handoff.expiresAt);
    if (expiresAt.getTime() <= eventTime.getTime()) throw new Error('handoff.expiresAt must be after event.at');
    if (!event.visibleTo.includes(event.handoff.target)) throw new Error('handoff target must be included in visibleTo');
    if (events.some((item) => item.handoff && item.handoff.id === event.handoff.id)) {
      throw new Error(`Duplicate handoff id: ${event.handoff.id}`);
    }
  }
}

function normalizeControlEvent(event) {
  if (!CONTROL_AUTHORS.has(event.author)) throw new Error(`Invalid control author: ${event.author}`);
  if (!event.control || typeof event.control !== 'object' || Array.isArray(event.control)) {
    throw new Error('control event requires a control object');
  }
  if (!CONTROL_TYPES.has(event.control.type)) throw new Error(`Invalid control type: ${event.control.type}`);
  event.control.handoffId = event.control.handoffId === undefined ? null : event.control.handoffId;
  event.control.target = event.control.target === undefined ? null : event.control.target;
  event.control.leaseUntil = event.control.leaseUntil === undefined ? null : event.control.leaseUntil;
  event.control.reason = event.control.reason === undefined ? null : event.control.reason;
  assertUlidOrNull(event.control.handoffId, 'control.handoffId');
  if (event.control.target !== null && !AGENT_PARTICIPANTS.has(event.control.target)) {
    throw new Error(`Invalid control target: ${event.control.target}`);
  }
  if (event.control.reason !== null) assertString(event.control.reason, 'control.reason', { allowEmpty: true, maxLength: 10_000 });

  if (event.control.type.startsWith('handoff_')) {
    if (!event.control.handoffId || !event.control.target) {
      throw new Error(`${event.control.type} requires handoffId and target`);
    }
  }
  if (event.control.type === 'delivery_failed') {
    if (!event.control.target) throw new Error('delivery_failed requires target');
    if (event.control.handoffId !== null) throw new Error('delivery_failed does not use handoffId');
  }
  if (event.control.type === 'quota_warning') {
    if (event.author !== 'aslan') throw new Error('Only aslan may write quota_warning');
    if (!event.control.target) throw new Error('quota_warning requires the affected quota owner as target');
    if (event.control.handoffId !== null) throw new Error('quota_warning does not use handoffId');
    if (!event.control.reason) throw new Error('quota_warning requires a non-empty reason');
  }
  if (event.control.type === 'seen') {
    if (!AGENT_PARTICIPANTS.has(event.author)) throw new Error('Only an agent may write seen');
    if (event.control.target !== event.author) throw new Error('seen target must match its author');
    if (event.control.handoffId !== null) throw new Error('seen does not use handoffId');
  }
  if (event.control.type === 'runtime_changed') normalizeRuntimeChangedControl(event);
  if (event.control.type === 'handoff_claimed') {
    assertIsoTimestamp(event.control.leaseUntil, 'control.leaseUntil');
  } else if (event.control.leaseUntil !== null) {
    throw new Error('control.leaseUntil is only valid for handoff_claimed');
  }
}

function assertExactObjectKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (!jsonEquals(actual, expected)) {
    throw new Error(`${label} must contain exactly: ${expected.join(', ')}`);
  }
}

function normalizeRuntimeDescriptor(value, label) {
  assertExactObjectKeys(value, ['model', 'reasoningEffort'], label);
  assertString(value.model, `${label}.model`, { maxLength: 256 });
  assertString(value.reasoningEffort, `${label}.reasoningEffort`, { maxLength: 64 });
  if (!value.model.trim()) throw new Error(`${label}.model must not be blank`);
  if (!value.reasoningEffort.trim()) throw new Error(`${label}.reasoningEffort must not be blank`);
  return {
    model: value.model,
    reasoningEffort: value.reasoningEffort,
  };
}

function normalizeRuntimeChangedControl(event) {
  if (event.author !== 'aslan') throw new Error('Only aslan may write runtime_changed');
  const control = event.control;
  assertExactObjectKeys(control, [
    'type',
    'target',
    'requestedBy',
    'scope',
    'before',
    'after',
    'reason',
    'handoffId',
    'leaseUntil',
  ], 'runtime_changed control');
  if (!control.target) throw new Error('runtime_changed requires target');
  if (!PARTICIPANTS.includes(control.requestedBy)) {
    throw new Error(`Invalid runtime_changed requestedBy: ${control.requestedBy}`);
  }
  if (control.scope !== 'group-session') {
    throw new Error('runtime_changed scope must be group-session');
  }
  control.before = normalizeRuntimeDescriptor(control.before, 'runtime_changed.before');
  control.after = normalizeRuntimeDescriptor(control.after, 'runtime_changed.after');
  if (jsonEquals(control.before, control.after)) {
    throw new Error('runtime_changed before and after must differ');
  }
  if (control.handoffId !== null) throw new Error('runtime_changed does not use handoffId');
  if (control.leaseUntil !== null) throw new Error('runtime_changed does not use leaseUntil');
  if (typeof control.reason !== 'string' || !control.reason.trim()) {
    throw new Error('runtime_changed requires a non-empty reason');
  }
}

function handoffState(events, handoffId) {
  const source = events.find((event) => event.kind === 'message' && event.handoff?.id === handoffId) || null;
  if (!source) return null;
  let latestClaim = null;
  let terminal = null;
  for (const event of events) {
    if (event.kind === 'message' && event.trigger?.source === 'handoff'
      && event.trigger.handoffId === handoffId) {
      terminal = { outcome: 'replied', event };
      continue;
    }
    if (event.kind !== 'control' || event.control?.handoffId !== handoffId) continue;
    if (event.control.type === 'handoff_claimed') latestClaim = event;
    if (event.control.type === 'handoff_declined') terminal = { outcome: 'declined', event };
    if (event.control.type === 'handoff_expired') terminal = { outcome: 'expired', event };
  }
  return { source, handoff: source.handoff, latestClaim, terminal };
}

function assertHandoffReplyIsValid(event, events, now = new Date()) {
  if (event.kind !== 'message' || event.trigger?.source !== 'handoff') return;
  const state = handoffState(events, event.trigger.handoffId);
  if (!state) throw new Error(`Handoff not found: ${event.trigger.handoffId}`);
  if (state.terminal) throw new Error(`Handoff is already terminal: ${state.terminal.outcome}`);
  if (state.handoff.target !== event.author) throw new Error('Only the handoff target may reply');
  if (new Date(state.handoff.expiresAt).getTime() <= now.getTime()) throw new Error('Handoff has expired');
  if (!state.latestClaim || state.latestClaim.control.target !== event.author) {
    throw new Error('Handoff must be claimed before replying');
  }
  if (new Date(state.latestClaim.control.leaseUntil).getTime() <= now.getTime()) {
    throw new Error('Handoff claim lease has expired');
  }
}

function assertHandoffControlIsValid(event, events, now = new Date()) {
  if (event.kind !== 'control' || !event.control?.type?.startsWith('handoff_')) return;
  const state = handoffState(events, event.control.handoffId);
  if (!state) throw new Error(`Handoff not found: ${event.control.handoffId}`);
  if (state.handoff.target !== event.control.target) throw new Error('Control target does not match handoff target');
  if (state.terminal) throw new Error(`Handoff is already terminal: ${state.terminal.outcome}`);

  const expiresAtMs = new Date(state.handoff.expiresAt).getTime();
  if (event.control.type === 'handoff_claimed') {
    if (event.author !== state.handoff.target) throw new Error('Only the handoff target may claim it');
    if (expiresAtMs <= now.getTime()) throw new Error('Cannot claim an expired handoff');
    const leaseUntilMs = new Date(event.control.leaseUntil).getTime();
    if (leaseUntilMs <= now.getTime() || leaseUntilMs > expiresAtMs) {
      throw new Error('Handoff claim lease must be in the future and not exceed handoff expiry');
    }
    return;
  }
  if (event.control.type === 'handoff_declined') {
    if (event.author !== state.handoff.target) throw new Error('Only the handoff target may decline it');
    if (expiresAtMs <= now.getTime()) throw new Error('Expired handoff must use handoff_expired');
    return;
  }
  if (event.control.type === 'handoff_expired') {
    if (event.author !== 'aslan') throw new Error('Only aslan may expire a handoff');
    if (expiresAtMs > now.getTime()) throw new Error('Cannot expire a live handoff');
  }
}

function assertEventLifecycleIsValid(event, events, now = new Date()) {
  assertHandoffReplyIsValid(event, events, now);
  assertHandoffControlIsValid(event, events, now);
}

function renderDateLocked(roomId, date, opts = {}) {
  const jsonlPath = eventFilePath(roomId, date, opts);
  const events = readEventFile(jsonlPath)
    .sort((left, right) => String(left.id).localeCompare(String(right.id), 'en'));
  const lines = [
    `# 群聊 · ${roomId} · ${date}`,
    '',
    '<!-- 由 lib/group.js 从同日 JSONL 生成；JSONL 是唯一真相。 -->',
    '',
  ];

  for (const event of events) {
    const time = typeof event.at === 'string' && event.at.length >= 16 ? event.at.slice(11, 16) : '--:--';
    if (event.kind === 'message') {
      lines.push(`## ${time} · ${event.author}`, '', event.text || '');
      if (event.attachments?.length) lines.push('', `> 附件：${event.attachments.length} 个`);
      if (event.handoff) lines.push('', `> 交棒给 ${event.handoff.target}`);
      if (event.redaction?.applied) {
        lines.push('', `> ⚠ 写入前已脱敏：${event.redaction.types.join(', ')}（${event.redaction.count} 处）`);
      }
      lines.push('');
      continue;
    }

    const control = event.control || {};
    const labels = {
      handoff_claimed: `${control.target || 'agent'} 已接收交棒`,
      handoff_declined: `${control.target || 'agent'} 这轮没有要补充的`,
      handoff_expired: `给 ${control.target || 'agent'} 的交棒已过期`,
      delivery_failed: `向 ${control.target || 'agent'} 投递失败`,
      episode_paused: '本轮群聊已暂停',
      quota_warning: `${control.target || 'agent'} 额度提醒`,
      runtime_changed: `${control.target || 'agent'} 的群聊运行时已调整`,
    };
    lines.push(`> ${time} · ${labels[control.type] || control.type}`);
    if (control.reason) lines.push(`> ${control.reason}`);
    if (event.redaction?.applied) {
      lines.push(`> ⚠ 写入前已脱敏：${event.redaction.types.join(', ')}（${event.redaction.count} 处）`);
    }
    lines.push('');
  }

  const markdownPath = path.join(roomDir(roomId, opts), `${date}.md`);
  atomicWrite(markdownPath, `${lines.join('\n').replace(/\n+$/, '')}\n`);
  return { filePath: markdownPath, date, eventCount: events.length };
}

function ensureRoomFilesLocked(roomId, event, opts = {}) {
  const metadataPath = roomFilePath(roomId, opts);
  if (!fs.existsSync(metadataPath)) {
    atomicWrite(metadataPath, `${JSON.stringify({
      v: 1,
      id: roomId,
      participants: [...PARTICIPANTS],
      participantRoles: { human: HUMAN_PARTICIPANT, agents: [...AGENT_PARTICIPANTS].sort() },
      defaultRouting: 'silent',
      createdAt: event.at,
    }, null, 2)}\n`);
  }
  const cursorPath = cursorsFilePath(roomId, opts);
  if (!fs.existsSync(cursorPath)) {
    atomicWrite(cursorPath, `${JSON.stringify(defaultCursors(), null, 2)}\n`);
  }
}

function assertRoomParticipantsLocked(roomId, opts = {}) {
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(roomFilePath(roomId, opts), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error(`Could not read room metadata: ${error.message}`);
  }
  if (!metadata || metadata.id !== roomId || !Array.isArray(metadata.participants)) {
    throw new Error(`Invalid room metadata for ${roomId}`);
  }
  const roles = { human: HUMAN_PARTICIPANT, agents: [...AGENT_PARTICIPANTS].sort() };
  if (!jsonEquals([...metadata.participants].sort(), [...PARTICIPANTS].sort())
    || (metadata.participantRoles && !jsonEquals(metadata.participantRoles, roles))) {
    throw new Error(`Participant identities differ from stored room ${roomId}; restore the configuration, migrate explicitly, or create a new room`);
  }
}

function appendEventLocked(roomId, input, opts, events) {
  const normalized = normalizeEvent(input, events, opts);
  if (normalized.existing) {
    ensureRoomFilesLocked(roomId, normalized.existing, opts);
    if (opts.render !== false) renderDateLocked(roomId, localDateFromIso(normalized.existing.at), opts);
    return normalized.existing;
  }
  const event = normalized.event;
  assertEventLifecycleIsValid(event, events, opts.now instanceof Date ? opts.now : new Date());
  ensureRoomFilesLocked(roomId, event, opts);
  const date = localDateFromIso(event.at);
  appendJsonLine(eventFilePath(roomId, date, opts), event);
  events.push(event);
  events.sort((left, right) => String(left.id).localeCompare(String(right.id), 'en'));
  if (opts.render !== false) renderDateLocked(roomId, date, opts);
  return event;
}

function appendEvent(roomId, event, opts = {}) {
  return withRoomLock(roomId, opts, () => {
    const events = readAllEventsLocked(roomId, opts);
    return appendEventLocked(roomId, event, opts, events);
  });
}

function assertOptionalString(value, label, options = {}) {
  if (value === null || value === undefined) return null;
  assertString(value, label, options);
  return value;
}

function defaultAgentReplyIdempotencyKey(sessionId, runId) {
  const digest = crypto.createHash('sha256')
    .update(`${sessionId}\0${runId}`, 'utf8')
    .digest('hex');
  return `agent-reply:${digest}`;
}

function capturedReplyComparable(event) {
  return {
    kind: event.kind,
    author: event.author,
    text: event.text,
    episodeId: event.episodeId,
    inReplyTo: event.inReplyTo,
    causedBy: event.causedBy,
    mentions: event.mentions,
    targets: event.targets,
    visibleTo: event.visibleTo,
    attachments: event.attachments,
    provenance: event.provenance,
    trigger: event.trigger,
    handoff: event.handoff,
    redaction: event.redaction || null,
  };
}

function buildCapturedAgentReply(reply, events) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
    throw new Error('reply must be an object');
  }
  if (!AGENT_PARTICIPANTS.has(reply.author)) {
    throw new Error(`Invalid captured reply author: ${reply.author}`);
  }
  assertString(reply.text, 'reply.text', { maxLength: 1_000_000 });
  if (typeof reply.episodeId !== 'string' || !ULID_RE.test(reply.episodeId)) {
    throw new Error('reply.episodeId must be a ULID');
  }
  if (typeof reply.inputThrough !== 'string' || !ULID_RE.test(reply.inputThrough)) {
    throw new Error('reply.inputThrough must be a ULID');
  }
  const inputFrom = reply.inputFrom === undefined ? null : reply.inputFrom;
  assertUlidOrNull(inputFrom, 'reply.inputFrom');

  const inputThroughEvent = findEvent(events, reply.inputThrough);
  if (!inputThroughEvent) throw new Error(`inputThrough event not found: ${reply.inputThrough}`);
  if (inputThroughEvent.episodeId !== reply.episodeId) {
    throw new Error('reply.episodeId must match the inputThrough event episode');
  }
  if (inputFrom !== null) {
    const inputFromEvent = findEvent(events, inputFrom);
    if (!inputFromEvent) throw new Error(`inputFrom event not found: ${inputFrom}`);
    if (inputFrom >= reply.inputThrough) throw new Error('inputFrom must be before inputThrough');
  }

  assertString(reply.sessionId, 'reply.sessionId', { maxLength: 256 });
  assertString(reply.runId, 'reply.runId', { maxLength: 256 });
  const runtime = assertOptionalString(reply.runtime, 'reply.runtime', { maxLength: 64 });
  const model = assertOptionalString(reply.model, 'reply.model', { maxLength: 256 });
  const inReplyTo = reply.inReplyTo === undefined ? null : reply.inReplyTo;
  const causedBy = reply.causedBy === undefined ? reply.inputThrough : reply.causedBy;
  assertUlidOrNull(inReplyTo, 'reply.inReplyTo');
  assertUlidOrNull(causedBy, 'reply.causedBy');

  const idempotencyKey = reply.idempotencyKey
    || defaultAgentReplyIdempotencyKey(reply.sessionId, reply.runId);
  assertString(idempotencyKey, 'reply.idempotencyKey', { maxLength: 256 });
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new Error('reply.idempotencyKey contains unsupported characters');
  }

  const mentions = normalizeParticipantArray(reply.mentions, 'reply.mentions', []);
  const targets = normalizeParticipantArray(reply.targets, 'reply.targets', []);
  const visibleTo = normalizeParticipantArray(reply.visibleTo, 'reply.visibleTo', [...PARTICIPANTS]);
  if (!visibleTo.includes(reply.author)) throw new Error('reply.visibleTo must include the author');
  const attachments = reply.attachments === undefined ? [] : cloneJson(reply.attachments);
  if (!Array.isArray(attachments)) throw new Error('reply.attachments must be an array');

  const trigger = reply.trigger === undefined
    ? { source: 'reply', handoffId: null }
    : cloneJson(reply.trigger);
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) {
    throw new Error('reply.trigger must be an object');
  }
  trigger.source = trigger.source || 'reply';
  trigger.handoffId = trigger.handoffId === undefined ? null : trigger.handoffId;
  const handoff = reply.handoff === undefined ? null : cloneJson(reply.handoff);
  if (handoff !== null && (!handoff.id || !ULID_RE.test(handoff.id))) {
    throw new Error('captured reply handoff.id must be a stable ULID');
  }

  const event = {
    kind: 'message',
    author: reply.author,
    text: reply.text,
    episodeId: reply.episodeId,
    inReplyTo,
    causedBy,
    mentions,
    targets,
    visibleTo,
    attachments,
    provenance: {
      type: CAPTURED_REPLY_PROVENANCE_TYPE,
      recordedBy: 'aslan',
      authorship: 'verbatim-agent-output',
      contentTransform: 'write-side-redaction-only',
      sessionId: reply.sessionId,
      runId: reply.runId,
      runtime,
      model,
      inputFrom,
      inputThrough: reply.inputThrough,
    },
    trigger,
    handoff,
    idempotencyKey,
  };
  if (reply.at !== undefined) event.at = reply.at;
  return event;
}

function appendAgentReply(roomId, reply, opts = {}) {
  return withRoomLock(roomId, opts, () => {
    const events = readAllEventsLocked(roomId, opts);
    const event = buildCapturedAgentReply(reply, events);
    const existing = events.find((item) => item.idempotencyKey === event.idempotencyKey) || null;
    if (existing) {
      const expected = redactEvent(event);
      if (!jsonEquals(capturedReplyComparable(existing), capturedReplyComparable(expected))) {
        throw new Error(`Idempotency conflict for captured agent reply: ${event.idempotencyKey}`);
      }
      ensureRoomFilesLocked(roomId, existing, opts);
      if (opts.render !== false) renderDateLocked(roomId, localDateFromIso(existing.at), opts);
      return existing;
    }
    return appendEventLocked(roomId, event, opts, events);
  });
}

function estimateGroupTextTokens(text) {
  let asciiRun = 0;
  let tokens = 0;
  const flushAscii = () => {
    if (asciiRun > 0) tokens += Math.ceil(asciiRun / 4);
    asciiRun = 0;
  };
  for (const character of String(text)) {
    if (character.codePointAt(0) <= 0x7f) {
      asciiRun += 1;
    } else {
      flushAscii();
      tokens += 1;
    }
  }
  flushAscii();
  return tokens;
}

function measureEpisodeBudget(events, episodeId, opts = {}) {
  if (!Array.isArray(events)) throw new Error('events must be an array');
  if (typeof episodeId !== 'string' || !ULID_RE.test(episodeId)) {
    throw new Error('episodeId must be a ULID');
  }
  const now = opts.now === undefined ? new Date() : opts.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('opts.now must be a valid Date');
  const estimateTokens = opts.estimateTokens || estimateGroupTextTokens;
  if (typeof estimateTokens !== 'function') throw new Error('opts.estimateTokens must be a function');

  const episodeEvents = events
    .filter((event) => event && event.episodeId === episodeId)
    .slice()
    .sort((left, right) => String(left.id).localeCompare(String(right.id), 'en'));
  const budgetEvents = episodeEvents.filter((event) => !(
    event.kind === 'control' && NON_BUDGET_CONTROL_TYPES.has(event.control?.type)
  ));
  let consecutiveAgentMessages = 0;
  let maxConsecutiveAgentMessages = 0;
  let agentMessages = 0;
  let outputTokensEstimated = 0;
  let pausedBy = null;
  const modelRuns = new Set();

  for (const event of episodeEvents) {
    if (event.kind === 'control' && event.control?.type === 'episode_paused') pausedBy = event.id;
    if (event.kind !== 'message') continue;
    if (AGENT_PARTICIPANTS.has(event.author)) {
      agentMessages += 1;
      consecutiveAgentMessages += 1;
      maxConsecutiveAgentMessages = Math.max(maxConsecutiveAgentMessages, consecutiveAgentMessages);
      const estimated = Number(estimateTokens(event.text || ''));
      if (!Number.isFinite(estimated) || estimated < 0) {
        throw new Error('token estimator must return a non-negative finite number');
      }
      outputTokensEstimated += Math.ceil(estimated);
      const capturedRunId = event.provenance?.type === CAPTURED_REPLY_PROVENANCE_TYPE
        ? event.provenance.runId
        : null;
      const capturedSessionId = event.provenance?.type === CAPTURED_REPLY_PROVENANCE_TYPE
        ? event.provenance.sessionId
        : null;
      modelRuns.add(capturedRunId
        ? `run:${capturedSessionId || 'unknown-session'}:${capturedRunId}`
        : `event:${event.id}`);
    } else if (event.author === HUMAN_PARTICIPANT) {
      consecutiveAgentMessages = 0;
    }
  }

  const firstEvent = budgetEvents[0] || null;
  const lastEvent = budgetEvents[budgetEvents.length - 1] || null;
  const startedAtMs = firstEvent ? new Date(firstEvent.at).getTime() : null;
  if (startedAtMs !== null && Number.isNaN(startedAtMs)) throw new Error('episode contains an invalid timestamp');
  const wallClockMs = startedAtMs === null ? 0 : Math.max(0, now.getTime() - startedAtMs);
  return {
    episodeId,
    firstEventId: firstEvent?.id || null,
    lastEventId: lastEvent?.id || null,
    startedAt: firstEvent?.at || null,
    lastEventAt: lastEvent?.at || null,
    wallClockMs,
    consecutiveAgentMessages,
    maxConsecutiveAgentMessages,
    agentMessages,
    outputTokensEstimated,
    modelRuns: modelRuns.size,
    modelRunsScope: 'reply-producing',
    paused: pausedBy !== null,
    pausedBy,
  };
}

function getEpisodeBudget(roomId, episodeId, opts = {}) {
  return withRoomLock(roomId, opts, () => {
    const events = readAllEventsLocked(roomId, opts);
    return measureEpisodeBudget(events, episodeId, opts);
  });
}

function readAfter(roomId, options = {}) {
  const opts = options || {};
  return withRoomLock(roomId, opts, () => {
    const events = readAllEventsLocked(roomId, opts);
    const after = opts.after === undefined ? null : opts.after;
    if (after !== null && (typeof after !== 'string' || !ULID_RE.test(after))) {
      throw new Error('after must be a ULID or null');
    }
    const numericLimit = opts.limit === undefined ? DEFAULT_READ_LIMIT : Number(opts.limit);
    if (!Number.isSafeInteger(numericLimit) || numericLimit < 1 || numericLimit > MAX_READ_LIMIT) {
      throw new Error(`limit must be an integer between 1 and ${MAX_READ_LIMIT}`);
    }
    const kinds = opts.kind === undefined || opts.kind === null
      ? null
      : new Set(Array.isArray(opts.kind) ? opts.kind : [opts.kind]);
    if (kinds) {
      for (const kind of kinds) {
        if (kind !== 'message' && kind !== 'control') throw new Error(`Invalid event kind filter: ${kind}`);
      }
    }
    return events
      .filter((event) => after === null || event.id > after)
      .filter((event) => !kinds || kinds.has(event.kind))
      .slice(0, numericLimit);
  });
}

function defaultCursors() {
  return Object.fromEntries([...AGENT_PARTICIPANTS].map((who) => [
    who, { contextThrough: null, memoryThrough: null },
  ]));
}

function readCursorsLocked(roomId, opts = {}) {
  const filePath = cursorsFilePath(roomId, opts);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return defaultCursors();
    throw new Error(`Could not read group cursors: ${error.message}`);
  }
  const output = defaultCursors();
  for (const who of AGENT_PARTICIPANTS) {
    for (const field of CURSOR_FIELDS) {
      const value = parsed?.[who]?.[field] ?? null;
      assertUlidOrNull(value, `${who}.${field}`);
      output[who][field] = value;
    }
  }
  return output;
}

function writeCursorsLocked(roomId, cursors, opts = {}) {
  atomicWrite(cursorsFilePath(roomId, opts), `${JSON.stringify(cursors, null, 2)}\n`);
}

function getCursors(roomId, opts = {}) {
  return withRoomLock(roomId, opts, () => readCursorsLocked(roomId, opts));
}

function defaultDeliveryAttemptLedger() {
  return { v: 1, attempts: [] };
}

function validateDeliveryAttempt(attempt, index) {
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
    throw new Error(`delivery attempt ${index} must be an object`);
  }
  if (attempt.v !== 1) throw new Error(`Unsupported delivery attempt version at index ${index}`);
  if (typeof attempt.attemptId !== 'string' || !ULID_RE.test(attempt.attemptId)) {
    throw new Error(`delivery attempt ${index} has an invalid attemptId`);
  }
  if (!AGENT_PARTICIPANTS.has(attempt.who)) {
    throw new Error(`delivery attempt ${attempt.attemptId} has an invalid owner`);
  }
  assertUlidOrNull(attempt.fromExclusive, `delivery attempt ${attempt.attemptId}.fromExclusive`);
  if (typeof attempt.through !== 'string' || !ULID_RE.test(attempt.through)) {
    throw new Error(`delivery attempt ${attempt.attemptId}.through must be a ULID`);
  }
  assertString(attempt.sessionId, `delivery attempt ${attempt.attemptId}.sessionId`, { maxLength: 256 });
  assertString(attempt.runId, `delivery attempt ${attempt.attemptId}.runId`, { maxLength: 256 });
  if (!DELIVERY_ATTEMPT_STATUSES.has(attempt.status)) {
    throw new Error(`delivery attempt ${attempt.attemptId} has an invalid status`);
  }
  assertIsoTimestamp(attempt.startedAt, `delivery attempt ${attempt.attemptId}.startedAt`);
  for (const field of ['committedAt', 'failedAt']) {
    if (attempt[field] !== null) assertIsoTimestamp(attempt[field], `delivery attempt ${attempt.attemptId}.${field}`);
  }
  if (attempt.reason !== null) {
    assertString(attempt.reason, `delivery attempt ${attempt.attemptId}.reason`, { allowEmpty: true, maxLength: 10_000 });
  }
  if (attempt.status === 'pending' && (attempt.committedAt !== null || attempt.failedAt !== null)) {
    throw new Error(`pending delivery attempt ${attempt.attemptId} cannot have a terminal timestamp`);
  }
  if (attempt.status === 'committed' && (attempt.committedAt === null || attempt.failedAt !== null)) {
    throw new Error(`committed delivery attempt ${attempt.attemptId} has inconsistent timestamps`);
  }
  if (attempt.status === 'failed' && (attempt.failedAt === null || attempt.committedAt !== null)) {
    throw new Error(`failed delivery attempt ${attempt.attemptId} has inconsistent timestamps`);
  }
  if (attempt.confirmation !== null) {
    if (!attempt.confirmation || typeof attempt.confirmation !== 'object' || Array.isArray(attempt.confirmation)) {
      throw new Error(`delivery attempt ${attempt.attemptId}.confirmation must be an object or null`);
    }
    if (attempt.confirmation.type !== DELIVERY_CONFIRMATION_TYPE) {
      throw new Error(`delivery attempt ${attempt.attemptId} has an invalid confirmation type`);
    }
    assertIsoTimestamp(attempt.confirmation.at, `delivery attempt ${attempt.attemptId}.confirmation.at`);
    if (attempt.confirmation.runtimeEventType !== null) {
      assertString(attempt.confirmation.runtimeEventType,
        `delivery attempt ${attempt.attemptId}.confirmation.runtimeEventType`, { maxLength: 128 });
    }
    if (attempt.confirmation.runtimeEventId !== null) {
      assertString(attempt.confirmation.runtimeEventId,
        `delivery attempt ${attempt.attemptId}.confirmation.runtimeEventId`, { maxLength: 256 });
    }
  }
  if (attempt.status === 'committed' && attempt.confirmation === null) {
    throw new Error(`committed delivery attempt ${attempt.attemptId} requires confirmation`);
  }
  if (attempt.status !== 'committed' && attempt.confirmation !== null) {
    throw new Error(`non-committed delivery attempt ${attempt.attemptId} cannot have confirmation`);
  }
  return attempt;
}

function readDeliveryAttemptLedgerLocked(roomId, opts = {}) {
  const filePath = deliveryAttemptsFilePath(roomId, opts);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return defaultDeliveryAttemptLedger();
    throw new Error(`Could not read delivery attempts: ${error.message}`);
  }
  if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.attempts)) {
    throw new Error('Malformed delivery attempt ledger');
  }
  const seenIds = new Set();
  const seenRuns = new Set();
  const pendingOwners = new Set();
  for (let index = 0; index < parsed.attempts.length; index += 1) {
    const attempt = validateDeliveryAttempt(parsed.attempts[index], index);
    if (seenIds.has(attempt.attemptId)) throw new Error(`Duplicate delivery attempt id: ${attempt.attemptId}`);
    seenIds.add(attempt.attemptId);
    const runKey = `${attempt.who}\0${attempt.sessionId}\0${attempt.runId}`;
    if (seenRuns.has(runKey)) throw new Error(`Duplicate delivery runtime identity: ${attempt.attemptId}`);
    seenRuns.add(runKey);
    if (attempt.status === 'pending') {
      if (pendingOwners.has(attempt.who)) throw new Error(`Multiple pending deliveries for ${attempt.who}`);
      pendingOwners.add(attempt.who);
    }
  }
  parsed.attempts.sort((left, right) => left.attemptId.localeCompare(right.attemptId, 'en'));
  return parsed;
}

function writeDeliveryAttemptLedgerLocked(roomId, ledger, opts = {}) {
  atomicWrite(deliveryAttemptsFilePath(roomId, opts), `${JSON.stringify(ledger, null, 2)}\n`);
}

function assertOpaqueRuntimeIdentifier(value, label, maxLength = 256) {
  assertString(value, label, { maxLength });
  const report = { count: 0, types: new Set() };
  if (applyRedactions(value, report) !== value) {
    throw new Error(`${label} must be an opaque identifier, not secret-bearing content`);
  }
}

function eventPositions(events) {
  return new Map(events.map((event, index) => [event.id, index]));
}

function compareEventBoundaries(left, right, positions) {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (!positions.has(left)) throw new Error(`Delivery boundary event not found: ${left}`);
  if (!positions.has(right)) throw new Error(`Delivery boundary event not found: ${right}`);
  return positions.get(left) - positions.get(right);
}

function sameDeliveryRequest(attempt, request) {
  return attempt.who === request.who
    && attempt.fromExclusive === request.fromExclusive
    && attempt.through === request.through
    && attempt.sessionId === request.sessionId
    && attempt.runId === request.runId;
}

function beginDelivery(roomId, request, opts = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('delivery request must be an object');
  }
  if (!AGENT_PARTICIPANTS.has(request.who)) throw new Error(`Invalid delivery owner: ${request.who}`);
  if (!Object.prototype.hasOwnProperty.call(request, 'fromExclusive')) {
    throw new Error('delivery request must include fromExclusive, including null for the first delivery');
  }
  assertUlidOrNull(request.fromExclusive, 'delivery.fromExclusive');
  if (typeof request.through !== 'string' || !ULID_RE.test(request.through)) {
    throw new Error('delivery.through must be a ULID');
  }
  assertOpaqueRuntimeIdentifier(request.sessionId, 'delivery.sessionId');
  assertOpaqueRuntimeIdentifier(request.runId, 'delivery.runId');
  if (request.attemptId !== undefined
    && (typeof request.attemptId !== 'string' || !ULID_RE.test(request.attemptId))) {
    throw new Error('delivery.attemptId must be a ULID');
  }

  return withRoomLock(roomId, opts, () => {
    const events = readAllEventsLocked(roomId, opts);
    const positions = eventPositions(events);
    if (!positions.has(request.through)) throw new Error(`Delivery through event not found: ${request.through}`);
    if (request.fromExclusive !== null && !positions.has(request.fromExclusive)) {
      throw new Error(`Delivery fromExclusive event not found: ${request.fromExclusive}`);
    }
    if (compareEventBoundaries(request.fromExclusive, request.through, positions) >= 0) {
      throw new Error('delivery.through must be after fromExclusive');
    }

    const ledger = readDeliveryAttemptLedgerLocked(roomId, opts);
    const byAttemptId = request.attemptId
      ? ledger.attempts.find((attempt) => attempt.attemptId === request.attemptId)
      : null;
    const byRun = ledger.attempts.find((attempt) => attempt.who === request.who
      && attempt.sessionId === request.sessionId && attempt.runId === request.runId) || null;
    if (request.attemptId && byRun && byRun.attemptId !== request.attemptId) {
      throw new Error('delivery attemptId conflicts with the existing runtime identity');
    }
    const existing = byAttemptId || byRun;
    if (byAttemptId && byRun && byAttemptId.attemptId !== byRun.attemptId) {
      throw new Error('delivery attemptId and runtime identity refer to different attempts');
    }
    if (existing) {
      if (!sameDeliveryRequest(existing, request)) {
        throw new Error(`Idempotency conflict for delivery attempt: ${existing.attemptId}`);
      }
      return existing;
    }
    const pending = ledger.attempts.find((attempt) => attempt.who === request.who && attempt.status === 'pending');
    if (pending) throw new Error(`Delivery already pending for ${request.who}: ${pending.attemptId}`);

    const cursors = readCursorsLocked(roomId, opts);
    if (cursors[request.who].contextThrough !== request.fromExclusive) {
      throw new Error(`delivery.fromExclusive does not match ${request.who}.contextThrough`);
    }
    const now = opts.now instanceof Date ? opts.now : new Date();
    if (Number.isNaN(now.getTime())) throw new Error('opts.now must be a valid Date');
    const previousAttemptId = ledger.attempts.length
      ? ledger.attempts[ledger.attempts.length - 1].attemptId
      : null;
    const attempt = {
      v: 1,
      attemptId: request.attemptId || nextMonotonicUlid(previousAttemptId, now.getTime()),
      who: request.who,
      fromExclusive: request.fromExclusive,
      through: request.through,
      sessionId: request.sessionId,
      runId: request.runId,
      status: 'pending',
      startedAt: localIso(now),
      committedAt: null,
      failedAt: null,
      reason: null,
      confirmation: null,
    };
    if (ledger.attempts.some((item) => item.attemptId === attempt.attemptId)) {
      throw new Error(`Duplicate delivery attempt id: ${attempt.attemptId}`);
    }
    ledger.attempts.push(attempt);
    ledger.attempts.sort((left, right) => left.attemptId.localeCompare(right.attemptId, 'en'));
    writeDeliveryAttemptLedgerLocked(roomId, ledger, opts);
    return attempt;
  });
}

function normalizeDeliveryConfirmation(evidence, now) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('delivery confirmation evidence must be an object');
  }
  if (evidence.type !== DELIVERY_CONFIRMATION_TYPE) {
    throw new Error(`delivery confirmation type must be ${DELIVERY_CONFIRMATION_TYPE}`);
  }
  const runtimeEventType = evidence.runtimeEventType === undefined ? null : evidence.runtimeEventType;
  const runtimeEventId = evidence.runtimeEventId === undefined ? null : evidence.runtimeEventId;
  if (runtimeEventType !== null) assertOpaqueRuntimeIdentifier(runtimeEventType, 'evidence.runtimeEventType', 128);
  if (runtimeEventId !== null) assertOpaqueRuntimeIdentifier(runtimeEventId, 'evidence.runtimeEventId');
  const at = evidence.at || localIso(now);
  assertIsoTimestamp(at, 'evidence.at');
  return {
    type: DELIVERY_CONFIRMATION_TYPE,
    runtimeEventType,
    runtimeEventId,
    at,
    recovered: false,
  };
}

function commitDelivery(roomId, attemptId, evidence, opts = {}) {
  if (typeof attemptId !== 'string' || !ULID_RE.test(attemptId)) throw new Error('attemptId must be a ULID');
  const now = opts.now instanceof Date ? opts.now : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('opts.now must be a valid Date');
  const confirmation = normalizeDeliveryConfirmation(evidence, now);
  return withRoomLock(roomId, opts, () => {
    const events = readAllEventsLocked(roomId, opts);
    const positions = eventPositions(events);
    const ledger = readDeliveryAttemptLedgerLocked(roomId, opts);
    const attempt = ledger.attempts.find((item) => item.attemptId === attemptId);
    if (!attempt) throw new Error(`Delivery attempt not found: ${attemptId}`);
    if (attempt.status === 'failed') throw new Error(`Cannot commit failed delivery attempt: ${attemptId}`);
    const cursors = readCursorsLocked(roomId, opts);
    const current = cursors[attempt.who].contextThrough;
    if (attempt.status === 'committed') {
      if (compareEventBoundaries(current, attempt.through, positions) < 0) {
        if (current !== attempt.fromExclusive) throw new Error(`Committed delivery cursor is inconsistent: ${attemptId}`);
        cursors[attempt.who].contextThrough = attempt.through;
        writeCursorsLocked(roomId, cursors, opts);
      }
      return attempt;
    }
    if (current !== attempt.fromExclusive && current !== attempt.through) {
      throw new Error(`Delivery cursor changed while attempt was pending: ${attemptId}`);
    }

    // Write the committed boundary first. If the process dies before the ledger write,
    // recoverDeliveryAttempts() recognizes current === through and repairs the attempt.
    if (current === attempt.fromExclusive) {
      cursors[attempt.who].contextThrough = attempt.through;
      writeCursorsLocked(roomId, cursors, opts);
    }
    attempt.status = 'committed';
    attempt.committedAt = localIso(now);
    attempt.confirmation = confirmation;
    writeDeliveryAttemptLedgerLocked(roomId, ledger, opts);
    return attempt;
  });
}

function redactFailureReason(reason) {
  assertString(reason, 'delivery failure reason', { maxLength: 10_000 });
  const report = { count: 0, types: new Set() };
  const text = applyRedactions(reason, report);
  return {
    text,
    redaction: report.count > 0 ? {
      applied: true,
      count: report.count,
      types: Array.from(report.types).sort(),
    } : null,
  };
}

function failDelivery(roomId, attemptId, reason, opts = {}) {
  if (typeof attemptId !== 'string' || !ULID_RE.test(attemptId)) throw new Error('attemptId must be a ULID');
  const failure = redactFailureReason(reason);
  return withRoomLock(roomId, opts, () => {
    const ledger = readDeliveryAttemptLedgerLocked(roomId, opts);
    const attempt = ledger.attempts.find((item) => item.attemptId === attemptId);
    if (!attempt) throw new Error(`Delivery attempt not found: ${attemptId}`);
    if (attempt.status === 'committed') throw new Error(`Cannot fail committed delivery attempt: ${attemptId}`);
    if (attempt.status === 'failed') return attempt;
    const cursors = readCursorsLocked(roomId, opts);
    if (cursors[attempt.who].contextThrough !== attempt.fromExclusive) {
      throw new Error(`Cannot fail delivery after its cursor moved: ${attemptId}`);
    }
    const now = opts.now instanceof Date ? opts.now : new Date();
    if (Number.isNaN(now.getTime())) throw new Error('opts.now must be a valid Date');
    attempt.status = 'failed';
    attempt.failedAt = localIso(now);
    attempt.reason = failure.text;
    if (failure.redaction) attempt.redaction = failure.redaction;
    writeDeliveryAttemptLedgerLocked(roomId, ledger, opts);
    return attempt;
  });
}

function listDeliveryAttempts(roomId, options = {}) {
  const opts = options || {};
  if (opts.who !== undefined && !AGENT_PARTICIPANTS.has(opts.who)) {
    throw new Error(`Invalid delivery attempt owner: ${opts.who}`);
  }
  const statuses = opts.status === undefined || opts.status === null
    ? null
    : new Set(Array.isArray(opts.status) ? opts.status : [opts.status]);
  if (statuses) {
    for (const status of statuses) {
      if (!DELIVERY_ATTEMPT_STATUSES.has(status)) throw new Error(`Invalid delivery attempt status: ${status}`);
    }
  }
  return withRoomLock(roomId, opts, () => readDeliveryAttemptLedgerLocked(roomId, opts).attempts
    .filter((attempt) => opts.who === undefined || attempt.who === opts.who)
    .filter((attempt) => !statuses || statuses.has(attempt.status)));
}

function recoverDeliveryAttempts(roomId, opts = {}) {
  return withRoomLock(roomId, opts, () => {
    const events = readAllEventsLocked(roomId, opts);
    const positions = eventPositions(events);
    const cursors = readCursorsLocked(roomId, opts);
    const ledger = readDeliveryAttemptLedgerLocked(roomId, opts);
    const now = opts.now instanceof Date ? opts.now : new Date();
    if (Number.isNaN(now.getTime())) throw new Error('opts.now must be a valid Date');
    const recovered = { committed: [], failed: [], repairedCursors: [] };
    let cursorsChanged = false;
    let ledgerChanged = false;

    for (const who of AGENT_PARTICIPANTS) {
      const attempts = ledger.attempts.filter((attempt) => attempt.who === who);
      for (const attempt of attempts) {
        const current = cursors[who].contextThrough;
        if (attempt.status === 'committed') {
          if (compareEventBoundaries(current, attempt.through, positions) >= 0) continue;
          if (current !== attempt.fromExclusive) {
            throw new Error(`Cannot repair committed delivery cursor: ${attempt.attemptId}`);
          }
          cursors[who].contextThrough = attempt.through;
          cursorsChanged = true;
          recovered.repairedCursors.push(attempt.attemptId);
          continue;
        }
        if (attempt.status !== 'pending') continue;
        // 宿主重启时，有的投递其实还在跑（比如交给常驻运行时的那一轮）。调用方把它们的
        // attemptId 传进来，这里就不去动 —— 否则一条正在路上的投递会被当成中断、判失败。
        if (Array.isArray(opts.activeAttemptIds) && opts.activeAttemptIds.includes(attempt.attemptId)) continue;
        if (current === attempt.through) {
          attempt.status = 'committed';
          attempt.committedAt = localIso(now);
          attempt.confirmation = {
            type: DELIVERY_CONFIRMATION_TYPE,
            runtimeEventType: null,
            runtimeEventId: null,
            at: localIso(now),
            recovered: true,
          };
          ledgerChanged = true;
          recovered.committed.push(attempt.attemptId);
          continue;
        }
        if (current !== attempt.fromExclusive) {
          throw new Error(`Pending delivery cursor is inconsistent: ${attempt.attemptId}`);
        }
        attempt.status = 'failed';
        attempt.failedAt = localIso(now);
        attempt.reason = 'server-restart-before-delivery-confirmation';
        ledgerChanged = true;
        recovered.failed.push(attempt.attemptId);
      }
    }

    if (cursorsChanged) writeCursorsLocked(roomId, cursors, opts);
    if (ledgerChanged) writeDeliveryAttemptLedgerLocked(roomId, ledger, opts);
    return { attempts: ledger.attempts, cursors, recovered };
  });
}

function advanceCursor(roomId, who, field, eventId, opts = {}) {
  if (!AGENT_PARTICIPANTS.has(who)) throw new Error(`Invalid cursor owner: ${who}`);
  if (!CURSOR_FIELDS.has(field)) throw new Error(`Invalid cursor field: ${field}`);
  if (typeof eventId !== 'string' || !ULID_RE.test(eventId)) throw new Error('eventId must be a ULID');

  return withRoomLock(roomId, opts, () => {
    const events = readAllEventsLocked(roomId, opts);
    const positions = new Map(events.map((event, index) => [event.id, index]));
    if (!positions.has(eventId)) throw new Error(`Cursor event not found: ${eventId}`);
    if (field === 'contextThrough') {
      const pending = readDeliveryAttemptLedgerLocked(roomId, opts).attempts
        .find((attempt) => attempt.who === who && attempt.status === 'pending');
      if (pending) {
        throw new Error(`Cannot advance contextThrough while delivery is pending; commit attempt ${pending.attemptId}`);
      }
    }
    const cursors = readCursorsLocked(roomId, opts);
    const current = cursors[who][field];
    if (current !== null) {
      if (!positions.has(current)) throw new Error(`Current cursor event not found: ${current}`);
      if (positions.get(eventId) < positions.get(current)) throw new Error('Cursor cannot move backwards');
      if (eventId === current) return cursors;
    }
    cursors[who][field] = eventId;
    writeCursorsLocked(roomId, cursors, opts);
    return cursors;
  });
}

function appendExpiredControlLocked(roomId, state, opts, events, now) {
  return appendEventLocked(roomId, {
    kind: 'control',
    author: 'aslan',
    episodeId: state.source.episodeId,
    causedBy: state.source.id,
    idempotencyKey: `handoff:${state.handoff.id}:expired`,
    control: {
      type: 'handoff_expired',
      handoffId: state.handoff.id,
      target: state.handoff.target,
      leaseUntil: null,
      reason: null,
    },
  }, { ...opts, now }, events);
}

function claimHandoff(roomId, handoffId, who, opts = {}) {
  if (typeof handoffId !== 'string' || !ULID_RE.test(handoffId)) throw new Error('handoffId must be a ULID');
  if (!AGENT_PARTICIPANTS.has(who)) throw new Error(`Invalid handoff claimant: ${who}`);
  return withRoomLock(roomId, opts, () => {
    const events = readAllEventsLocked(roomId, opts);
    let state = handoffState(events, handoffId);
    if (!state) throw new Error(`Handoff not found: ${handoffId}`);
    if (state.handoff.target !== who) throw new Error('Only the handoff target may claim it');
    if (state.terminal) {
      if (state.terminal.outcome === 'expired') {
        return { status: 'expired', outcome: 'expired', event: state.terminal.event };
      }
      return { status: 'already-terminal', outcome: state.terminal.outcome, event: state.terminal.event };
    }

    const now = opts.now instanceof Date ? opts.now : new Date();
    const expiresAtMs = new Date(state.handoff.expiresAt).getTime();
    if (expiresAtMs <= now.getTime()) {
      const event = appendExpiredControlLocked(roomId, state, opts, events, now);
      return { status: 'expired', outcome: 'expired', event };
    }

    const latestLeaseMs = state.latestClaim ? new Date(state.latestClaim.control.leaseUntil).getTime() : 0;
    if (latestLeaseMs > now.getTime() && !opts.renew) {
      return { status: 'claimed', claimed: false, claim: state.latestClaim, handoff: state.handoff };
    }

    const leaseMs = Number.isFinite(opts.leaseMs) ? Math.max(1, opts.leaseMs) : DEFAULT_CLAIM_LEASE_MS;
    const leaseUntil = new Date(Math.min(expiresAtMs, now.getTime() + leaseMs));
    const claim = appendEventLocked(roomId, {
      kind: 'control',
      author: who,
      episodeId: state.source.episodeId,
      causedBy: state.source.id,
      idempotencyKey: `handoff:${handoffId}:claim:${who}:${leaseUntil.toISOString()}`,
      control: {
        type: 'handoff_claimed',
        handoffId,
        target: who,
        leaseUntil: localIso(leaseUntil),
        reason: null,
      },
    }, { ...opts, now }, events);
    state = handoffState(events, handoffId);
    return { status: 'claimed', claimed: true, claim, handoff: state.handoff };
  });
}

function declineHandoff(roomId, handoffId, who, reason = null, opts = {}) {
  if (typeof handoffId !== 'string' || !ULID_RE.test(handoffId)) throw new Error('handoffId must be a ULID');
  if (!AGENT_PARTICIPANTS.has(who)) throw new Error(`Invalid handoff target: ${who}`);
  if (reason !== null && typeof reason !== 'string') throw new Error('reason must be a string or null');
  return withRoomLock(roomId, opts, () => {
    const events = readAllEventsLocked(roomId, opts);
    const state = handoffState(events, handoffId);
    if (!state) throw new Error(`Handoff not found: ${handoffId}`);
    if (state.handoff.target !== who) throw new Error('Only the handoff target may decline it');
    if (state.terminal) {
      if (state.terminal.outcome === 'expired') {
        return { status: 'expired', outcome: 'expired', event: state.terminal.event };
      }
      return { status: 'already-terminal', outcome: state.terminal.outcome, event: state.terminal.event };
    }

    const now = opts.now instanceof Date ? opts.now : new Date();
    if (new Date(state.handoff.expiresAt).getTime() <= now.getTime()) {
      const event = appendExpiredControlLocked(roomId, state, opts, events, now);
      return { status: 'expired', outcome: 'expired', event };
    }

    const event = appendEventLocked(roomId, {
      kind: 'control',
      author: who,
      episodeId: state.source.episodeId,
      causedBy: state.source.id,
      idempotencyKey: `handoff:${handoffId}:declined:${who}`,
      control: {
        type: 'handoff_declined',
        handoffId,
        target: who,
        leaseUntil: null,
        reason,
      },
    }, { ...opts, now }, events);
    return { status: 'declined', outcome: 'declined', event };
  });
}

function render(roomId, date, opts = {}) {
  return withRoomLock(roomId, opts, () => renderDateLocked(roomId, date, opts));
}

function usage() {
  return [
    'Usage:',
    '  node lib/group.js append ROOM                # event JSON from stdin',
    '  node lib/group.js read ROOM [--after ID] [--limit N] [--kind message|control]',
    '  node lib/group.js cursors ROOM',
    '  node lib/group.js advance-cursor ROOM WHO FIELD EVENT_ID',
    '  node lib/group.js claim-handoff ROOM HANDOFF_ID WHO',
    '  node lib/group.js decline-handoff ROOM HANDOFF_ID WHO [--reason TEXT]',
    '  node lib/group.js render ROOM YYYY-MM-DD',
  ].join('\n');
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (index + 1 >= args.length) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

function readStdin() {
  return new Promise((resolve, reject) => {
    process.stdin.setEncoding('utf8');
    let body = '';
    process.stdin.on('data', (chunk) => { body += chunk; });
    process.stdin.on('end', () => resolve(body));
    process.stdin.on('error', reject);
  });
}

async function main(argv = process.argv.slice(2)) {
  const [command, roomId, ...args] = argv;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!roomId) throw new Error('ROOM is required');

  let result;
  if (command === 'append') {
    if (process.stdin.isTTY) throw new Error('append expects event JSON on stdin');
    result = appendEvent(roomId, JSON.parse(await readStdin()));
  } else if (command === 'read') {
    const after = optionValue(args, '--after') ?? null;
    const rawLimit = optionValue(args, '--limit');
    const kind = optionValue(args, '--kind');
    result = readAfter(roomId, {
      after,
      limit: rawLimit === undefined ? DEFAULT_READ_LIMIT : Number(rawLimit),
      kind,
    });
  } else if (command === 'cursors') {
    result = getCursors(roomId);
  } else if (command === 'advance-cursor') {
    if (args.length < 3) throw new Error('advance-cursor requires WHO FIELD EVENT_ID');
    result = advanceCursor(roomId, args[0], args[1], args[2]);
  } else if (command === 'claim-handoff') {
    if (args.length < 2) throw new Error('claim-handoff requires HANDOFF_ID WHO');
    result = claimHandoff(roomId, args[0], args[1]);
  } else if (command === 'decline-handoff') {
    if (args.length < 2) throw new Error('decline-handoff requires HANDOFF_ID WHO');
    result = declineHandoff(roomId, args[0], args[1], optionValue(args, '--reason') ?? null);
  } else if (command === 'render') {
    if (args.length < 1) throw new Error('render requires YYYY-MM-DD');
    result = render(roomId, args[0]);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = {
  appendEvent,
  appendAgentReply,
  beginDelivery,
  commitDelivery,
  failDelivery,
  listDeliveryAttempts,
  recoverDeliveryAttempts,
  readAfter,
  getCursors,
  advanceCursor,
  claimHandoff,
  declineHandoff,
  estimateGroupTextTokens,
  measureEpisodeBudget,
  getEpisodeBudget,
  render,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`group: ${error.message}\n`);
    process.exitCode = 1;
  });
}
