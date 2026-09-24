#!/usr/bin/env node
'use strict';

// 主要是纯逻辑断言：触发判断、群聊对话文本、补投挑选。
// 唯一碰文件系统的是「触发理由 → 账本」接缝；它只在系统临时目录真实开账并当场清理。
// 不起服务、不调模型。
//
// ⚠ 这里钉的每一条都对应一次真实的失败或一条容易被「顺手优化」掉的不变量。
// 如果某条断言看起来多余，先去读它上面那段注释再决定删不删。

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const consolidation = require('../lib/consolidation');
const consolidationLedger = require('../lib/consolidate');
const gc = require('../lib/group-conversation');
const { pickRetryTarget } = require('../lib/group-retry');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`\n✗ ${name}\n  ${err.message}\n`);
    process.exitCode = 1;
  }
}

// ══════════════════════════════════════════════════════════════════
// 整理的触发判断
// ══════════════════════════════════════════════════════════════════

const {
  evaluateTrigger, normalizeConfig, planTail, buildReceipt, buildSplitReminder,
  OPEN_TRIGGER_REASONS,
} = consolidation;
const full = (over) => ({ contextTokens: 190000, contextWindowTokens: 200000, ...over });

test('总开关关着就什么都不触发', () => {
  assert.equal(evaluateTrigger(full(), { enabled: false }), null);
  // 默认必须是关的：它会在没人看着的时候换掉一个正在跑的会话的上下文，
  // 这种事不该靠「忘了配置」来启用。
  assert.equal(consolidation.DEFAULTS.enabled, false);
});

test('水位读不出来就不猜', () => {
  assert.equal(evaluateTrigger({ contextWindowTokens: 200000 }, { enabled: true }), null);
  assert.equal(evaluateTrigger({ contextTokens: 100 }, { enabled: true }), null);
  assert.equal(evaluateTrigger({ contextTokens: 0, contextWindowTokens: 0 }, { enabled: true }), null);
});

// ⚠ 反直觉但故意的：硬触发**不受冷却限制**，也不看有没有新消息。
//   它问的不是「该整理了吗」，是「再撑一轮还有没有空间」——
//   等到真撞上限的时候，连做整理本身都跑不动了。
//   谁要给它加冷却，先想清楚撞上限那次怎么办。
test('硬触发不受冷却限制', () => {
  const justConsolidated = full({ lastConsolidatedAt: new Date().toISOString() });
  const r = evaluateTrigger(justConsolidated, { enabled: true });
  assert.equal(r && r.reason, 'hard', '刚整理过也挡不住硬触发 —— 空间是物理约束，不是节奏问题');
});

test('软触发受冷却限制', () => {
  const cfg = { enabled: true };
  const at60 = { contextTokens: 120000, contextWindowTokens: 200000 };
  assert.equal(evaluateTrigger(at60, cfg).reason, 'soft');
  const cooling = { ...at60, lastConsolidatedAt: new Date().toISOString() };
  assert.equal(evaluateTrigger(cooling, cfg), null, '冷却期内不该反复软触发');
});

// ⚠ 运行时可以先压缩自己的上下文，水位因此变低；但没审阅过的原始经历并没有消失。
//   欠账是第二种「装了多少」，不是日期维度。
test('低水位也会按未整理欠账触发', () => {
  const cfg = { enabled: true };
  const backlog = (eligible) => ({
    contextTokens: 40000,
    contextWindowTokens: 258400,
    eligibleUnreviewedTokens: eligible,
    unreviewedTokens: eligible + 24000,
  });

  assert.equal(evaluateTrigger(backlog(23999), cfg), null, '刚低于一整个尾巴预算不触发');
  const r = evaluateTrigger(backlog(24000), cfg);
  assert.equal(r && r.reason, 'backlog', '达到下限就该触发，不能被低水位藏掉');
  assert.equal(r.eligibleUnreviewedTokens, 24000);
  assert.equal(r.thresholdTokens, 24000);
  assert.equal(r.unreviewedTokens, 48000, '原始欠账量也要带回去，方便宿主记录和调阈值');
});

test('欠账服从冷却且排在水位触发之后', () => {
  const base = {
    contextTokens: 40000, contextWindowTokens: 258400, eligibleUnreviewedTokens: 99000,
  };
  assert.equal(evaluateTrigger({ ...base, lastConsolidatedAt: new Date().toISOString() }, { enabled: true }), null,
    '欠账和 soft 同级，冷却期内不能反复开账');
  assert.equal(evaluateTrigger({ ...base, contextTokens: 200000 }, { enabled: true }).reason, 'soft',
    '水位已经很高时先报更紧急的 soft');
  assert.equal(evaluateTrigger({ ...base, contextTokens: 250000 }, { enabled: true }).reason, 'hard',
    'hard 仍然压过所有理由');
});

test('欠账阈值不能用 0 悄悄改成永远触发', () => {
  assert.ok(normalizeConfig({ minRetiredTokens: 0 }).minRetiredTokens >= 500);
  assert.equal(evaluateTrigger({ contextWindowTokens: 258400, eligibleUnreviewedTokens: 99000 }, { enabled: true }), null,
    '水位未知时整拍不判断，欠账也不能把 unknown 当成 0');
});

// ⚠ 这条钉的是两个模块的接缝，不是任何一边自己的功能：
//   触发器能产出一个 reason，但账本不认识它时，两边的单测都可能各自全绿。
//   合法集合只能从触发模块导出，测试也遍历同一份集合，不能再手抄第二张表。
test('每个活跃触发理由都能真实开账，退役理由只读旧账', () => {
  const tempBase = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempBase, 'promise-trigger-reasons-'));
  const owner = require('../lib/participant-config').getParticipantConfig().agentIds[0];
  const opts = { configDir: dir, now: new Date('2026-09-18T00:00:00.000Z') };

  try {
    assert.ok(OPEN_TRIGGER_REASONS.includes('backlog'), '欠账必须是活跃理由');
    assert.ok(!OPEN_TRIGGER_REASONS.includes('crossDay'), '跨天理由已经退役，不能再开新账');

    for (const [index, reason] of OPEN_TRIGGER_REASONS.entries()) {
      const record = consolidationLedger.openConsolidation({
        owner,
        source: {
          kind: 'session', sessionId: `reason-${index}`, fromEvent: 'msg-0', throughEvent: 'msg-1',
        },
        trigger: { reason, contextTokens: 100, contextWindowTokens: 1000 },
      }, opts);
      assert.equal(record.trigger.reason, reason, `账本必须接受共享注册表里的 ${reason}`);
    }

    assert.throws(() => consolidationLedger.openConsolidation({
      owner,
      source: { kind: 'session', sessionId: 'retired-cross-day', fromEvent: 'msg-0', throughEvent: 'msg-1' },
      trigger: { reason: 'crossDay', contextTokens: 100, contextWindowTokens: 1000 },
    }, opts), /Invalid trigger reason: crossDay/, '退役理由不能再开新账');

    const legacySeed = consolidationLedger.openConsolidation({
      owner,
      source: { kind: 'session', sessionId: 'legacy-cross-day', fromEvent: 'msg-0', throughEvent: 'msg-1' },
      trigger: { reason: 'manual', contextTokens: 100, contextWindowTokens: 1000 },
    }, opts);
    const legacyPath = path.join(dir, 'consolidations', `${legacySeed.consolidationId}.json`);
    const legacyRecord = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    legacyRecord.trigger.reason = 'crossDay';
    fs.writeFileSync(legacyPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, 'utf8');
    assert.equal(consolidationLedger.readConsolidation(legacySeed.consolidationId, opts).trigger.reason, 'crossDay',
      '退役前已经落盘的账仍然必须可读');
  } finally {
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved), tempBase, '只能清理由本测试建在系统临时目录下的目录');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

// ⚠ 留尾巴：整理旧的那段，最近若干条原文原样留着。
//   最新那条本身就超预算时**不能悄悄让 keep = 0** —— 那等于退回「只给一张收据」，
//   而「刚才那个」会失去落点。
test('尾巴至少留一条，哪怕它自己就超预算', () => {
  const cfg = normalizeConfig({ enabled: true });
  const huge = [{ content: 'x'.repeat(200000) }];
  const plan = planTail(huge, cfg);
  assert.equal(plan.tailCount, 1, '超预算也要留一条，不能静默变成没有尾巴');
  assert.equal(plan.budgetExceeded, true, '而且要如实说这次超了预算，别假装正常');
});

test('尾巴按配置的条数划边界', () => {
  const cfg = normalizeConfig({ enabled: true, keepTailMessages: 10, keepTailTokens: 999999 });
  // 每条都是 user，边界一划完就落在 user 上，不会再往前吸（见下一条）
  const msgs = Array.from({ length: 80 }, () => ({ role: 'user', content: 'x'.repeat(100) }));
  const plan = planTail(msgs, cfg);
  assert.equal(plan.tailCount, 10);
  assert.equal(plan.tailStart, 70);
});

// ⚠ 边界会往**前**吸，吸到一条 user 上为止（最多回看 10 条）——
//   让尾巴从「人说的那句」开始，而不是从半截回答中间开始。
//   ⚠ 只往前吸（尾巴变大）。往后推会把还没整理的消息挤出去，那就是静默丢失。
test('尾巴边界往前吸到一条 user 上', () => {
  const cfg = normalizeConfig({ enabled: true, keepTailMessages: 3, keepTailTokens: 999999 });
  const msgs = [
    { role: 'user', content: '问题' },
    { role: 'assistant', content: 'a' }, { role: 'assistant', content: 'b' },
    { role: 'assistant', content: 'c' }, { role: 'assistant', content: 'd' },
  ];
  const plan = planTail(msgs, cfg);
  assert.equal(plan.tailStart, 0, '应该一路吸到那条 user，让尾巴从问题开始');
  assert.equal(plan.tailCount, 5);
});

// ⚠ 全是 assistant、没有 user 可吸的时候，吸附要停在硬上限上，不能无限往回滑。
//   ⚠ 断言写死具体条数：写成 `<= 11` 的话，「一条都没吸」和「吸满 10 条」都算过 ——
//   那就没钉住任何东西。上限是 keepTailMessages(1) + SNAP_LIMIT(10) = 11。
test('连着一长串 assistant 时，吸附停在硬上限', () => {
  const cfg = normalizeConfig({ enabled: true, keepTailMessages: 1, keepTailTokens: 999999 });
  const msgs = Array.from({ length: 100 }, () => ({ role: 'assistant', content: 'x' }));
  const plan = planTail(msgs, cfg);
  assert.equal(plan.tailCount, 11, '1 条基础 + 最多回看 10 条，不能再多');
  assert.equal(plan.tailStart, 89);
});

test('没有消息就没有尾巴', () => {
  const plan = planTail([], normalizeConfig({ enabled: true }));
  assert.deepEqual(plan, { tailStart: 0, tailCount: 0, tailTokens: 0, budgetExceeded: false });
});

test('配置越界会被夹回合法区间', () => {
  const cfg = normalizeConfig({ enabled: true, keepTailMessages: 0, softRatio: 5 });
  assert.ok(cfg.keepTailMessages >= 1, '留 0 条尾巴不是一个可选项，想关掉它不该靠把它填 0');
  assert.ok(cfg.softRatio > 0 && cfg.softRatio <= 1);
});

// ══════════════════════════════════════════════════════════════════
// 收据
// ══════════════════════════════════════════════════════════════════

const ledger = (over) => ({
  consolidationId: 'c-1',
  source: { kind: 'session', sessionId: 's-1', fromEvent: 'msg-0', throughEvent: 'msg-24' },
  trigger: { reason: 'soft', contextTokens: 160000, contextWindowTokens: 200000 },
  diary: { status: 'written', entryId: 'e-1' },
  memory: { status: 'written', ids: ['m-1'] },
  ...over,
});

test('收据带齐区间、产物和账本 id', () => {
  const r = buildReceipt(ledger());
  assert.ok(r.includes('msg-0') && r.includes('msg-24'), '收据必须说明它覆盖哪一段');
  assert.ok(r.includes('e-1'), '要指得到那条日记');
  assert.ok(r.includes('m-1'), '要列出写下的记忆');
  assert.ok(r.includes('c-1'), '要带账本 id —— 那是回去读原文的唯一入口');
});

// ⚠⚠ 这是账本存在的**唯一理由**：
//   `none`（认真看过了，没有值得留下的）和 `pending`（压根没跑到）
//   在磁盘上长得一模一样 —— 两种情况都是「memory 目录里没有新文件」。
//   收据里分不开的话，这就是一次静默失败。
test('「没有值得留下的」和「压根没跑到」必须分得开', () => {
  const none = buildReceipt(ledger({ memory: { status: 'none', ids: [] } }));
  const pending = buildReceipt(ledger({ memory: { status: 'pending', ids: [] } }));
  assert.notEqual(none, pending,
    'none 和 pending 的收据不能一样 —— 分不开就等于把静默失败写进了收据');
  assert.ok(/合法结论|不是漏做/.test(none), 'none 要明说这是个结论，不是漏做');
});

test('没有账本就没有收据，不编一张', () => {
  assert.equal(buildReceipt(null), null);
  assert.equal(buildSplitReminder(null, 'x'), null);
});

// ⚠ 提醒不是命令：切不切、什么时候切，由当事的那个 agent 自己定 ——
//   这一层看不见他手上有没有活（一句话说到一半、一个报错还没查完）。
test('切分提醒把决定权交回去', () => {
  const r = buildSplitReminder(ledger(), 'node bin/split-now.js c-1');
  assert.ok(r.startsWith('【宿主 提醒】'), '没给人名就不假装这是谁新说的话');
  assert.ok(/你自己定/.test(r), '提醒必须把决定权交回去');
  assert.ok(/不是待办/.test(r), '并且明说它不是一件待办');
  assert.ok(r.includes('node bin/split-now.js c-1'), '要带上原样可执行的那条命令');
});

test('切分提醒的信封由宿主命名，水位交给当前 agent 判断', () => {
  const r = buildSplitReminder(
    ledger(),
    'node bin/split-now.js c-1',
    { contextTokens: 20000, contextWindowTokens: 200000, compactionEpoch: 2 },
    { host: '某宿主', human: '某人' },
  );
  assert.ok(r.startsWith('【某宿主 提醒 · 不是 某人 新说的话】'),
    '纸条占的是平时人说话的位置，宿主知道人名时必须把来源写清');
  assert.ok(r.includes('10%') && r.includes('20,000 / 200,000'), '要给现在的真实水位');
  assert.ok(r.includes('最近一次量到的上下文') && !r.includes('现在的上下文'),
    '只能说「最近一次量到的」—— 发这张条子本身就可能触发运行时压缩，宿主承诺不了「现在」');
  const stamped = buildSplitReminder(ledger(), 'split',
    { contextTokens: 20000, contextWindowTokens: 200000, observedAt: '2026-09-20T10:00:00+08:00' });
  assert.ok(stamped.includes('量到的时间 2026-09-20T10:00:00+08:00'), '量到的时间要带上，让读的人自己判断数有多新');
  assert.ok(r.includes('开这本账的时候是 80%'), '也要给开账时的水位，变化本身才有判断价值');
  assert.ok(r.includes('压缩过 **2 次**'), '运行时压缩事实要交给决策者，不能藏在宿主里');
  assert.ok(r.includes('水位已经不高了'), '低水位时要明说不切也可以');
  assert.ok(!/【Aslan|Codex|send_to_channel/.test(r), '公共模块不能漏出某个宿主、运行时或工具');
});

test('水位量不到就不编成 0', () => {
  const r = buildSplitReminder(ledger(), 'split', { contextTokens: null, contextWindowTokens: 200000 });
  // ⚠ 措辞从「现在的上下文」改成了「最近一次量到的上下文」—— 这里跟着改，不然这条永远成立、什么都拦不住
  assert.ok(!r.includes('量到的上下文') && !r.includes('现在的上下文'), 'unknown 就不显示，不拿 0% 冒充读数');
});

// ══════════════════════════════════════════════════════════════════
// 群聊：沉默、阀门、事件渲染
// ══════════════════════════════════════════════════════════════════

// ⚠ 沉默必须处处免费。一旦「这轮没什么要补」也要在房间里留一行，
//   它就不再免费 —— 模型下次就会倾向于凑一句话出来。
test('两种沉默都识别得出来', () => {
  assert.equal(gc.isSilentReply(gc.GROUP_SILENCE_MARKER), true);
  assert.equal(gc.isSilentReply('  --  '), true, '前后空白不该让沉默失效');
  assert.equal(gc.isSilentReply('--- 分割线'), false);
  assert.equal(gc.isSilentReply('有话要说'), false);
  assert.equal(gc.wantsSeenMark(gc.GROUP_SEEN_MARKER), true);
});

// 一份完整的预算：四项缺一不可，见 evaluateGates 里的 BUDGET_FIELDS。
const budget = (over) => ({
  consecutiveAgentMessages: 0, wallClockMs: 0, outputTokensEstimated: 0, modelRuns: 0, ...over,
});

test('阀门：连着说太多条就停', () => {
  const g = { maxConsecutiveAgentMessages: 3 };
  assert.equal(gc.evaluateGates(budget({ consecutiveAgentMessages: 2 }), g), null);
  assert.ok(gc.evaluateGates(budget({ consecutiveAgentMessages: 3 }), g));
});

test('阀门：一轮聊太久就停', () => {
  const g = { maxEpisodeWallClockMinutes: 30 };
  assert.ok(gc.evaluateGates(budget({ wallClockMs: 31 * 60 * 1000 }), g), '超过时长上限要停');
});

// ⚠⚠ budget 算不出来的时候，**人和 agent 的待遇不一样**：
//   agent 之间的自动接话必须停（安全闸门失效了，而没人看着），
//   但人说话不受影响 —— 闸门是用来拦住无人值守的循环的，不是用来拦住人的。
test('预算算不出来时：agent 停，人不停', () => {
  assert.ok(gc.evaluateGates(null, {}, { relay: true }), 'agent 自动接话必须停');
  assert.equal(gc.evaluateGates(null, {}, {}), null, '人说话不该被闸门拦住');
});

// ⚠⚠ **一个空对象比一个 null 更危险，因为它看起来像一份预算。**
//   原来只判 `!budget`，于是 `{}` 一路走到底：每个 `undefined >= 上限` 都是 false，
//   四道闸全「未超限」，自动接话照常放行 —— 闸门静默失效，而这多半发生在没人看着的时候。
test('畸形预算和缺失预算同等对待', () => {
  const relay = { relay: true };
  assert.ok(gc.evaluateGates({}, {}, relay), '空对象不是一份预算，不能当成「未超限」');
  assert.ok(gc.evaluateGates({ consecutiveAgentMessages: 1 }, {}, relay), '缺字段也不行');
  assert.ok(gc.evaluateGates({
    consecutiveAgentMessages: NaN, wallClockMs: 0, outputTokensEstimated: 0, modelRuns: 0,
  }, {}, relay), 'NaN 不是一个数值 —— 拿它比大小永远是 false');
  assert.ok(gc.evaluateGates({
    consecutiveAgentMessages: 0, wallClockMs: Infinity, outputTokensEstimated: 0, modelRuns: 0,
  }, {}, relay), 'Infinity 同理');

  // 反例：四项齐全且都在限内 → 放行
  assert.equal(gc.evaluateGates({
    consecutiveAgentMessages: 0, wallClockMs: 0, outputTokensEstimated: 0, modelRuns: 0,
  }, {}, relay), null, '一份完整而未超限的预算应该放行');
});

test('输出 token 和模型调用次数也各是一道闸', () => {
  const ok = { consecutiveAgentMessages: 0, wallClockMs: 0, outputTokensEstimated: 0, modelRuns: 0 };
  assert.ok(gc.evaluateGates({ ...ok, outputTokensEstimated: 99999 }, {}));
  assert.ok(gc.evaluateGates({ ...ok, modelRuns: 999 }, {}),
    '「说了几句」和「跑了几次」要分开数 —— 一次很短的回复也可能重复带上昂贵的上下文');
});

test('已经暂停的一轮不会被再次放行', () => {
  assert.ok(gc.evaluateGates(budget({ paused: true }), {}));
  // ⚠ 缺字段也要认得出暂停 —— paused 是显式信号，不该被「算不出来」盖过去
  assert.ok(gc.evaluateGates({ paused: true }, {}), '标了暂停就是暂停，不管别的字段全不全');
});

// ⚠ 时间戳带完整日期，不只是 HH:MM。
//   每次醒来重新把上下文拼起来的一侧，分不出「五分钟前」和「昨天这个点」——
//   真发生过：把隔了一天的事当成刚才，据此说错了一句话。
test('事件行带完整日期，不是裸的时分', () => {
  const line = gc.groupEventLine({
    kind: 'message', author: 'owner', text: '你们好呀',
    at: '2026-08-30T05:48:58.671+08:00',
  }, true);
  assert.ok(line.includes('2026-08-30 05:48'), '必须带年月日');
  assert.ok(line.includes('你们好呀'), '原话要原样出现 —— 这是房间存在的理由');
  assert.ok(!/（\d{2}:\d{2}）/.test(line), '不能出现只有时分的裸时间戳');
});

// ⚠ 未知字段哨兵**不能对每条消息都响**。真实事件都带 idempotencyKey / v
//   这类存储层元数据，把它们漏出白名单的话，这个哨兵会对每一条都报警 ——
//   狼天天叫而狼没来，真的新字段出现时就没人看了。
//
// ⚠⚠ 这条测试原来查的是 `/未显示|未知/`，而真实占位文案是「不认识的内容」——
//   **两个词都不匹配，所以它永远通过，什么都没测。**
//   一条只会通过的断言比没有断言更糟：它让人以为这里被守住了。
//   现在正反例都钉：元数据不报警、真的新字段要报警。
const OCCLUDED = /不认识的内容/;

test('存储层元数据不触发未知字段警告', () => {
  const withMeta = gc.groupEventLine({
    kind: 'message', author: 'owner', text: 'hi',
    at: '2026-08-30T05:48:58.671+08:00',
    id: 'e1', idempotencyKey: 'k1', v: 1, episodeId: 'ep1',
    inReplyTo: 'e0', causedBy: 'e0', mentions: [], targets: ['dawn'],
    visibleTo: ['owner'], provenance: {}, trigger: {}, handoff: null, redaction: null,
    attachments: [],
  }, true);
  assert.ok(!OCCLUDED.test(withMeta), '常规元数据不该被当成新的作者内容 —— 否则每条都报警');
});

test('真的多出一个字段时，必须留下占位', () => {
  const line = gc.groupEventLine({
    kind: 'message', author: 'owner', text: 'hi',
    at: '2026-08-30T05:48:58.671+08:00', id: 'e1',
    reactions: ['👍'],                       // schema 长出来的新作者内容
  }, true);
  assert.ok(OCCLUDED.test(line),
    '未知的作者内容必须留占位 —— 宁可说「有东西没显示」，也不要让缺失看起来像原样');
  // ⚠ 只给数量和 event id，**不回显字段名和值**：在判定它是正文/附件/元数据之前
  //   就把它显示出来，等于假装已经完整交付了。
  assert.ok(!line.includes('reactions'), '不该回显未知字段的名字');
  assert.ok(!line.includes('👍'), '更不该回显它的值');
});

// ⚠ 显示名必须能被调用方决定。这个模块被抽出来就是为了好写断言，
//   而一个自己去读 config 的函数，测试永远换不掉参与者。
test('参与者可以显式传入，不必去读配置文件', () => {
  const custom = {
    human: { id: 'ann', name: 'Ann' },
    agents: [{ id: 'a1', name: '甲', runtime: 'claude' }, { id: 'a2', name: '乙', runtime: 'codex' }],
  };
  const line = gc.groupEventLine({
    kind: 'message', author: 'ann', text: 'hi', at: '2026-08-30T05:48:58.671+08:00',
  }, true, custom);
  assert.ok(line.startsWith('Ann（'), `自定义显示名要生效，实际拿到：${line.slice(0, 20)}`);

  // 「谁在房间里」挪进了常驻说明（每个会话只放一次），投递正文里不再每轮重复
  const brief = gc.buildGroupStandingBrief('a1', custom, { host: '某宿主' });
  assert.ok(brief.includes('Ann、乙都在'), '「谁在房间里」那句要按传入的参与者拼');
  assert.ok(!brief.includes('甲'), '不该把收件人自己也算进「都在」里');
  assert.ok(brief.includes('让 Ann 知道你确实读到了'), '「已读」是给那个人看的，名字也按参与者来');
  assert.ok(brief.includes('（某宿主）'), '宿主名字由调用方给，公共模块不写死');
});

test('群聊提示词按参与者生成，不写死名字', () => {
  const text = gc.buildGroupConversationText('dawn', [{
    kind: 'message', author: 'owner', text: '在吗', at: '2026-08-30T05:48:58.671+08:00',
  }], 'main');
  assert.ok(text.includes('在吗'), '原话要原样到达');
  assert.ok(text.includes('main'), '要说明这是哪个房间');
  assert.ok(text.includes(gc.GROUP_SILENCE_MARKER), '必须告诉它沉默怎么写，否则沉默不是真的免费');
});

test('投递正文只留硬协议，软规则在常驻说明里', () => {
  const text = gc.buildGroupConversationText('dawn', [{
    kind: 'message', author: 'owner', text: '在吗', at: '2026-08-30T05:48:58.671+08:00',
  }], 'main');
  assert.ok(text.includes('不要续写下一次投递'),
    '出过一次事：模型接着正文把下一条投递（连同别人的「发言」）编了出来 —— 这句必须紧挨着原话');
  assert.ok(text.includes(gc.GROUP_SEEN_MARKER), '已读记号也影响落盘，和沉默一样属于硬协议');
  assert.ok(!text.includes('不是汇报') && !text.includes('<details>'),
    '软规则每轮重贴会在一个 resume 的会话里堆几百遍（实测占投递文本 74%），只放在常驻说明里');
  const brief = gc.buildGroupStandingBrief('dawn');
  for (const rule of ['不是汇报', gc.GROUP_SILENCE_MARKER, gc.GROUP_SEEN_MARKER, '<details>', '别贴密钥']) {
    assert.ok(brief.includes(rule), `常驻说明里要有：${rule}`);
  }
});

test('没有未读就不生成提示词', () => {
  assert.equal(gc.buildGroupConversationText('dawn', [], 'main'), null);
});

// ══════════════════════════════════════════════════════════════════
// 补投：只补本该叫醒他的
// ══════════════════════════════════════════════════════════════════

const failed = (target) => ({
  kind: 'control', author: 'aslan', control: { type: 'delivery_failed', target },
});

// ⚠ 判据是「未读里有指向它的投递失败」，不是「有未读」。
//   房间里有人说话，不等于在向谁提问 —— 不点名就不叫人。
test('有未读但没有投递失败，不补投', () => {
  const unread = [
    { kind: 'message', author: 'owner', text: '随便聊聊' },
    { kind: 'message', author: 'lumen', text: '嗯' },
  ];
  assert.equal(pickRetryTarget(unread, 'dawn'), null,
    '有人在房间里说话不等于在叫它 —— 不点名就不叫人');
});

// ⚠ 返回的是**当初那条消息**，不是失败记录本身 —— 要补投的是话，不是「投递失败了」这件事。
test('补投的是当初那条消息，不是失败记录', () => {
  const msg = { kind: 'message', id: 'm1', author: 'owner', text: '在吗', targets: ['dawn'] };
  const picked = pickRetryTarget([msg, { ...failed('dawn'), causedBy: 'm1' }], 'dawn');
  assert.equal(picked && picked.id, 'm1', '要把原消息挑出来重投');
  assert.equal(picked.kind, 'message', '重投的必须是消息，不是那条 control');
});

test('只补指向自己的那条失败', () => {
  const msg = { kind: 'message', id: 'm1', author: 'owner', text: '在吗', targets: ['dawn'] };
  assert.equal(pickRetryTarget([msg, failed('lumen')], 'dawn'), null,
    '别人的投递失败不该把自己叫起来');
  assert.equal(pickRetryTarget([msg, failed('dawn')], 'dawn').id, 'm1');
});

// ⚠⚠ causedBy 断了的时候，**只认点名了它的消息**。
//   这里原来是「退回到失败记录之前最近的一条」，不看点名 —— 实测的后果是：
//   一条只点名 lumen 的消息会被 delivery_failed(target=dawn) 挑中，补投给 dawn。
//   补投的内容和失败的那次根本不是一回事，而房间里看不出任何异常。
//   「最近的一条」不是因果，只是时间上的邻近。
test('causedBy 断了，不挑没点名自己的消息', () => {
  const events = [
    { kind: 'message', id: 'm1', author: 'owner', text: '眠灯你看下这个', targets: ['lumen'] },
    failed('dawn'),                                        // 没有 causedBy
  ];
  assert.equal(pickRetryTarget(events, 'dawn'), null,
    '宁可这次不补，也不要补错一条 —— 不补的话未读还在，补错了两边都以为对上了');
});

test('causedBy 断了，挑失败之前最近一条点名自己的', () => {
  const events = [
    { kind: 'message', id: 'm1', author: 'owner', text: '第一句', targets: ['dawn'] },
    { kind: 'message', id: 'm2', author: 'owner', text: '第二句', targets: ['dawn'] },
    { kind: 'message', id: 'm3', author: 'owner', text: '给眠灯的', targets: ['lumen'] },
    failed('dawn'),
    { kind: 'message', id: 'm4', author: 'owner', text: '失败之后又说的', targets: ['dawn'] },
  ];
  const picked = pickRetryTarget(events, 'dawn');
  assert.equal(picked && picked.id, 'm2',
    '要挑失败之前最近的、且点名了自己的那条：不是 m3（没点名它）也不是 m4（在失败之后）');
});

// ⚠ 取**最后一条**失败 —— 中间可能失败过很多次，补投要对着最近那次。
//   ⚠ 断言要指名道姓：写成 `picked.id !== 'first'` 的话，连 undefined 都能满足。
test('失败过多次时对着最近那次补', () => {
  const unread = [
    { kind: 'message', id: 'early', author: 'owner', text: '早先那句', targets: ['dawn'] },
    { ...failed('dawn'), id: 'f1', causedBy: 'early' },
    { kind: 'message', id: 'later', author: 'owner', text: '后来这句', targets: ['dawn'] },
    { ...failed('dawn'), id: 'f2', causedBy: 'later' },
  ];
  const picked = pickRetryTarget(unread, 'dawn');
  assert.equal(picked && picked.id, 'later', '要补最近那次失败对应的消息，不是第一次那条');
});

test('输入不合法时安静地返回 null', () => {
  assert.equal(pickRetryTarget(null, 'dawn'), null);
  assert.equal(pickRetryTarget([], 'dawn'), null);
  assert.equal(pickRetryTarget([failed('dawn')], null), null);
});

if (!process.exitCode) {
  console.log(`Pure logic checks passed (${passed} groups): trigger, tail, receipt, gates, silence, retry.`);
}
