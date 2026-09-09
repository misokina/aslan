'use strict';

const fs = require('fs');
const path = require('path');

const SAFE_PARTICIPANT_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const SAFE_ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RESERVED_IDS = new Set(['aslan', 'constructor', 'prototype', '__proto__']);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function participant(value, label, agent = false) {
  object(value, label);
  if (typeof value.id !== 'string' || !SAFE_PARTICIPANT_ID.test(value.id)
    || RESERVED_IDS.has(value.id)) {
    throw new Error(`${label}.id must be a non-reserved lowercase participant id`);
  }
  const name = value.name === undefined ? value.id : value.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\r\n\x00-\x1f]/.test(name)) {
    throw new Error(`${label}.name must be a non-empty single-line name (at most 80 characters)`);
  }
  if (agent && value.runtime !== 'claude' && value.runtime !== 'codex') {
    throw new Error(`${label}.runtime must be claude or codex`);
  }
  return Object.freeze({ id: value.id, name, ...(agent ? { runtime: value.runtime } : {}) });
}

function normalizeParticipantConfig(config = {}) {
  object(config, 'group config');
  // A room is a persistent address, not a serialization of its current members.
  const roomId = config.roomId === undefined ? 'main' : config.roomId;
  if (typeof roomId !== 'string' || !SAFE_ROOM_ID.test(roomId)) {
    throw new Error('group config.roomId must be a safe, stable room id');
  }
  const raw = config.participants === undefined ? {
    human: { id: 'owner', name: 'owner' },
    agents: [
      { id: 'dawn', name: '晨曦', runtime: 'claude' },
      { id: 'lumen', name: '眠灯', runtime: 'codex' },
    ],
  } : object(config.participants, 'participants');
  const human = participant(raw.human, 'participants.human');
  if (!Array.isArray(raw.agents) || raw.agents.length !== 2) {
    throw new Error('participants.agents must contain one Claude agent and one Codex agent');
  }
  const agents = raw.agents.map((value, index) => participant(value, `participants.agents[${index}]`, true));
  if (new Set(agents.map((agent) => agent.runtime)).size !== 2) {
    throw new Error('participants.agents must contain distinct claude and codex runtimes');
  }
  const participantIds = [human.id, ...agents.map((agent) => agent.id)];
  if (new Set(participantIds).size !== participantIds.length) {
    throw new Error('Participant ids must be unique across the human and agents');
  }
  return Object.freeze({
    roomId,
    participants: Object.freeze({ human, agents: Object.freeze(agents) }),
    humanId: human.id,
    agentIds: Object.freeze(agents.map((agent) => agent.id)),
    participantIds: Object.freeze(participantIds),
  });
}

function loadParticipantConfig(opts = {}) {
  const configDir = opts.configDir || process.env.ASLAN_CONFIG_DIR || path.join(__dirname, '..', 'config');
  const configPath = path.join(configDir, 'group.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeParticipantConfig();
    throw error;
  }
  // Only an absent file selects defaults. Corrupt configuration must not silently
  // change identities and strand the previous room's events or delivery cursors.
  try {
    return normalizeParticipantConfig(JSON.parse(raw.replace(/^\uFEFF/, '')));
  } catch (error) {
    throw new Error(`Invalid participant configuration (${configPath}): ${error.message}`);
  }
}

let snapshot;
function getParticipantConfig() {
  // Process-lifetime snapshot: server, storage and CLI must not hot-swap owners
  // midway through a delivery. Restart after changing identity configuration.
  // Call after loading .env; standalone CLI invocations use the process environment.
  if (!snapshot) snapshot = loadParticipantConfig();
  return snapshot;
}

module.exports = { getParticipantConfig, loadParticipantConfig, normalizeParticipantConfig };
