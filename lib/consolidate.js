#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getParticipantConfig } = require('./participant-config');

const SCHEMA_VERSION = 1;
const DEFAULT_CONFIG_DIR = process.env.ASLAN_CONFIG_DIR || path.join(__dirname, '..', 'config');
const OWNERS = new Set(getParticipantConfig().agentIds);
const SOURCE_KINDS = new Set(['session', 'group']);
const TRIGGER_REASONS = new Set(['soft', 'hard', 'semantic', 'manual', 'crossDay']);
const BRANCH_NAMES = new Set(['diary', 'memory']);
const BRANCH_STATUSES = new Set(['pending', 'written', 'none', 'skipped', 'failed']);
const TERMINAL_BRANCH_STATUSES = new Set(['written', 'none', 'skipped']);
const TERMINAL_RECORD_STATUSES = new Set(['complete', 'abandoned']);
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const LEDGER_FILE_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,255})\.json$/u;
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 60_000;

function cloneJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('value must be an object');
  }
  return JSON.parse(JSON.stringify(value));
}

function sleep(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function nowDate(opts = {}) {
  const now = opts.now instanceof Date ? new Date(opts.now.getTime()) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('opts.now must be a valid Date');
  return now;
}

function nowIso(opts = {}) {
  return nowDate(opts).toISOString();
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertString(value, label, options = {}) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (!options.allowEmpty && !value.trim()) throw new Error(`${label} must not be empty`);
  if (options.maxLength && value.length > options.maxLength) {
    throw new Error(`${label} exceeds ${options.maxLength} characters`);
  }
  return value.trim();
}

function assertSafeId(value, label) {
  const id = assertString(value, label, { maxLength: 256 });
  if (!SAFE_ID_RE.test(id)) throw new Error(`${label} contains unsupported characters`);
  return id;
}

function assertOwner(owner) {
  if (!OWNERS.has(owner)) throw new Error(`Invalid consolidation owner: ${owner}`);
  return owner;
}

function assertFiniteInteger(value, label, options = {}) {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  if (options.min !== undefined && value < options.min) {
    throw new Error(`${label} must be at least ${options.min}`);
  }
  return value;
}

function sanitizeText(value, label, options = {}) {
  const input = assertString(value, label, { allowEmpty: options.allowEmpty, maxLength: options.maxLength || 4_000 });
  let text = input;
  const types = new Set();
  const replace = (type, expression) => {
    text = text.replace(expression, () => {
      types.add(type);
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
  replace('bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi);
  return { text, redactedTypes: [...types].sort() };
}

function consolidationsDir(opts = {}) {
  if (opts.consolidationsDir) return path.resolve(opts.consolidationsDir);
  return path.join(path.resolve(opts.configDir || DEFAULT_CONFIG_DIR), 'consolidations');
}

function ledgerPath(consolidationId, opts = {}) {
  return path.join(consolidationsDir(opts), `${assertSafeId(consolidationId, 'consolidationId')}.json`);
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

function acquireLock(opts = {}) {
  const dir = consolidationsDir(opts);
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, '.consolidations.lock');
  const token = crypto.randomBytes(16).toString('hex');
  const timeoutMs = Number.isFinite(opts.lockTimeoutMs) ? Math.max(0, opts.lockTimeoutMs) : LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify({
          pid: process.pid,
          token,
          createdAt: new Date().toISOString(),
        }), 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      return { lockPath, token };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      if (removeAbandonedLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for consolidation lock: ${lockPath}`);
      sleep(LOCK_WAIT_MS);
    }
  }
}

function releaseLock(lock) {
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

function withLock(opts, callback) {
  const lock = acquireLock(opts);
  let result;
  let callbackError;
  try {
    result = callback();
  } catch (error) {
    callbackError = error;
  }
  try {
    releaseLock(lock);
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

function normalizeSource(source) {
  assertPlainObject(source, 'source');
  if (!SOURCE_KINDS.has(source.kind)) throw new Error(`Invalid source kind: ${source.kind}`);
  const normalized = {
    kind: source.kind,
    fromEvent: assertSafeId(source.fromEvent, 'source.fromEvent'),
    throughEvent: assertSafeId(source.throughEvent, 'source.throughEvent'),
  };
  if (source.kind === 'session') {
    normalized.sessionId = assertSafeId(source.sessionId, 'source.sessionId');
  } else {
    normalized.room = assertSafeId(source.room, 'source.room');
    normalized.episodeId = assertSafeId(source.episodeId, 'source.episodeId');
  }
  return normalized;
}

function normalizeTrigger(trigger) {
  assertPlainObject(trigger, 'trigger');
  if (!TRIGGER_REASONS.has(trigger.reason)) throw new Error(`Invalid trigger reason: ${trigger.reason}`);
  const contextTokens = assertFiniteInteger(trigger.contextTokens, 'trigger.contextTokens', { min: 0 });
  const contextWindowTokens = assertFiniteInteger(
    trigger.contextWindowTokens,
    'trigger.contextWindowTokens',
    { min: 1 }
  );
  return {
    reason: trigger.reason,
    contextTokens,
    contextWindowTokens,
    contextRatio: Number((contextTokens / contextWindowTokens).toFixed(6)),
  };
}

function sourceKey(owner, source) {
  return `sha256:${crypto.createHash('sha256')
    .update(JSON.stringify({ owner, source }))
    .digest('hex')}`;
}

function emptyBranch() {
  return {
    status: 'pending',
    entryId: null,
    ids: [],
    reason: null,
    redactedTypes: [],
    updatedAt: null,
  };
}

function emptyAttempt() {
  return {
    state: 'idle',
    number: 0,
    attemptId: null,
    workerId: null,
    startedAt: null,
    endedAt: null,
    lastError: null,
    redactedTypes: [],
  };
}

function isTerminalBranchStatus(status) {
  return TERMINAL_BRANCH_STATUSES.has(status);
}

function isAbandoned(record) {
  return typeof record.abandonedAt === 'string';
}

function isTerminalRecordStatus(status) {
  return TERMINAL_RECORD_STATUSES.has(status);
}

function deriveStatus(record) {
  if (isAbandoned(record)) return 'abandoned';
  const diaryTerminal = isTerminalBranchStatus(record.diary.status);
  const memoryTerminal = isTerminalBranchStatus(record.memory.status);
  if (diaryTerminal && memoryTerminal) return 'complete';
  if (record.diary.status === 'failed' || record.memory.status === 'failed'
    || record.attempt.state === 'failed') return 'failed';
  if (diaryTerminal || memoryTerminal) return 'partial';
  return 'pending';
}

function refreshDerived(record, at) {
  const status = deriveStatus(record);
  record.status = status;
  record.canSplit = status === 'complete';
  if (status === 'abandoned') {
    record.completedAt = null;
    record.attempt.state = 'abandoned';
    record.attempt.endedAt = record.abandonedAt || at;
    record.attempt.lastError = null;
    record.attempt.redactedTypes = [];
  } else if (record.canSplit) {
    record.completedAt = record.completedAt || at;
    record.attempt.state = 'complete';
    record.attempt.endedAt = record.attempt.endedAt || at;
    record.attempt.lastError = null;
    record.attempt.redactedTypes = [];
  } else {
    record.completedAt = null;
  }
  return record;
}

function validateBranch(branch, name) {
  assertPlainObject(branch, name);
  if (!BRANCH_STATUSES.has(branch.status)) throw new Error(`Invalid ${name}.status: ${branch.status}`);
  if (branch.entryId !== null) assertSafeId(branch.entryId, `${name}.entryId`);
  if (!Array.isArray(branch.ids)) throw new Error(`${name}.ids must be an array`);
  for (const id of branch.ids) assertSafeId(id, `${name}.ids[]`);
  if (branch.reason !== null && typeof branch.reason !== 'string') throw new Error(`${name}.reason must be a string or null`);
  if (!Array.isArray(branch.redactedTypes)) throw new Error(`${name}.redactedTypes must be an array`);
  if (branch.updatedAt !== null && Number.isNaN(Date.parse(branch.updatedAt))) {
    throw new Error(`${name}.updatedAt must be an ISO timestamp or null`);
  }
  if (branch.status === 'written') {
    if (name === 'diary' && !branch.entryId) throw new Error('written diary branch requires entryId');
    if (name === 'memory' && branch.ids.length === 0) throw new Error('written memory branch requires ids');
  } else if (branch.entryId !== null || branch.ids.length !== 0) {
    throw new Error(`${name} output ids are only valid for written status`);
  }
  if ((branch.status === 'skipped' || branch.status === 'failed') && !branch.reason) {
    throw new Error(`${name}.${branch.status} requires reason`);
  }
  if (name === 'diary' && branch.ids.length !== 0) throw new Error('diary branch cannot contain memory ids');
  if (name === 'memory' && branch.entryId !== null) throw new Error('memory branch cannot contain entryId');
}

function validateAttempt(attempt) {
  assertPlainObject(attempt, 'attempt');
  if (!new Set(['idle', 'running', 'failed', 'interrupted', 'complete', 'abandoned']).has(attempt.state)) {
    throw new Error(`Invalid attempt.state: ${attempt.state}`);
  }
  assertFiniteInteger(attempt.number, 'attempt.number', { min: 0 });
  for (const field of ['attemptId', 'workerId']) {
    if (attempt[field] !== null) assertSafeId(attempt[field], `attempt.${field}`);
  }
  for (const field of ['startedAt', 'endedAt']) {
    if (attempt[field] !== null && Number.isNaN(Date.parse(attempt[field]))) {
      throw new Error(`attempt.${field} must be an ISO timestamp or null`);
    }
  }
  if (attempt.lastError !== null && typeof attempt.lastError !== 'string') {
    throw new Error('attempt.lastError must be a string or null');
  }
  if (!Array.isArray(attempt.redactedTypes)) throw new Error('attempt.redactedTypes must be an array');
}

function validateAbandonment(record) {
  const fields = [
    record.abandonedAt,
    record.abandonedBy,
    record.abandonReasonCode,
    record.abandonReason,
    record.abandonRedactedTypes,
  ];
  const isLegacyRecord = fields.every((value) => value === undefined);
  if (isLegacyRecord) return false;

  if (record.abandonedAt === null) {
    if (record.abandonedBy !== null || record.abandonReasonCode !== null || record.abandonReason !== null) {
      throw new Error('A non-abandoned consolidation cannot contain abandonment details');
    }
    if (!Array.isArray(record.abandonRedactedTypes) || record.abandonRedactedTypes.length !== 0) {
      throw new Error('A non-abandoned consolidation cannot contain abandonment redaction types');
    }
    return false;
  }

  if (typeof record.abandonedAt !== 'string' || Number.isNaN(Date.parse(record.abandonedAt))) {
    throw new Error('abandonedAt must be an ISO timestamp or null');
  }
  assertSafeId(record.abandonedBy, 'abandonedBy');
  assertSafeId(record.abandonReasonCode, 'abandonReasonCode');
  assertString(record.abandonReason, 'abandonReason', { maxLength: 4_000 });
  if (!Array.isArray(record.abandonRedactedTypes)) {
    throw new Error('abandonRedactedTypes must be an array');
  }
  return true;
}

function validateRecord(record, expectedId = null) {
  assertPlainObject(record, 'consolidation');
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported consolidation schema version: ${record.schemaVersion}`);
  }
  const id = assertSafeId(record.consolidationId, 'consolidationId');
  if (expectedId !== null && id !== expectedId) throw new Error(`Ledger id mismatch: ${id} != ${expectedId}`);
  assertOwner(record.owner);
  const normalizedSource = normalizeSource(record.source);
  if (JSON.stringify(normalizedSource) !== JSON.stringify(record.source)) {
    throw new Error('Stored source is not canonical');
  }
  const expectedSourceKey = sourceKey(record.owner, record.source);
  if (record.sourceKey !== expectedSourceKey) throw new Error('Stored sourceKey does not match owner/source');
  const normalizedTrigger = normalizeTrigger(record.trigger);
  if (JSON.stringify(normalizedTrigger) !== JSON.stringify(record.trigger)) {
    throw new Error('Stored trigger is not canonical');
  }
  validateBranch(record.diary, 'diary');
  validateBranch(record.memory, 'memory');
  validateAttempt(record.attempt);
  const abandoned = validateAbandonment(record);
  if (!Array.isArray(record.history)) throw new Error('history must be an array');
  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof record[field] !== 'string' || Number.isNaN(Date.parse(record[field]))) {
      throw new Error(`${field} must be an ISO timestamp`);
    }
  }
  const derived = deriveStatus(record);
  if (record.status !== derived) throw new Error(`Stored status is stale: ${record.status} != ${derived}`);
  if (record.canSplit !== (derived === 'complete')) throw new Error('Stored canSplit is stale');
  if (derived === 'complete') {
    if (typeof record.completedAt !== 'string' || Number.isNaN(Date.parse(record.completedAt))) {
      throw new Error('A complete consolidation requires completedAt');
    }
    if (record.attempt.state !== 'complete') throw new Error('A complete consolidation requires a complete attempt');
  } else if (derived === 'abandoned') {
    if (!abandoned) throw new Error('An abandoned consolidation requires abandonment details');
    if (record.completedAt !== null) throw new Error('An abandoned consolidation cannot have completedAt');
    if (record.attempt.state !== 'abandoned') {
      throw new Error('An abandoned consolidation requires an abandoned attempt');
    }
    if (isTerminalBranchStatus(record.diary.status) && isTerminalBranchStatus(record.memory.status)) {
      throw new Error('A complete consolidation cannot also be abandoned');
    }
  } else {
    if (abandoned) throw new Error('An open consolidation cannot contain abandonment details');
    if (record.completedAt !== null) throw new Error('An open consolidation cannot have completedAt');
    if (record.attempt.state === 'complete') throw new Error('An open consolidation cannot have a complete attempt');
    if (record.attempt.state === 'abandoned') throw new Error('An open consolidation cannot have an abandoned attempt');
  }
  return record;
}

function readRecordFile(filePath, expectedId = null) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error(`Could not read consolidation ledger ${filePath}: ${error.message}`);
  }
  return validateRecord(parsed, expectedId);
}

function writeRecord(record, opts = {}) {
  validateRecord(record, record.consolidationId);
  atomicWrite(ledgerPath(record.consolidationId, opts), `${JSON.stringify(record, null, 2)}\n`);
}

function listRecordsLocked(opts = {}) {
  const dir = consolidationsDir(opts);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const name of names.sort()) {
    const match = LEDGER_FILE_RE.exec(name);
    if (!match) continue;
    const record = readRecordFile(path.join(dir, name), match[1]);
    if (record) records.push(record);
  }
  records.sort((left, right) => (
    String(left.createdAt).localeCompare(String(right.createdAt), 'en')
    || left.consolidationId.localeCompare(right.consolidationId, 'en')
  ));
  return records;
}

function appendHistory(record, at, type, details = {}) {
  record.history.push({ at, type, ...details });
  record.updatedAt = at;
}

function openConsolidation(input, opts = {}) {
  assertPlainObject(input, 'consolidation request');
  const owner = assertOwner(input.owner);
  const source = normalizeSource(input.source);
  const trigger = normalizeTrigger(input.trigger);
  const key = sourceKey(owner, source);

  return withLock(opts, () => {
    const matches = listRecordsLocked(opts).filter((record) => record.sourceKey === key);
    const open = [...matches].reverse().find((record) => !isTerminalRecordStatus(record.status));
    if (open) return cloneJson(open);
    const latest = matches[matches.length - 1];
    if (latest && !opts.forceNew) return cloneJson(latest);

    const at = nowIso(opts);
    const record = {
      schemaVersion: SCHEMA_VERSION,
      consolidationId: crypto.randomUUID(),
      owner,
      source,
      sourceKey: key,
      trigger,
      status: 'pending',
      canSplit: false,
      diary: emptyBranch(),
      memory: emptyBranch(),
      attempt: emptyAttempt(),
      createdAt: at,
      updatedAt: at,
      completedAt: null,
      abandonedAt: null,
      abandonedBy: null,
      abandonReasonCode: null,
      abandonReason: null,
      abandonRedactedTypes: [],
      history: [{ at, type: 'opened' }],
    };
    refreshDerived(record, at);
    writeRecord(record, opts);
    return cloneJson(record);
  });
}

function readConsolidation(consolidationId, opts = {}) {
  const id = assertSafeId(consolidationId, 'consolidationId');
  return withLock(opts, () => {
    const record = readRecordFile(ledgerPath(id, opts), id);
    if (!record) throw new Error(`Consolidation not found: ${id}`);
    return cloneJson(record);
  });
}

function listOpen(owner, opts = {}) {
  if (owner !== null && owner !== undefined) assertOwner(owner);
  return withLock(opts, () => listRecordsLocked(opts)
    .filter((record) => !isTerminalRecordStatus(record.status))
    .filter((record) => owner === null || owner === undefined || record.owner === owner)
    .map(cloneJson));
}

function normalizeBranchUpdate(branchName, update) {
  assertPlainObject(update, 'branch update');
  if (!BRANCH_NAMES.has(branchName)) throw new Error(`Invalid branch: ${branchName}`);
  if (!BRANCH_STATUSES.has(update.status)) throw new Error(`Invalid branch status: ${update.status}`);
  const normalized = {
    status: update.status,
    entryId: null,
    ids: [],
    reason: null,
    redactedTypes: [],
  };
  if (update.reason !== undefined && update.reason !== null) {
    const sanitized = sanitizeText(update.reason, 'branch reason', { maxLength: 4_000 });
    normalized.reason = sanitized.text;
    normalized.redactedTypes = sanitized.redactedTypes;
  }

  if (update.status === 'written') {
    if (branchName === 'diary') {
      normalized.entryId = assertSafeId(update.entryId, 'diary.entryId');
    } else {
      if (!Array.isArray(update.ids) || update.ids.length === 0) {
        throw new Error('memory written status requires at least one id');
      }
      normalized.ids = [...new Set(update.ids.map((id) => assertSafeId(id, 'memory.ids[]')))];
    }
  }
  if ((update.status === 'skipped' || update.status === 'failed') && !normalized.reason) {
    throw new Error(`${update.status} status requires reason`);
  }
  return normalized;
}

function branchMatchesUpdate(branch, update) {
  return branch.status === update.status
    && branch.entryId === update.entryId
    && JSON.stringify(branch.ids) === JSON.stringify(update.ids)
    && branch.reason === update.reason
    && JSON.stringify(branch.redactedTypes) === JSON.stringify(update.redactedTypes);
}

function setBranch(consolidationId, branchName, update, opts = {}) {
  const id = assertSafeId(consolidationId, 'consolidationId');
  const normalized = normalizeBranchUpdate(branchName, update);
  return withLock(opts, () => {
    const record = readRecordFile(ledgerPath(id, opts), id);
    if (!record) throw new Error(`Consolidation not found: ${id}`);
    if (record.status === 'abandoned') throw new Error('An abandoned consolidation cannot be modified');
    const current = record[branchName];
    if (isTerminalBranchStatus(current.status)) {
      if (branchMatchesUpdate(current, normalized)) return cloneJson(record);
      throw new Error(`${branchName} branch is already terminal: ${current.status}`);
    }

    const at = nowIso(opts);
    const previousStatus = current.status;
    record[branchName] = { ...normalized, updatedAt: at };
    if (normalized.status === 'failed') {
      record.attempt.state = 'failed';
      record.attempt.endedAt = at;
      record.attempt.lastError = normalized.reason;
      record.attempt.redactedTypes = normalized.redactedTypes;
    } else if (previousStatus === 'failed' && normalized.status === 'pending'
      && record.attempt.state !== 'running') {
      record.attempt.state = 'idle';
      record.attempt.endedAt = null;
      record.attempt.lastError = null;
      record.attempt.redactedTypes = [];
    }
    appendHistory(record, at, 'branch_set', {
      branch: branchName,
      from: previousStatus,
      to: normalized.status,
      entryId: normalized.entryId,
      ids: normalized.ids,
      reason: normalized.reason,
      redactedTypes: normalized.redactedTypes,
    });
    refreshDerived(record, at);
    writeRecord(record, opts);
    return cloneJson(record);
  });
}

function beginAttempt(consolidationId, details = {}, opts = {}) {
  const id = assertSafeId(consolidationId, 'consolidationId');
  assertPlainObject(details, 'attempt details');
  const workerId = details.workerId === undefined || details.workerId === null
    ? `pid-${process.pid}`
    : assertSafeId(details.workerId, 'attempt.workerId');
  return withLock(opts, () => {
    const record = readRecordFile(ledgerPath(id, opts), id);
    if (!record) throw new Error(`Consolidation not found: ${id}`);
    if (record.status === 'complete') return cloneJson(record);
    if (record.status === 'abandoned') throw new Error('An abandoned consolidation cannot start an attempt');
    if (record.attempt.state === 'running') {
      if (record.attempt.workerId === workerId) return cloneJson(record);
      throw new Error(`Consolidation already has a running attempt: ${record.attempt.attemptId}`);
    }
    const at = nowIso(opts);
    record.attempt = {
      state: 'running',
      number: record.attempt.number + 1,
      attemptId: crypto.randomUUID(),
      workerId,
      startedAt: at,
      endedAt: null,
      lastError: null,
      redactedTypes: [],
    };
    appendHistory(record, at, 'attempt_started', {
      attemptId: record.attempt.attemptId,
      number: record.attempt.number,
      workerId,
    });
    refreshDerived(record, at);
    writeRecord(record, opts);
    return cloneJson(record);
  });
}

function failAttempt(consolidationId, reason, opts = {}) {
  const id = assertSafeId(consolidationId, 'consolidationId');
  const sanitized = sanitizeText(reason, 'attempt failure reason', { maxLength: 4_000 });
  return withLock(opts, () => {
    const record = readRecordFile(ledgerPath(id, opts), id);
    if (!record) throw new Error(`Consolidation not found: ${id}`);
    if (record.status === 'complete') throw new Error('A complete consolidation cannot fail');
    if (record.status === 'abandoned') throw new Error('An abandoned consolidation cannot fail');
    const at = nowIso(opts);
    record.attempt.state = 'failed';
    record.attempt.endedAt = at;
    record.attempt.lastError = sanitized.text;
    record.attempt.redactedTypes = sanitized.redactedTypes;
    appendHistory(record, at, 'attempt_failed', {
      reason: sanitized.text,
      redactedTypes: sanitized.redactedTypes,
    });
    refreshDerived(record, at);
    writeRecord(record, opts);
    return cloneJson(record);
  });
}

function normalizeAbandonment(details) {
  assertPlainObject(details, 'abandonment details');
  const abandonedBy = details.abandonedBy === undefined || details.abandonedBy === null
    ? 'aslan'
    : assertSafeId(details.abandonedBy, 'abandonedBy');
  const abandonReasonCode = assertSafeId(details.reasonCode, 'reasonCode');
  const sanitized = sanitizeText(details.reason, 'abandonment reason', { maxLength: 4_000 });
  return {
    abandonedBy,
    abandonReasonCode,
    abandonReason: sanitized.text,
    abandonRedactedTypes: sanitized.redactedTypes,
  };
}

function abandonmentMatches(record, details) {
  return record.abandonedBy === details.abandonedBy
    && record.abandonReasonCode === details.abandonReasonCode
    && record.abandonReason === details.abandonReason
    && JSON.stringify(record.abandonRedactedTypes) === JSON.stringify(details.abandonRedactedTypes);
}

function abandonConsolidation(consolidationId, details, opts = {}) {
  const id = assertSafeId(consolidationId, 'consolidationId');
  const normalized = normalizeAbandonment(details);
  return withLock(opts, () => {
    const record = readRecordFile(ledgerPath(id, opts), id);
    if (!record) throw new Error(`Consolidation not found: ${id}`);
    if (record.status === 'complete') throw new Error('A complete consolidation cannot be abandoned');
    if (record.status === 'abandoned') {
      if (abandonmentMatches(record, normalized)) return cloneJson(record);
      throw new Error('Consolidation is already abandoned with different details');
    }

    const at = nowIso(opts);
    record.abandonedAt = at;
    record.abandonedBy = normalized.abandonedBy;
    record.abandonReasonCode = normalized.abandonReasonCode;
    record.abandonReason = normalized.abandonReason;
    record.abandonRedactedTypes = normalized.abandonRedactedTypes;
    record.attempt.state = 'abandoned';
    record.attempt.endedAt = at;
    record.attempt.lastError = null;
    record.attempt.redactedTypes = [];
    appendHistory(record, at, 'abandoned', {
      abandonedBy: normalized.abandonedBy,
      reasonCode: normalized.abandonReasonCode,
      reason: normalized.abandonReason,
      redactedTypes: normalized.abandonRedactedTypes,
    });
    refreshDerived(record, at);
    writeRecord(record, opts);
    return cloneJson(record);
  });
}

function recoverInterrupted(opts = {}) {
  const recovery = opts.reason === undefined
    ? { text: 'service restarted before the consolidation attempt completed', redactedTypes: [] }
    : sanitizeText(opts.reason, 'recovery reason', { maxLength: 4_000 });
  return withLock(opts, () => {
    const at = nowIso(opts);
    const recovered = [];
    for (const record of listRecordsLocked(opts)) {
      if (isTerminalRecordStatus(record.status) || record.attempt.state !== 'running') continue;
      record.attempt.state = 'interrupted';
      record.attempt.endedAt = at;
      record.attempt.lastError = recovery.text;
      record.attempt.redactedTypes = recovery.redactedTypes;
      appendHistory(record, at, 'attempt_interrupted', {
        reason: recovery.text,
        redactedTypes: recovery.redactedTypes,
      });
      refreshDerived(record, at);
      writeRecord(record, opts);
      recovered.push(cloneJson(record));
    }
    return recovered;
  });
}

function canSplit(consolidationOrId, opts = {}) {
  if (typeof consolidationOrId === 'string') {
    return readConsolidation(consolidationOrId, opts).canSplit;
  }
  assertPlainObject(consolidationOrId, 'consolidation');
  validateRecord(consolidationOrId, consolidationOrId.consolidationId);
  return deriveStatus(consolidationOrId) === 'complete';
}

function usage() {
  return [
    'Usage:',
    '  node lib/consolidate.js open                         # request JSON from stdin',
    '  node lib/consolidate.js read ID',
    `  node lib/consolidate.js list-open [${[...OWNERS].join('|')}]`,
    '  node lib/consolidate.js set-branch ID diary|memory   # update JSON from stdin',
    '  node lib/consolidate.js begin-attempt ID [--worker ID]',
    '  node lib/consolidate.js fail-attempt ID              # {"reason":"..."} from stdin',
    '  node lib/consolidate.js abandon ID                   # abandonment JSON from stdin',
    '  node lib/consolidate.js recover-interrupted',
    '  node lib/consolidate.js can-split ID',
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

async function readStdinJson() {
  if (process.stdin.isTTY) throw new Error('command expects JSON on stdin');
  const body = await readStdin();
  return JSON.parse(body);
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  let result;
  if (command === 'open') {
    result = openConsolidation(await readStdinJson());
  } else if (command === 'read') {
    if (!args[0]) throw new Error('read requires ID');
    result = readConsolidation(args[0]);
  } else if (command === 'list-open') {
    result = listOpen(args[0] || null);
  } else if (command === 'set-branch') {
    if (!args[0] || !args[1]) throw new Error('set-branch requires ID and diary|memory');
    result = setBranch(args[0], args[1], await readStdinJson());
  } else if (command === 'begin-attempt') {
    if (!args[0]) throw new Error('begin-attempt requires ID');
    result = beginAttempt(args[0], { workerId: optionValue(args, '--worker') });
  } else if (command === 'fail-attempt') {
    if (!args[0]) throw new Error('fail-attempt requires ID');
    const body = await readStdinJson();
    result = failAttempt(args[0], body.reason);
  } else if (command === 'abandon') {
    if (!args[0]) throw new Error('abandon requires ID');
    result = abandonConsolidation(args[0], await readStdinJson());
  } else if (command === 'recover-interrupted') {
    result = recoverInterrupted();
  } else if (command === 'can-split') {
    if (!args[0]) throw new Error('can-split requires ID');
    result = { consolidationId: args[0], canSplit: canSplit(args[0]) };
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = {
  openConsolidation,
  readConsolidation,
  listOpen,
  setBranch,
  beginAttempt,
  failAttempt,
  abandonConsolidation,
  recoverInterrupted,
  canSplit,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`consolidate: ${error.message}\n`);
    process.exitCode = 1;
  });
}
