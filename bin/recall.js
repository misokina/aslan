#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  DEFAULT_MEMORY_DIR,
  loadMemories,
  localToday,
} = require('../lib/memory-metadata');

const { splitQuery, rankMemories } = require('../lib/recall');

function warn(message) {
  process.stderr.write(`[recall] ${message}\n`);
}

function printHelp() {
  process.stdout.write([
    'Usage: node bin/recall.js [--dir PATH] [--json] [--why] "tag words"',
    '',
    'Memory directory precedence:',
    '  --dir PATH > ASLAN_MEMORY_DIR > MEMORY_DIR > ASLAN_DATA_DIR/memory > <app>/data/memory',
    '',
    'The default output contains metadata only; memory bodies are never printed.',
  ].join('\n') + '\n');
}

function parseArgs(argv) {
  const options = {
    dir: process.env.ASLAN_MEMORY_DIR || process.env.MEMORY_DIR || DEFAULT_MEMORY_DIR,
    json: false,
    why: false,
    help: false,
    queryParts: [],
  };

  let positionalOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (positionalOnly) {
      options.queryParts.push(arg);
    } else if (arg === '--') {
      positionalOnly = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--why') {
      options.why = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dir') {
      if (i + 1 < argv.length) {
        options.dir = argv[i + 1];
        i += 1;
      } else {
        warn('--dir 缺少路径，改用默认目录。');
      }
    } else if (arg.startsWith('--dir=')) {
      const value = arg.slice('--dir='.length);
      if (value) options.dir = value;
      else warn('--dir 缺少路径，改用默认目录。');
    } else if (arg.startsWith('-')) {
      warn(`忽略未知参数：${arg}`);
    } else {
      options.queryParts.push(arg);
    }
  }

  options.dir = path.resolve(options.dir);
  options.query = splitQuery(options.queryParts.join(' '));
  return options;
}

function round(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function toJsonItem(item, rank, includeWhy) {
  const output = {
    rank,
    lane: item.lane,
    score: round(item.score),
    reasons: item.reasons,
    name: item.name,
    kind: item.kind,
    description: item.description,
    strength: item.strength,
    lastRecalled: item.lastRecalled,
    occurredAt: item.occurredAt,
    tags: {
      topic: item.topics,
      place: item.place || null,
    },
  };

  if (includeWhy) {
    output.why = {
      topicHitRate: round(item.why.topicHitRate),
      topicHits: item.why.topicHits,
      queryTerms: item.why.queryTerms,
      literalHit: item.why.literalHit,
      relevance: round(item.why.relevance),
      recency: round(item.why.recency),
      strengthRatio: round(item.why.strengthRatio),
      deltaDays: item.why.deltaDays,
      placeHit: item.why.placeHit,
      sameMonthDay: item.why.sameMonthDay,
      contributions: Object.fromEntries(
        Object.entries(item.why.contributions).map(([key, value]) => [key, round(value)])
      ),
      rawScore: round(item.rawScore),
      normalizationMax: item.lane === 'related'
        ? round(item.rawScore / item.score || 0)
        : null,
    };
  }

  return output;
}

function displayWidth(value) {
  let width = 0;
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0);
    width += (
      codePoint >= 0x1100
      && (
        codePoint <= 0x115f
        || codePoint === 0x2329
        || codePoint === 0x232a
        || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
        || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
        || (codePoint >= 0xf900 && codePoint <= 0xfaff)
        || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
        || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
        || (codePoint >= 0xff00 && codePoint <= 0xff60)
        || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
        || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
      )
    ) ? 2 : 1;
  }
  return width;
}

function padDisplay(value, targetWidth) {
  const text = String(value);
  return text + ' '.repeat(Math.max(0, targetWidth - displayWidth(text)));
}

function reasonSuffix(reasons) {
  const labels = {
    'same-place': '联想:同地',
    'same-month-day': '联想:同日',
  };
  return reasons.length ? `  ${reasons.map((reason) => labels[reason]).join(' ')}` : '';
}

function humanLine(item, rank, includeWhy) {
  const topicText = `[${item.topics.join(',')}]`;
  const placeText = item.place ? ` @${item.place}` : '';
  let line = `${String(rank).padStart(2)}  ${padDisplay(item.lane, 11)}  ${item.score.toFixed(2)}  `
    + `${padDisplay(item.name, 28)}  ${padDisplay(item.kind, 8)}  `
    + `${padDisplay(item.description, 30)}  ${topicText}${placeText}`;

  if (includeWhy) {
    const c = item.why.contributions;
    const delta = item.why.deltaDays === null ? '?' : item.why.deltaDays;
    line += `  | topic=${c.topic.toFixed(3)}`
      + ` literal=${c.literal.toFixed(3)}`
      + ` recency=${c.recency.toFixed(3)}`
      + ` strength=${c.strength.toFixed(3)}`
      + ` relevance=${item.why.relevance.toFixed(3)}`
      + ` delta=${delta}d`
      + ` raw=${item.rawScore.toFixed(3)}`;
  }

  return line + reasonSuffix(item.reasons);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const ranked = rankMemories(loadMemories(options.dir, warn), options.query, localToday());
  if (options.json) {
    const items = ranked.map((item, index) => toJsonItem(item, index + 1, options.why));
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }

  if (ranked.length) {
    process.stdout.write(
      `${ranked.map((item, index) => humanLine(item, index + 1, options.why)).join('\n')}\n`
    );
  }
}

module.exports = { main };

if (require.main === module) main();
