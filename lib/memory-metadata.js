'use strict';

const fs = require('fs');
const path = require('path');

// Never default to another application's private harness directory. Split-owner
// libraries are selected explicitly with --dir or the memory directory env vars.
const DEFAULT_MEMORY_DIR = path.join(
  process.env.ASLAN_DATA_DIR || path.join(__dirname, '..', 'data'), 'memory'
);
const VALID_KINDS = new Set(['promise', 'fact', 'chat']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
}

function cleanOneLine(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  return trimmed;
}

function parseFrontmatter(text, fallbackName) {
  const result = { name: fallbackName, description: '' };
  const normalizedText = String(text).replace(/^\uFEFF/u, '');
  const match = normalizedText.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/u);
  if (!match) return result;

  for (const line of match[1].split(/\r?\n/u)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u);
    if (!field) continue;

    if (field[1] === 'name' && field[2].trim()) {
      result.name = cleanOneLine(unquoteYamlScalar(field[2]));
    } else if (field[1] === 'description') {
      result.description = cleanOneLine(unquoteYamlScalar(field[2]));
    }
  }

  return result;
}

function parseDateOnly(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const checked = new Date(timestamp);
  if (
    checked.getUTCFullYear() !== year
    || checked.getUTCMonth() + 1 !== month
    || checked.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day, timestamp };
}

function localToday() {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  };
}

function formatDateOnly(date) {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}`
    + `-${String(date.day).padStart(2, '0')}`;
}

function readJsonObject(filePath, warn) {
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      warn(`无法读取 ${filePath}，按无元数据处理：${error.message}`);
    }
    return null;
  }

  try {
    const parsed = JSON.parse(source.replace(/^\uFEFF/u, ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    warn(`${filePath} 的顶层不是对象，按无元数据处理。`);
  } catch (error) {
    warn(`${filePath} 不是有效 JSON，按无元数据处理：${error.message}`);
  }
  return null;
}

function loadLegacyEntries(memoryDir, warn) {
  const tagsPath = path.join(memoryDir, 'tags.json');
  const parsed = readJsonObject(tagsPath, warn);
  if (!parsed) return {};
  if (parsed.entries && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)) {
    return parsed.entries;
  }
  warn(`${tagsPath} 没有有效的 entries，按无元数据处理。`);
  return {};
}

function loadSidecarEntries(metaDir, warn) {
  let files;
  try {
    files = fs.readdirSync(metaDir, { withFileTypes: true });
  } catch (error) {
    warn(`无法读取 sidecar 目录 ${metaDir}，按无元数据处理：${error.message}`);
    return {};
  }

  const entries = {};
  for (const file of files
    .filter((candidate) => candidate.isFile() && path.extname(candidate.name).toLowerCase() === '.json')
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const id = path.basename(file.name, path.extname(file.name));
    if (!SAFE_ID.test(id)) {
      warn(`跳过不符合稳定 ID 格式的 sidecar：${file.name}`);
      continue;
    }
    const parsed = readJsonObject(path.join(metaDir, file.name), warn);
    if (parsed) entries[id] = parsed;
  }
  return entries;
}

function metadataMode(memoryDir) {
  try {
    return fs.statSync(path.join(memoryDir, 'meta')).isDirectory() ? 'sidecar' : 'legacy';
  } catch {
    return 'legacy';
  }
}

function loadMetadataEntries(memoryDir, warn = () => {}) {
  const mode = metadataMode(memoryDir);
  const entries = mode === 'sidecar'
    ? loadSidecarEntries(path.join(memoryDir, 'meta'), warn)
    : loadLegacyEntries(memoryDir, warn);
  return { mode, entries };
}

function normalizeMetadata(raw) {
  const metadata = objectOrEmpty(raw);
  const tags = objectOrEmpty(metadata.tags);
  const topics = Array.isArray(tags.topic)
    ? tags.topic.map(cleanOneLine).filter(Boolean)
    : (typeof tags.topic === 'string' && cleanOneLine(tags.topic)
      ? [cleanOneLine(tags.topic)]
      : []);
  const place = typeof tags.place === 'string' ? cleanOneLine(tags.place) : '';
  const mood = objectOrEmpty(tags.mood);
  const parsedStrength = Number(metadata.strength);

  return {
    kind: VALID_KINDS.has(metadata.kind) ? metadata.kind : 'chat',
    strength: Number.isFinite(parsedStrength) ? Math.max(0, parsedStrength) : 0,
    lastRecalled: typeof metadata.lastRecalled === 'string' ? metadata.lastRecalled : null,
    occurredAt: typeof metadata.occurredAt === 'string' ? metadata.occurredAt : null,
    topics,
    place,
    mood,
  };
}

function loadMemories(memoryDir, warn = () => {}) {
  let names;
  try {
    names = fs.readdirSync(memoryDir, { withFileTypes: true });
  } catch (error) {
    warn(`无法读取记忆目录 ${memoryDir}，返回空结果：${error.message}`);
    return [];
  }

  const { entries } = loadMetadataEntries(memoryDir, warn);
  const markdownFiles = names
    .filter((entry) => (
      entry.isFile()
      && path.extname(entry.name).toLowerCase() === '.md'
      && entry.name.toLowerCase() !== 'memory.md'
    ))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));

  const memories = [];
  for (const filename of markdownFiles) {
    const filePath = path.join(memoryDir, filename);
    const stem = path.basename(filename, path.extname(filename));
    let frontmatter;

    try {
      frontmatter = parseFrontmatter(fs.readFileSync(filePath, 'utf8'), stem);
    } catch (error) {
      warn(`跳过无法读取的记忆 ${filename}：${error.message}`);
      continue;
    }

    let id = frontmatter.name || stem;
    if (!SAFE_ID.test(id)) {
      warn(`${filename} 的 name 不是安全的稳定 ID，改用文件名 ${stem}。`);
      id = stem;
    }
    const metadata = normalizeMetadata(entries[id]);
    memories.push({
      id,
      name: id,
      description: frontmatter.description,
      ...metadata,
    });
  }

  // 没有 Markdown 正文的元数据无法在召回后打开，因此不作为候选。
  return memories;
}

module.exports = {
  DEFAULT_MEMORY_DIR,
  SAFE_ID,
  cleanOneLine,
  formatDateOnly,
  loadLegacyEntries,
  loadMemories,
  loadMetadataEntries,
  localToday,
  metadataMode,
  normalize,
  objectOrEmpty,
  parseDateOnly,
};
