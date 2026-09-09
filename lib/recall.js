'use strict';

// Ranking is pure: pass normalized memory metadata, normalized query terms and
// an explicit calendar date. Reading files and choosing today's date belong to
// the caller; no ranking operation changes memory strength or recall timestamps.
const { normalize, parseDateOnly } = require('./memory-metadata');

const MAX_RELATED = 8;
const MAX_ASSOCIATIONS = 2;

function splitQuery(text) {
  const seen = new Set();
  const terms = [];

  for (const raw of String(text || '').split(/[\s,，；、]+/u)) {
    const term = normalize(raw);
    if (term && !seen.has(term)) {
      seen.add(term);
      terms.push(term);
    }
  }
  return terms;
}

/** Score one metadata record from memory.loadMemories(); today is {year, month, day}. */
function scoreMemory(memory, query, today) {
  const normalizedTopics = new Set(memory.topics.map(normalize).filter(Boolean));
  const normalizedPlace = normalize(memory.place);
  const topicHits = query.filter((term) => normalizedTopics.has(term)).length;
  const topicHitRate = query.length ? topicHits / query.length : 0;
  const placeHit = Boolean(normalizedPlace && query.includes(normalizedPlace));

  const literalText = normalize(`${memory.name} ${memory.description}`);
  const literalHit = query.length > 0 && query.some((term) => literalText.includes(term));
  const relevance = (2.0 * topicHitRate) + (0.5 * Number(literalHit));

  const recalledDate = parseDateOnly(memory.lastRecalled);
  const occurredDate = parseDateOnly(memory.occurredAt);
  const todayTimestamp = Date.UTC(today.year, today.month - 1, today.day);
  const deltaDays = recalledDate
    ? Math.max(0, Math.floor((todayTimestamp - recalledDate.timestamp) / 86400000))
    : null;
  const sameMonthDay = Boolean(
    occurredDate
    && occurredDate.month === today.month
    && occurredDate.day === today.day
  );

  let recency = 0;
  if (memory.kind === 'promise') {
    recency = 1;
  } else if (deltaDays !== null) {
    recency = Math.exp(-deltaDays / (memory.kind === 'fact' ? 90 : 30));
  }

  const strengthRatio = Math.min(memory.strength, 5) / 5;
  const contributions = {
    topic: 2.0 * topicHitRate,
    literal: 0.5 * Number(literalHit),
    recency,
    strength: 0.8 * strengthRatio,
  };
  const rawScore = Object.values(contributions).reduce((sum, value) => sum + value, 0);
  const reasons = [];
  if (placeHit) reasons.push('same-place');
  if (sameMonthDay) reasons.push('same-month-day');

  return {
    ...memory,
    relevance,
    rawScore,
    reasons,
    why: {
      topicHitRate,
      topicHits,
      queryTerms: query.length,
      literalHit,
      relevance,
      recency,
      strengthRatio,
      deltaDays,
      placeHit,
      sameMonthDay,
      contributions,
    },
  };
}

function rankMemories(memories, query, today) {
  const scored = memories.map((memory) => scoreMemory(memory, query, today));
  const related = query.length === 0
    ? []
    : scored
      .filter((item) => item.relevance > 0)
      .sort((left, right) => (
        right.rawScore - left.rawScore
        || left.name.localeCompare(right.name, 'en')
      ))
      .slice(0, MAX_RELATED);

  const relatedMax = related.reduce((maximum, item) => Math.max(maximum, item.rawScore), 0);
  const rankedRelated = related.map((item) => ({
    ...item,
    lane: 'related',
    score: relatedMax > 0 ? item.rawScore / relatedMax : 0,
  }));
  const alreadySelected = new Set(rankedRelated.map((item) => item.id));

  const associations = scored
    .filter((item) => item.reasons.length > 0 && !alreadySelected.has(item.id))
    .sort((left, right) => (
      right.reasons.length - left.reasons.length
      || String(right.occurredAt || '').localeCompare(String(left.occurredAt || ''), 'en')
      || left.name.localeCompare(right.name, 'en')
    ))
    .slice(0, MAX_ASSOCIATIONS)
    .map((item) => ({
      ...item,
      lane: 'association',
      // Association scores are trigger counts; they are intentionally not
      // comparable with normalized related-lane scores.
      score: item.reasons.length,
    }));

  return [...rankedRelated, ...associations];
}

module.exports = { splitQuery, scoreMemory, rankMemories };
