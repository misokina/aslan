#!/usr/bin/env node
'use strict';

// Standalone storage-contract checks; no server, real agent, credentials or network.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { normalizeParticipantConfig, loadParticipantConfig } = require('../lib/participant-config');

function runChild(mode, env) {
  const result = spawnSync(process.execPath, [__filename, mode], {
    env, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  assert.equal(result.status, 0, `${mode}: ${result.error || result.stderr || result.stdout}`);
}

function checkStorage() {
  const config = require('../lib/participant-config').getParticipantConfig();
  const group = require('../lib/group');
  const diary = require('../lib/diary');
  const ledger = require('../lib/consolidate');
  const [first, second] = config.agentIds;
  const room = config.roomId;
  const append = (author, text, extra = {}) => group.appendEvent(room, {
    kind: 'message', author, text, ...extra,
  });
  const initial = append(config.humanId, 'A neutral test message', { targets: [first] });
  assert.equal(initial.trigger.source, 'human');
  assert.deepEqual(initial.visibleTo, config.participantIds);
  assert.deepEqual(Object.keys(group.getCursors(room)), config.agentIds);
  assert.equal(group.readAfter(room, { after: null }).length, 1);
  assert.equal(group.getCursors(room)[first].contextThrough, null, 'peek must not acknowledge');
  assert.throws(() => append('outsider', 'invalid'), /Invalid message author/);
  assert.throws(() => append(config.humanId, 'invalid', { targets: ['outsider'] }), /unknown participant/);

  const request = { who: first, fromExclusive: null, through: initial.id, sessionId: 'test-session', runId: 'test-run' };
  const attempt = group.beginDelivery(room, request);
  assert.equal(group.beginDelivery(room, request).attemptId, attempt.attemptId);
  assert.equal(group.getCursors(room)[first].contextThrough, null, 'begin is not commit');
  group.commitDelivery(room, attempt.attemptId, { type: 'assistant-output', runtimeEventType: 'assistant' });
  assert.equal(group.getCursors(room)[first].contextThrough, initial.id);
  assert.equal(group.getCursors(room)[first].memoryThrough, null);

  // 宿主重启时还在跑的投递：调用方传进 activeAttemptIds 的，恢复时不许判成失败
  const running = group.beginDelivery(room, {
    who: second, fromExclusive: null, through: initial.id, sessionId: 'test-session-2', runId: 'test-run-2',
  });
  const kept = group.recoverDeliveryAttempts(room, { activeAttemptIds: [running.attemptId] });
  assert.ok(!kept.recovered.failed.includes(running.attemptId),
    'an attempt the host says is still running must not be failed on recovery');
  const swept = group.recoverDeliveryAttempts(room);
  assert.ok(swept.recovered.failed.includes(running.attemptId),
    'without that hint, a pending attempt with no worker is still failed as before');
  const reply = {
    author: first, text: 'Authorization: Bearer test-only-secret-value',
    episodeId: initial.episodeId, inputThrough: initial.id,
    sessionId: 'test-session', runId: 'test-run',
  };
  const captured = group.appendAgentReply(room, reply);
  assert.equal(captured.provenance.recordedBy, 'aslan');
  assert.equal(captured.text, '[REDACTED:authorization]');
  assert.equal(group.appendAgentReply(room, reply).id, captured.id);
  assert.throws(() => group.appendAgentReply(room, { ...reply, text: 'different' }), /Idempotency conflict/);

  const handoff = append(first, 'Would you add anything?', {
    episodeId: initial.episodeId,
    handoff: { target: second, expiresAt: new Date(Date.now() + 60_000).toISOString() },
  });
  assert.equal(group.claimHandoff(room, handoff.handoff.id, second).status, 'claimed');
  assert.equal(group.declineHandoff(room, handoff.handoff.id, second, 'Nothing to add').status, 'declined');
  const before = group.getEpisodeBudget(room, initial.episodeId);
  group.appendEvent(room, {
    kind: 'control', author: 'aslan', episodeId: initial.episodeId,
    control: { type: 'quota_warning', target: first, reason: 'Test warning' },
  });
  group.appendEvent(room, {
    kind: 'control', author: 'aslan', episodeId: initial.episodeId,
    idempotencyKey: 'test-runtime-change',
    control: {
      type: 'runtime_changed', target: second, requestedBy: first, scope: 'group-session',
      before: { model: 'test-model', reasoningEffort: 'medium' },
      after: { model: 'test-model', reasoningEffort: 'high' }, reason: 'Test change',
    },
  });
  const after = group.getEpisodeBudget(room, initial.episodeId);
  assert.equal(after.agentMessages, before.agentMessages);
  assert.equal(after.outputTokensEstimated, before.outputTokensEstimated);
  assert.equal(after.modelRuns, before.modelRuns);
  assert.equal(after.lastEventId, before.lastEventId);
  append(config.humanId, 'New human contribution', { episodeId: initial.episodeId });
  assert.equal(group.getEpisodeBudget(room, initial.episodeId).consecutiveAgentMessages, 0);

  assert.throws(() => diary.appendEntry('invalid', '', config.humanId), /Diary owner/);
  const authored = diary.appendEntry('A voluntary entry', 'Test', first);
  assert.equal(path.dirname(authored.filePath), path.join(process.env.ASLAN_DATA_DIR, 'diary', first));
  const input = {
    owner: second,
    source: { kind: 'session', sessionId: 'test-session', fromEvent: 'msg-0', throughEvent: 'msg-2' },
    trigger: { reason: 'manual', contextTokens: 10, contextWindowTokens: 100 },
  };
  const record = ledger.openConsolidation(input);
  assert.equal(ledger.openConsolidation(input).consolidationId, record.consolidationId);
  const written = diary.appendConsolidatedEntry('Reviewed test interval', 'Summary', second, record.consolidationId);
  assert.equal(written.entryId, `entry-${record.consolidationId}`);
  const same = diary.appendConsolidatedEntry('Reviewed test interval', 'Summary', second, record.consolidationId);
  assert.equal(same.entryId, written.entryId);
  assert.equal(fs.readFileSync(written.filePath, 'utf8').split(`<!-- aslan-entry-id: ${written.entryId} -->`).length, 2);
  assert.equal(JSON.parse(fs.readFileSync(written.metaPath, 'utf8')).kind, 'consolidated');
  assert.equal(ledger.canSplit(record.consolidationId), false);
  ledger.setBranch(record.consolidationId, 'memory', { status: 'none', reason: 'Reviewed; nothing durable' });
  assert.equal(ledger.canSplit(record.consolidationId), true);
  assert.equal(require('../lib/memory-metadata').DEFAULT_MEMORY_DIR, path.join(process.env.ASLAN_DATA_DIR, 'memory'));
}

function main() {
  const defaults = normalizeParticipantConfig();
  assert.equal(defaults.roomId, 'main');
  assert.deepEqual(defaults.participantIds, ['owner', 'dawn', 'lumen']);
  const custom = {
    roomId: 'stable-room',
    participants: {
      human: { id: 'reader', name: 'Reader' },
      agents: [{ id: 'alpha', name: 'Alpha', runtime: 'claude' }, { id: 'beta', name: 'Beta', runtime: 'codex' }],
    },
  };
  for (const invalid of [null, [], { roomId: '../escape' }, { participants: {} },
    { participants: { ...custom.participants, human: { id: 'alpha' } } },
    { participants: { ...custom.participants, human: { id: 'constructor' } } },
    { participants: { ...custom.participants, human: { id: '../escape' } } },
    { participants: { ...custom.participants, agents: [custom.participants.agents[0]] } },
    { participants: { ...custom.participants, agents: custom.participants.agents.map((a) => ({ ...a, runtime: 'claude' })) } },
  ]) assert.throws(() => normalizeParticipantConfig(invalid));

  const tempBase = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempBase, 'aslan-oss-storage-'));
  try {
    const configDir = path.join(root, 'config');
    fs.mkdirSync(configDir);
    assert.equal(loadParticipantConfig({ configDir }).humanId, 'owner');
    const env = { ...process.env, ASLAN_CONFIG_DIR: path.join(root, 'default-config'), ASLAN_DATA_DIR: path.join(root, 'default-data') };
    for (const key of ['ASLAN_TALKS_DIR', 'ASLAN_DIARY_DIR', 'ASLAN_MEMORY_DIR', 'MEMORY_DIR']) delete env[key];
    runChild('storage', env);
    const configPath = path.join(configDir, 'group.json');
    fs.writeFileSync(configPath, JSON.stringify(custom));
    env.ASLAN_CONFIG_DIR = configDir;
    env.ASLAN_DATA_DIR = path.join(root, 'custom-data');
    runChild('storage', env);

    const metadataPath = path.join(env.ASLAN_DATA_DIR, 'talks', 'groups', custom.roomId, 'room.json');
    const oldMetadata = fs.readFileSync(metadataPath, 'utf8');
    const renamed = JSON.parse(JSON.stringify(custom));
    renamed.participants.human.name = 'Another display name';
    renamed.participants.agents.reverse();
    fs.writeFileSync(configPath, JSON.stringify(renamed));
    runChild('read-existing', env);
    assert.equal(fs.readFileSync(metadataPath, 'utf8'), oldMetadata, 'names/order must not rewrite room identity');
    renamed.participants.human.id = 'replacement';
    fs.writeFileSync(configPath, JSON.stringify(renamed));
    runChild('identity-conflict', env);
    assert.equal(fs.readFileSync(metadataPath, 'utf8'), oldMetadata);
    fs.writeFileSync(configPath, '{broken');
    assert.throws(() => loadParticipantConfig({ configDir }), /Invalid participant configuration/);

    console.log('Storage configuration checks passed: defaults, validation, custom owners, delivery, handoff, redaction/idempotency, budgets, diary/consolidation, identity continuity.');
  } finally {
    // Delete only the test-created directory, never an environment-supplied data root.
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), tempBase);
    assert.ok(path.basename(resolved).startsWith('aslan-oss-storage-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

if (process.argv[2] === 'storage') {
  checkStorage();
} else if (process.argv[2] === 'read-existing') {
  const config = require('../lib/participant-config').getParticipantConfig();
  const group = require('../lib/group');
  assert.ok(group.readAfter(config.roomId, {}).length > 0);
  assert.ok(group.getCursors(config.roomId).alpha.contextThrough);
} else if (process.argv[2] === 'identity-conflict') {
  const config = require('../lib/participant-config').getParticipantConfig();
  const group = require('../lib/group');
  assert.throws(() => group.readAfter(config.roomId, {}), /Participant identities differ/);
  assert.throws(() => group.getCursors(config.roomId), /Participant identities differ/);
  assert.throws(() => group.appendEvent(config.roomId, { kind: 'message', author: config.humanId, text: 'Must not write' }), /Participant identities differ/);
} else {
  main();
}
