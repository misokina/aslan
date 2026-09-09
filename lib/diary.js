#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const consolidationStore = require('./consolidate');
const { getParticipantConfig } = require('./participant-config');

const DIARY_ROOT = process.env.ASLAN_DIARY_DIR
  || path.join(process.env.ASLAN_DATA_DIR || path.join(__dirname, '..', 'data'), 'diary');
const DIARY_OWNERS = new Set(getParticipantConfig().agentIds);
const SAFE_CONSOLIDATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
// Keep this exactly aligned with server.js' diary anchor/parser contract.
const DIARY_ENTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const DIARY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/u;
const ENTRY_ANCHOR_RE = /^<!-- aslan-entry-id: ([A-Za-z0-9][A-Za-z0-9_-]{0,127}) -->$/u;
const LOCK_WAIT_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;
const MALFORMED_LOCK_STALE_MS = 60_000;

function usage() {
  return `Usage: node lib/diary.js --as <${[...DIARY_OWNERS].join('|')}> [--title <title>]`
    + ' [--consolidation <id>]  (body is read from stdin)';
}

function parseArgs(argv) {
  let title = '';
  let owner = null;
  let consolidationId = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--as') {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      owner = argv[++i];
    } else if (arg === '--consolidation') {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      consolidationId = argv[++i];
    } else if (arg === '--title' || arg === '-t') {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      title = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!DIARY_OWNERS.has(owner)) throw new Error(`--as must be one of: ${[...DIARY_OWNERS].join(', ')}`);
  if (consolidationId !== null && !SAFE_CONSOLIDATION_ID_RE.test(consolidationId)) {
    throw new Error('--consolidation contains unsupported characters');
  }
  if (/[\r\n]/.test(title)) throw new Error('Title must be a single line');
  return { owner, title: title.trim(), consolidationId };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function localParts(now) {
  return {
    date: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
    time: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
  };
}

function sleep(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function removeAbandonedLock(lockPath) {
  let raw;
  let stat;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
    stat = fs.statSync(lockPath);
  } catch (error) {
    return error && error.code === 'ENOENT';
  }

  try {
    const owner = JSON.parse(raw);
    if (processIsAlive(owner.pid)) return false;
  } catch {
    if (Date.now() - stat.mtimeMs < MALFORMED_LOCK_STALE_MS) return false;
  }

  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return error && error.code === 'ENOENT';
  }
}

function acquireFileLock(lockPath) {
  const token = crypto.randomBytes(16).toString('hex');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { lockPath, token };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      if (removeAbandonedLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for diary lock: ${lockPath}`);
      sleep(LOCK_WAIT_MS);
    }
  }
}

function acquireLock(ownerDir, date) {
  return acquireFileLock(path.join(ownerDir, `.${date}.lock`));
}

function releaseLock(lock) {
  try {
    const owner = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'));
    if (owner.token === lock.token) fs.unlinkSync(lock.lockPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      process.stderr.write(`Warning: could not release diary lock: ${error.message}\n`);
    }
  }
}

function acquireCurrentDayLock(ownerDir) {
  while (true) {
    const candidateDate = localParts(new Date()).date;
    const lock = acquireLock(ownerDir, candidateDate);
    const now = new Date();
    const parts = localParts(now);
    if (parts.date === candidateDate) return { lock, parts };
    releaseLock(lock);
  }
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

function normalizeBody(body) {
  return String(body).replace(/\r\n?/g, '\n').replace(/\n+$/u, '');
}

function normalizeTitle(title) {
  const normalized = String(title || '').trim();
  if (/[\r\n]/u.test(normalized)) throw new Error('Title must be a single line');
  return normalized;
}

function redactText(text, report) {
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
  replace('bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi);
  return output;
}

function redactConsolidatedContent(title, body) {
  const report = { count: 0, types: new Set() };
  return {
    title: redactText(title, report),
    body: redactText(body, report),
    redaction: report.count > 0
      ? { applied: true, count: report.count, types: [...report.types].sort() }
      : null,
  };
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function appendEntryToFile(filePath, parts, title, body, entryId = null) {
  const isNew = !fs.existsSync(filePath);
  let prefix = isNew ? `# ${parts.date}\n\n` : '\n';

  if (!isNew) {
    const descriptor = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(descriptor);
      if (stat.size > 0) {
        const last = Buffer.alloc(1);
        fs.readSync(descriptor, last, 0, 1, stat.size - 1);
        prefix = last[0] === 0x0a ? '\n' : '\n\n';
      } else {
        prefix = `# ${parts.date}\n\n`;
      }
    } finally {
      fs.closeSync(descriptor);
    }
  }

  const heading = title ? `## ${parts.time} ${title}` : `## ${parts.time}`;
  const anchor = entryId ? `\n<!-- aslan-entry-id: ${entryId} -->` : '';
  const entry = `${prefix}${heading}${anchor}\n${body}${body ? '\n' : ''}`;
  const descriptor = fs.openSync(filePath, 'a');
  try {
    fs.writeFileSync(descriptor, entry, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error(`Could not read diary entry metadata ${filePath}: ${error.message}`);
  }
}

function findNextEntryHeading(lines, start) {
  let fence = null;
  for (let index = start; index < lines.length; index += 1) {
    const fenceMatch = lines[index].match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === marker) fence = null;
      else if (fence === null) fence = marker;
      continue;
    }
    if (fence === null && /^##(?:\s|$)/u.test(lines[index])) return index;
  }
  return lines.length;
}

function readAnchoredEntries(ownerDir, entryId) {
  const marker = `<!-- aslan-entry-id: ${entryId} -->`;
  let names;
  try {
    names = fs.readdirSync(ownerDir).filter((name) => DIARY_FILE_RE.test(name)).sort();
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const matches = [];
  for (const name of names) {
    const filePath = path.join(ownerDir, name);
    const lines = fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n').split('\n');
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index] !== marker || !/^##(?:\s|$)/u.test(lines[index - 1])) continue;
      const heading = lines[index - 1].match(/^##(?:\s+(\d{2}:\d{2}))?(?:\s+(.*))?$/u);
      if (!heading) throw new Error(`Malformed heading before ${entryId} in ${filePath}`);
      const end = findNextEntryHeading(lines, index + 1);
      const bodyLines = lines.slice(index + 1, end);
      while (bodyLines.length && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
      matches.push({
        filePath,
        date: name.slice(0, 10),
        time: heading[1] || null,
        title: heading[2] || '',
        body: bodyLines.join('\n'),
      });
    }
  }
  return matches;
}

function validateEntryMetadata(meta, expected) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('Diary entry metadata must be an object');
  for (const field of ['schemaVersion', 'entryId', 'owner', 'date', 'kind', 'consolidationId', 'title', 'bodySha256']) {
    if (JSON.stringify(meta[field]) !== JSON.stringify(expected[field])) {
      throw new Error(`Diary entry metadata mismatch for ${field}`);
    }
  }
  if (JSON.stringify(meta.source) !== JSON.stringify(expected.source)) {
    throw new Error('Diary entry metadata mismatch for source');
  }
  if (typeof meta.createdAt !== 'string' || Number.isNaN(Date.parse(meta.createdAt))) {
    throw new Error('Diary entry metadata createdAt is invalid');
  }
}

function appendEntry(body, title, owner, opts = {}) {
  if (!DIARY_OWNERS.has(owner)) throw new Error(`Diary owner must be one of: ${[...DIARY_OWNERS].join(', ')}`);
  const ownerDir = path.join(path.resolve(opts.diaryRoot || DIARY_ROOT), owner);
  fs.mkdirSync(ownerDir, { recursive: true });

  const { lock, parts } = acquireCurrentDayLock(ownerDir);
  const filePath = path.join(ownerDir, `${parts.date}.md`);
  try {
    const normalizedBody = normalizeBody(body);
    const firstLine = normalizedBody.split('\n', 1)[0];
    if (ENTRY_ANCHOR_RE.test(firstLine)) {
      throw new Error('The first body line is reserved for an aslan entry anchor');
    }
    appendEntryToFile(filePath, parts, normalizeTitle(title), normalizedBody);
    return { filePath, owner, date: parts.date, time: parts.time };
  } finally {
    releaseLock(lock);
  }
}

function appendConsolidatedEntry(body, title, owner, consolidationId, opts = {}) {
  if (!DIARY_OWNERS.has(owner)) throw new Error(`Diary owner must be one of: ${[...DIARY_OWNERS].join(', ')}`);
  if (!SAFE_CONSOLIDATION_ID_RE.test(consolidationId)) throw new Error('Invalid consolidationId');
  const entryId = `entry-${consolidationId}`;
  if (!DIARY_ENTRY_ID_RE.test(entryId)) {
    throw new Error('Derived entryId does not fit the diary parser contract');
  }
  const ledger = consolidationStore.readConsolidation(consolidationId, opts);
  if (ledger.owner !== owner) throw new Error(`Consolidation belongs to ${ledger.owner}, not ${owner}`);
  if (ledger.diary.status === 'written' && ledger.diary.entryId !== entryId) {
    throw new Error(`Diary branch already points to a different entry: ${ledger.diary.entryId}`);
  }
  if (['none', 'skipped'].includes(ledger.diary.status)) {
    throw new Error(`Diary branch is already terminal: ${ledger.diary.status}`);
  }

  const normalizedBody = normalizeBody(body);
  if (!normalizedBody.trim()) throw new Error('A consolidated diary entry must not be empty');
  const redacted = redactConsolidatedContent(normalizeTitle(title), normalizedBody);
  const diaryRoot = path.resolve(opts.diaryRoot || DIARY_ROOT);
  const ownerDir = path.join(diaryRoot, owner);
  const metaDir = path.join(ownerDir, 'meta');
  const metaPath = path.join(metaDir, `${entryId}.json`);
  fs.mkdirSync(metaDir, { recursive: true });

  const entryLock = acquireFileLock(path.join(metaDir, `.${entryId}.lock`));
  let result;
  try {
    let existingMeta = readJsonIfExists(metaPath);
    let locations = readAnchoredEntries(ownerDir, entryId);
    if (locations.length > 1) throw new Error(`Diary entry anchor appears more than once: ${entryId}`);
    if (existingMeta && locations.length === 0) {
      throw new Error(`Diary metadata exists but its Markdown anchor is missing: ${entryId}`);
    }

    let dayLock;
    let parts;
    if (locations.length === 1) {
      parts = { date: locations[0].date, time: locations[0].time };
      dayLock = acquireLock(ownerDir, parts.date);
    } else {
      const current = acquireCurrentDayLock(ownerDir);
      dayLock = current.lock;
      parts = current.parts;
    }

    try {
      existingMeta = readJsonIfExists(metaPath);
      locations = readAnchoredEntries(ownerDir, entryId);
      if (locations.length > 1) throw new Error(`Diary entry anchor appears more than once: ${entryId}`);
      let location = locations[0] || null;
      if (location && location.date !== parts.date) {
        throw new Error(`Diary entry moved across dates while locked: ${entryId}`);
      }
      if (existingMeta && !location) {
        throw new Error(`Diary metadata exists but its Markdown anchor is missing: ${entryId}`);
      }
      if (location) {
        if (location.title !== redacted.title || location.body !== redacted.body) {
          throw new Error(`Consolidated diary retry changed existing content: ${entryId}`);
        }
      } else {
        const filePath = path.join(ownerDir, `${parts.date}.md`);
        appendEntryToFile(filePath, parts, redacted.title, redacted.body, entryId);
        location = {
          filePath,
          date: parts.date,
          time: parts.time,
          title: redacted.title,
          body: redacted.body,
        };
      }

      const expectedMeta = {
        schemaVersion: 1,
        entryId,
        owner,
        date: location.date,
        kind: 'consolidated',
        consolidationId,
        source: ledger.source,
        title: redacted.title,
        bodySha256: sha256(redacted.body),
      };
      if (existingMeta) {
        validateEntryMetadata(existingMeta, expectedMeta);
      } else {
        existingMeta = {
          ...expectedMeta,
          createdAt: new Date().toISOString(),
          redaction: redacted.redaction,
        };
        atomicWrite(metaPath, `${JSON.stringify(existingMeta, null, 2)}\n`);
      }
      result = {
        filePath: location.filePath,
        metaPath,
        owner,
        date: location.date,
        time: location.time,
        entryId,
        kind: 'consolidated',
        redaction: existingMeta.redaction || null,
      };
    } finally {
      releaseLock(dayLock);
    }
  } finally {
    releaseLock(entryLock);
  }

  const updated = consolidationStore.setBranch(
    consolidationId,
    'diary',
    { status: 'written', entryId },
    opts
  );
  return { ...result, consolidation: updated };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  if (process.stdin.isTTY) {
    process.stderr.write(`Diary body must be provided on stdin.\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  process.stdin.setEncoding('utf8');
  let body = '';
  process.stdin.on('data', (chunk) => { body += chunk; });
  process.stdin.on('end', () => {
    try {
      const result = options.consolidationId
        ? appendConsolidatedEntry(
          body,
          options.title,
          options.owner,
          options.consolidationId
        )
        : appendEntry(body, options.title, options.owner);
      process.stdout.write(`${result.filePath}\n`);
    } catch (error) {
      process.stderr.write(`Could not append diary entry: ${error.message}\n`);
      process.exitCode = 1;
    }
  });
  process.stdin.on('error', (error) => {
    process.stderr.write(`Could not read diary body: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  appendEntry,
  appendConsolidatedEntry,
};

if (require.main === module) main();
