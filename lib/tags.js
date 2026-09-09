#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_MEMORY_DIR,
  SAFE_ID,
  cleanOneLine,
  formatDateOnly,
  loadMemories,
  loadMetadataEntries,
  localToday,
  metadataMode,
  normalize,
  objectOrEmpty,
  parseDateOnly,
} = require('./memory-metadata');

const TAG_TYPES = ['topic', 'place', 'mood'];
const LOCK_TIMEOUT_MS = 10000;
const STALE_LOCK_MS = 60000;
const SUGGESTION_LIMIT = 5;

function warn(message) {
  process.stderr.write(`[tags] ${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function printHelp() {
  process.stdout.write([
    'Usage:',
    '  node lib/tags.js [--dir PATH] [--json] --list',
    '  node lib/tags.js [--dir PATH] [--json] --recalled <id> [--at YYYY-MM-DD]',
    '  node lib/tags.js [--dir PATH] [--json] --suggest <tag-id> [--type topic|place|mood]',
    '',
    'Memory directory precedence:',
    '  --dir PATH > ASLAN_MEMORY_DIR > MEMORY_DIR > ASLAN_DATA_DIR/memory > <app>/data/memory',
    '',
    '--suggest is read-only. It reports similar stable IDs and never merges them.',
  ].join('\n') + '\n');
}

function parseArgs(argv) {
  const options = {
    dir: process.env.ASLAN_MEMORY_DIR || process.env.MEMORY_DIR || DEFAULT_MEMORY_DIR,
    json: false,
    help: false,
    command: null,
    value: null,
    type: null,
    at: null,
  };

  const setCommand = (command, value = null) => {
    if (options.command) fail(`只能指定一个子命令（已经指定 ${options.command}）。`);
    options.command = command;
    options.value = value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--list') {
      setCommand('list');
    } else if (arg === '--recalled' || arg === '--suggest') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        fail(`${arg} 缺少值。`);
      }
      setCommand(arg.slice(2), argv[i + 1]);
      i += 1;
    } else if (arg === '--dir' || arg === '--type' || arg === '--at') {
      if (i + 1 >= argv.length) fail(`${arg} 缺少值。`);
      const value = argv[i + 1];
      if (arg === '--dir') options.dir = value;
      if (arg === '--type') options.type = value;
      if (arg === '--at') options.at = value;
      i += 1;
    } else if (arg.startsWith('--dir=')) {
      options.dir = arg.slice('--dir='.length);
    } else if (arg.startsWith('--type=')) {
      options.type = arg.slice('--type='.length);
    } else if (arg.startsWith('--at=')) {
      options.at = arg.slice('--at='.length);
    } else {
      fail(`未知参数：${arg}`);
    }
  }

  options.dir = path.resolve(options.dir);
  if (options.type && !TAG_TYPES.includes(options.type)) {
    fail(`--type 必须是 ${TAG_TYPES.join('、')} 之一。`);
  }
  if (options.at && !parseDateOnly(options.at)) {
    fail(`--at 必须是有效的 YYYY-MM-DD：${options.at}`);
  }
  if (options.type && options.command !== 'suggest') fail('--type 只适用于 --suggest。');
  if (options.at && options.command !== 'recalled') fail('--at 只适用于 --recalled。');
  return options;
}

function increment(map, id, amount = 1) {
  const cleanId = cleanOneLine(id);
  if (!cleanId) return;
  map.set(cleanId, (map.get(cleanId) || 0) + amount);
}

function collectTagCounts(entries) {
  const counts = {
    topic: new Map(),
    place: new Map(),
    mood: new Map(),
  };

  for (const rawEntry of Object.values(entries)) {
    const tags = objectOrEmpty(objectOrEmpty(rawEntry).tags);
    const topics = Array.isArray(tags.topic)
      ? tags.topic
      : (typeof tags.topic === 'string' ? [tags.topic] : []);
    for (const topic of new Set(topics.map(cleanOneLine).filter(Boolean))) {
      increment(counts.topic, topic);
    }
    if (typeof tags.place === 'string') increment(counts.place, tags.place);

    for (const [moodId, rawMood] of Object.entries(objectOrEmpty(tags.mood))) {
      const parsed = Number(objectOrEmpty(rawMood).n);
      increment(counts.mood, moodId, Number.isFinite(parsed) && parsed >= 0 ? parsed : 1);
    }
  }
  return counts;
}

function sortedCounts(counts) {
  return Object.fromEntries(TAG_TYPES.map((type) => [
    type,
    [...counts[type].entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id, 'en')),
  ]));
}

function printList(memoryDir, asJson) {
  const { mode, entries } = loadMetadataEntries(memoryDir, warn);
  const groups = sortedCounts(collectTagCounts(entries));
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ mode, groups }, null, 2)}\n`);
    return;
  }

  for (const type of TAG_TYPES) {
    process.stdout.write(`${type}\n`);
    if (!groups[type].length) {
      process.stdout.write('  (none)\n');
      continue;
    }
    for (const item of groups[type]) {
      process.stdout.write(`  ${item.id}  ${item.count}\n`);
    }
  }
}

function levenshtein(left, right) {
  const a = [...left];
  const b = [...right];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + Number(a[i - 1] !== b[j - 1])
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function ngrams(value, size = 2) {
  const characters = [...value];
  if (characters.length < size) return new Set(characters);
  const result = new Set();
  for (let i = 0; i <= characters.length - size; i += 1) {
    result.add(characters.slice(i, i + size).join(''));
  }
  return result;
}

function diceCoefficient(left, right) {
  const leftParts = ngrams(left);
  const rightParts = ngrams(right);
  if (!leftParts.size && !rightParts.size) return 1;
  let overlap = 0;
  for (const part of leftParts) if (rightParts.has(part)) overlap += 1;
  return (2 * overlap) / (leftParts.size + rightParts.size);
}

function similarity(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLength = Math.max([...a].length, [...b].length);
  const editScore = 1 - (levenshtein(a, b) / maxLength);
  const overlapScore = diceCoefficient(a, b);
  const containsScore = a.includes(b) || b.includes(a)
    ? 0.9 * (Math.min([...a].length, [...b].length) / maxLength)
    : 0;
  return Math.max(editScore, overlapScore, containsScore);
}

function suggestionsFor(query, counts) {
  const groups = {};
  for (const type of TAG_TYPES) {
    groups[type] = [...counts[type].entries()]
      .map(([id, count]) => ({ id, count, similarity: similarity(query, id) }))
      .filter((item) => item.similarity >= 0.25)
      .sort((left, right) => (
        right.similarity - left.similarity
        || right.count - left.count
        || left.id.localeCompare(right.id, 'en')
      ))
      .slice(0, SUGGESTION_LIMIT)
      .map((item) => ({ ...item, similarity: Number(item.similarity.toFixed(3)) }));
  }
  return groups;
}

function printSuggestions(memoryDir, query, type, asJson) {
  const { mode, entries } = loadMetadataEntries(memoryDir, warn);
  const groups = suggestionsFor(query, collectTagCounts(entries));
  const selectedTypes = type ? [type] : TAG_TYPES;
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ mode, query, groups: Object.fromEntries(
      selectedTypes.map((selected) => [selected, groups[selected]])
    ) }, null, 2)}\n`);
    return;
  }

  for (const selected of selectedTypes) {
    process.stdout.write(`${selected}\n`);
    if (!groups[selected].length) {
      process.stdout.write('  (no similar tag IDs)\n');
      continue;
    }
    for (const item of groups[selected]) {
      process.stdout.write(`  ${item.id}  similarity=${item.similarity.toFixed(3)}  used=${item.count}\n`);
    }
  }
}

function sleepSync(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function acquireLock(lockPath) {
  const started = Date.now();
  while (true) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${process.pid} ${new Date().toISOString()}\n`, 'utf8');
      fs.closeSync(descriptor);
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') warn(`无法释放锁 ${lockPath}：${error.message}`);
        }
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > STALE_LOCK_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError && statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) {
        fail(`等待锁超时：${lockPath}`);
      }
      sleepSync(50);
    }
  }
}

function readLegacyStrict(memoryDir) {
  const tagsPath = path.join(memoryDir, 'tags.json');
  let source;
  try {
    source = fs.readFileSync(tagsPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw error;
  }
  const parsed = JSON.parse(source.replace(/^\uFEFF/u, ''));
  if (!parsed || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
    fail(`${tagsPath} 没有有效的 entries，拒绝迁移。`);
  }
  return parsed.entries;
}

function ensureSidecarStore(memoryDir) {
  const metaDir = path.join(memoryDir, 'meta');
  if (metadataMode(memoryDir) === 'sidecar') return metaDir;
  if (!fs.statSync(memoryDir).isDirectory()) fail(`记忆目录不存在：${memoryDir}`);

  const migrationLock = path.join(memoryDir, '.meta-migration.lock');
  const release = acquireLock(migrationLock);
  try {
    if (metadataMode(memoryDir) === 'sidecar') return metaDir;
    const entries = readLegacyStrict(memoryDir);
    const stagingDir = path.join(
      memoryDir,
      `.meta-staging-${process.pid}-${crypto.randomUUID()}`
    );
    fs.mkdirSync(stagingDir);
    try {
      for (const [id, entry] of Object.entries(entries)) {
        if (!SAFE_ID.test(id)) fail(`旧 tags.json 中的键不是安全的稳定 ID：${id}`);
        fs.writeFileSync(
          path.join(stagingDir, `${id}.json`),
          `${JSON.stringify(objectOrEmpty(entry), null, 2)}\n`,
          { encoding: 'utf8', mode: 0o600, flag: 'wx' }
        );
      }
      fs.renameSync(stagingDir, metaDir);
    } catch (error) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw error;
    }
    return metaDir;
  } finally {
    release();
  }
}

function readEntryStrict(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(`${filePath} 的顶层必须是对象。`);
    }
    return parsed;
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw error;
  }
}

function laterDate(existing, incoming) {
  const existingDate = parseDateOnly(existing);
  if (!existingDate) return incoming;
  return existingDate.timestamp >= parseDateOnly(incoming).timestamp ? existing : incoming;
}

// Every mutation passes through this semantic merger while holding the entry lock.
// The recalled command uses the first two fields; topic/mood are already defined for
// future update commands so callers cannot accidentally replace concurrent changes.
function mergeEntry(currentValue, patch) {
  const current = { ...objectOrEmpty(currentValue) };
  const currentStrength = Number(current.strength);
  if (Number.isFinite(patch.strengthDelta)) {
    current.strength = Math.max(0, Number.isFinite(currentStrength) ? currentStrength : 0)
      + patch.strengthDelta;
  }
  if (patch.lastRecalled) {
    current.lastRecalled = laterDate(current.lastRecalled, patch.lastRecalled);
  }

  if ((patch.topics && patch.topics.length) || (patch.moods && patch.moods.length)) {
    const tags = { ...objectOrEmpty(current.tags) };
    if (patch.topics && patch.topics.length) {
      const existing = Array.isArray(tags.topic)
        ? tags.topic.map(cleanOneLine).filter(Boolean)
        : (typeof tags.topic === 'string' ? [cleanOneLine(tags.topic)].filter(Boolean) : []);
      tags.topic = [...new Set([...existing, ...patch.topics.map(cleanOneLine).filter(Boolean)])];
    }
    if (patch.moods && patch.moods.length) {
      const moods = { ...objectOrEmpty(tags.mood) };
      for (const addition of patch.moods) {
        const id = cleanOneLine(addition.id);
        if (!id) continue;
        const previous = { ...objectOrEmpty(moods[id]) };
        const previousN = Number(previous.n);
        const incrementBy = Number(addition.n);
        previous.n = (Number.isFinite(previousN) ? previousN : 0)
          + (Number.isFinite(incrementBy) ? incrementBy : 1);
        if (addition.by) previous.by = addition.by;
        if (addition.last) previous.last = laterDate(previous.last, addition.last);
        moods[id] = previous;
      }
      tags.mood = moods;
    }
    current.tags = tags;
  }
  return current;
}

function atomicWriteJson(filePath, value) {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (descriptor !== undefined && descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

function updateEntryWithLock(memoryDir, id, patch) {
  const metaDir = ensureSidecarStore(memoryDir);
  const filePath = path.join(metaDir, `${id}.json`);
  const lockPath = path.join(metaDir, `${id}.lock`);
  const release = acquireLock(lockPath);
  try {
    const next = mergeEntry(readEntryStrict(filePath), patch);
    atomicWriteJson(filePath, next);
    return next;
  } finally {
    release();
  }
}

function markRecalled(memoryDir, id, at, asJson) {
  if (!SAFE_ID.test(id)) fail(`不是安全的稳定 ID：${id}`);
  const knownIds = new Set(loadMemories(memoryDir, warn).map((memory) => memory.id));
  if (!knownIds.has(id)) fail(`找不到对应的 Markdown 记忆条目：${id}`);

  const recalledAt = at || formatDateOnly(localToday());
  const updated = updateEntryWithLock(memoryDir, id, {
    strengthDelta: 1,
    lastRecalled: recalledAt,
  });
  const output = {
    id,
    strength: updated.strength,
    lastRecalled: updated.lastRecalled,
  };
  if (asJson) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else process.stdout.write(`${id}  strength=${output.strength}  lastRecalled=${output.lastRecalled}\n`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }
    if (!options.command) fail('缺少子命令。使用 --help 查看用法。');

    if (options.command === 'list') printList(options.dir, options.json);
    if (options.command === 'suggest') {
      printSuggestions(options.dir, options.value, options.type, options.json);
    }
    if (options.command === 'recalled') {
      markRecalled(options.dir, options.value, options.at, options.json);
    }
  } catch (error) {
    process.stderr.write(`[tags] ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  collectTagCounts,
  mergeEntry,
  similarity,
  updateEntryWithLock,
};
