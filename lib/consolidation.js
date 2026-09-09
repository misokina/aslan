/**
 * 整理（T09）的触发判断 —— 纯函数，不碰文件系统。
 *
 * 出发点：上下文攒到一定水位就整理一次 —— 把细节从内存里放掉，留下重点。
 *
 * ⚠ **「窗口有多满」的阈值一律存比例。** 上下文窗口各家各版本都不同
 * （gpt-5.6-sol 272k、可到 872k；Claude 看模型和有没有 `[1m]`），
 * 而且各家的窗口大小和额度口径一直在变。写死数字迟早对不上。
 *
 * ⚠ **但不是所有阈值都该是比例，下面两个故意是绝对 token 数：**
 *
 * - `hardHeadroomMinTokens` —— 这是**做整理本身需要的空间**。整理要读一段上下文、
 *   写日记、判断记忆，这件事有一个真实的最小开销，和窗口多大无关。
 *   窗口越小它越会压过 `hardHeadroomRatio`，那是**对的**：小窗口本来就该更早整理。
 * - `minNewTokensForCrossDay` —— 这是**「够不够得上一段值得写的经历」**。
 *   一天聊了 8k tokens 就是一天，不因为窗口是 200k 还是 1M 而改变。
 *
 * 分界线是：**问「窗口有多满」的用比例，问「够不够做/够不够写」的用绝对数。**
 * 2026-08-30 眠灯提出把这两个也改成比例，我没改，理由就是上面这条。
 * ⚠ 这两个数本身是**估的**，没有实测依据 —— 有数据了就调，但别把它们改成比例。
 *
 * ⚠ **别把 120k 搬回来当阈值。** 那个数是按**缓存成本**推的（PLAN 六 §3），
 * 而这里的目标是**腾出工作记忆** —— 两个目标不一样。120k 对 200k 窗口恰好 60%，对 272k 就偏早。
 *
 * 判断结果只说「该不该整理、为什么」。开账本、唤醒、切会话都在调用方。
 * ⚠ 而且：写出日记和记忆本身**不释放上下文**，只有之后真的切了会话才算。
 */
'use strict';

const DEFAULTS = Object.freeze({
  enabled: false,
  softRatio: 0.55,
  hardHeadroomRatio: 0.20,
  hardHeadroomMinTokens: 30000,
  crossDay: true,
  minNewTokensForCrossDay: 8000,
  cooldownMinutes: 30,
  // ── 留尾巴：整理旧的那段，最近若干条原文原样留在上下文里 ──
  // ⚠ 这两个也是**绝对数**，和上面那条分界线一致：它们问的是
  // 「够不够接上刚才那段话」，不是「窗口有多满」。50 条对 25 万窗口和 100 万窗口
  // 是同样的一段对话。
  keepTailMessages: 50,
  keepTailTokens: 24000,
});

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cfg = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const v = src[key];
    // 类型对不上就用默认值 —— 配置写错了不该让整理静默失灵
    if (typeof v === typeof DEFAULTS[key] && v !== null) cfg[key] = v;
  }
  // 比例落在合理区间外没有意义，夹回去而不是照用
  cfg.softRatio = clamp(cfg.softRatio, 0.1, 0.95);
  cfg.hardHeadroomRatio = clamp(cfg.hardHeadroomRatio, 0.02, 0.5);
  cfg.hardHeadroomMinTokens = Math.max(0, Math.round(cfg.hardHeadroomMinTokens));
  cfg.minNewTokensForCrossDay = Math.max(0, Math.round(cfg.minNewTokensForCrossDay));
  cfg.cooldownMinutes = Math.max(0, cfg.cooldownMinutes);
  // ⚠ 下限是 1 不是 0：留 0 条尾巴就是退回「只给一张收据」的老形态，
  // 而那正是「上下文突然从一整段变成小段」这个体感问题要修的东西。
  // 想关掉留尾巴不该靠把它填 0。
  cfg.keepTailMessages = Math.max(1, Math.round(cfg.keepTailMessages));
  cfg.keepTailTokens = Math.max(500, Math.round(cfg.keepTailTokens));
  return cfg;
}

/**
 * 粗估一段文本多少 token。
 *
 * ⚠ **是估的，不是量的。** 中文按一字一 token、其余按四字符一 token ——
 * 只用来决定尾巴划在哪儿，划偏几条不会出事（尾巴是「多带一点」的方向）。
 * 别拿它去做水位判断：那边用的是 CLI usage 里的真实数（lib/context-usage.js）。
 */
function estimateTextTokens(text) {
  const s = String(text == null ? '' : text);
  let wide = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    // CJK 统一表意 + 扩展A + 兼容表意 + 全角标点：这些基本一字一 token
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) wide++;
  }
  return Math.ceil(wide + (s.length - wide) / 4);
}

/**
 * 从会话末尾往回划出「留下不整理」的那一段原文尾巴。
 *
 * 三条边界（缺一条都会让尾巴悄悄失效）：
 *   1. 尽量按完整的一问一答划边界 —— 别为了卡住第 50 条把问题和回答分开；
 *   2. 最新单条本身就超预算时**不能悄悄让 keep = 0**（那等于退回没有尾巴）；
 *   3. `through >= from` 由调用方保证 —— 全留在尾巴里就没有旧段可整理，
 *      不能生成负下标的账本。这里只负责划线，不开账本。
 *
 * @param {Array} messages - session.messages
 * @param {object} cfg - normalizeConfig 的结果
 * @returns {{tailStart:number, tailCount:number, tailTokens:number, budgetExceeded:boolean}}
 *   tailStart = 尾巴的第一条下标；整理区间是 [from, tailStart - 1]
 */
function planTail(messages, cfg) {
  const list = Array.isArray(messages) ? messages : [];
  const total = list.length;
  if (total === 0) return { tailStart: 0, tailCount: 0, tailTokens: 0, budgetExceeded: false };

  const maxCount = Math.min(cfg.keepTailMessages, total);
  const maxTokens = cfg.keepTailTokens;

  // 至少留 1 条：先无条件收下最后一条，再往前长。
  // ⚠ 所以「最后一条自己就超预算」时 keep = 1 而不是 0，budgetExceeded 标出来让调用方看得见。
  let tokens = estimateTextTokens(list[total - 1] && list[total - 1].content);
  let start = total - 1;
  while (start > 0 && (total - start) < maxCount) {
    const next = estimateTextTokens(list[start - 1] && list[start - 1].content);
    if (tokens + next > maxTokens) break;
    tokens += next;
    start -= 1;
  }

  // 边界往前吸到一条 user 上，让尾巴从「他说的那句」开始，而不是从半截回答开始。
  // ⚠ 只往**前**吸（尾巴变大）—— 往后推会把没整理的消息挤出去，那就是静默丢失。
  // ⚠ 最多回看 10 条：连着十条 assistant 的话就认原来的边界，不让它无限往回滑。
  const SNAP_LIMIT = 10;
  for (let i = 0; i < SNAP_LIMIT && start > 0; i++) {
    if (list[start] && list[start].role === 'user') break;
    start -= 1;
    tokens += estimateTextTokens(list[start] && list[start].content);
  }

  return {
    tailStart: start,
    tailCount: total - start,
    tailTokens: tokens,
    budgetExceeded: tokens > maxTokens,
  };
}

/**
 * 「可以切了」这张提醒 —— **不是通知已经切了**。
 *
 * 要不要切由当前 agent 自己判断，这一层只负责提醒。
 *
 * ⚠ 这条改的是**谁做决定**。在这之前是服务端到点就切，而服务端根本不知道
 * 「手上有没有活」—— 它看得见的只有「进程在不在跑」，看不见一句话说到一半、
 * 也看不见「刚才那个报错还没查完」。当事的那个知道，所以决定权归他。
 *
 * ⚠ 所以这张纸条**必须读起来像提醒，不像命令**。写成「请执行」的话，
 * 醒来的那个会当成待办照做 —— 那就等于把决定权又拿回来了，只是绕了一圈。
 */
function buildSplitReminder(record, command) {
  if (!record || !record.consolidationId || !record.source) return null;
  const src = record.source;
  const diary = record.diary || {};
  const memory = record.memory || {};
  const memoryIds = Array.isArray(memory.ids) ? memory.ids.filter(Boolean) : [];

  return [
    '◎ 有一段上下文**可以**换掉了 —— 产物都已经落盘，随时可以切。**切不切、什么时候切，你自己定。**',
    '',
    `区间：${src.fromEvent} → ${src.throughEvent}`,
    diary.entryId ? `日记：\`${diary.entryId}\`` : `日记：${diary.status || '未知'}`,
    memory.status === 'none'
      ? '记忆：这一段判断过，没有值得单独留下的（合法结论）。'
      : memoryIds.length ? `记忆：${memoryIds.map((id) => `\`${id}\``).join('、')}`
        : `记忆：${memory.status || '未知'}`,
    '',
    '切了会发生什么：更早的那段从上下文里放掉，**最后一段原文照原样留着**，',
    '外加一张收据告诉你东西存到哪儿了。切完之后手上的工具调用记录不会跟过来。',
    '',
    '**所以别在做事做到一半的时候切。** 手上这摊结束了、或者要换话题了，再切。',
    '',
    `想切就跑：\`${command}\``,
    '',
    '⚠ 不切也完全可以，这不是待办。下次还会再提醒你一次。',
  ].join('\n');
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), hi);
}

function localDayString(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * @param {object} m 当时的水位
 *   contextTokens        现在用了多少
 *   contextWindowTokens  窗口多大
 *   baselineTokens       上一个整理边界处的水位（可空，默认 0）
 *   lastConsolidatedAt   上次整理时间（ISO，可空）
 *   lastUpdatedAt        会话上次活动时间（ISO，可空）—— 用来判跨天
 *   now                  Date
 * @returns {null|{reason, contextTokens, contextWindowTokens, ...}}
 *   ⚠ 返回的水位要原样写进账本的 trigger，以后才能拿真实数据回头调阈值
 */
function evaluateTrigger(m, config) {
  const cfg = normalizeConfig(config);
  if (!cfg.enabled) return null;

  const contextTokens = Number(m && m.contextTokens);
  const windowTokens = Number(m && m.contextWindowTokens);
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return null;
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) return null;

  const now = m.now instanceof Date ? m.now : new Date();
  const base = { contextTokens, contextWindowTokens: windowTokens };

  // 硬触发：离上限只剩这么多了。
  // ⚠ 冷却拦不住硬触发 —— 再撞一次就真没空间了，那时候连整理都跑不动
  const headroom = Math.max(cfg.hardHeadroomMinTokens, Math.round(windowTokens * cfg.hardHeadroomRatio));
  if (contextTokens >= windowTokens - headroom) {
    return { ...base, reason: 'hard', headroom };
  }

  const last = m.lastConsolidatedAt ? Date.parse(m.lastConsolidatedAt) : NaN;
  const cooledDown = !Number.isFinite(last)
    || (now.getTime() - last) >= cfg.cooldownMinutes * 60 * 1000;
  if (!cooledDown) return null;

  // 软触发：本轮已经结束了，找个自然边界整理
  const softAt = Math.round(windowTokens * cfg.softRatio);
  if (contextTokens >= softAt) {
    return { ...base, reason: 'soft', thresholdTokens: softAt, ratio: cfg.softRatio };
  }

  // 跨天。⚠ 只是**软边界** —— 当天只说了几句就别为了日期机械跑一次，所以有下限。
  //
  // ⚠ 比的是**上个整理边界之后新增的量**，不是总量（眠灯 2026-08-30 指出来的，我原来写错了）：
  // 一个带着大段启动上下文 resume 出来的会话，总量轻松过 8k，
  // 但那天可能一句话都没说 —— 拿总量比就会为一个空白的日子跑一次整理。
  if (cfg.crossDay && m.lastUpdatedAt) {
    const baseline = Number(m.baselineTokens);
    const newTokens = contextTokens - (Number.isFinite(baseline) && baseline > 0 ? baseline : 0);
    const lastDay = localDayString(new Date(m.lastUpdatedAt));
    const today = localDayString(now);
    if (lastDay && today && lastDay !== today && newTokens >= cfg.minNewTokensForCrossDay) {
      return { ...base, reason: 'crossDay', since: lastDay, newTokens };
    }
  }
  return null;
}

/**
 * 收据：整理完、上下文被换掉之后，给下一段上下文留的那张纸条。
 *
 * ⚠ 它解决的是一个具体的失败：整理把一段经历压成了日记和记忆，
 * 然后上下文被换掉 —— **新的那一段不知道刚刚发生过这件事，也不知道东西存到哪去了。**
 * 眠灯 2026-08-30 的说法是「让下一段工作内存知道自己可以去哪里找回来」。
 *
 * ⚠⚠ **故意不写「未完成事项」。** 眠灯 2026-08-31 的提醒：
 * 那个字段现在没有显式的结构化来源，唯一的来源是 agent 回复的正文 ——
 * 从回复里推断结果，正是我们定过「server 不从回复猜判断结果」要避免的那件事。
 * 宁可这一版少一个字段，也别开这个口子。
 *
 * ⚠ 这是**纯函数**：不落盘、不读文件。落盘和幂等由调用方负责，
 * 而且必须**在切上下文之前**落稳（否则崩在「旧的已切、新的还没注入」之间，桥就没了）。
 *
 * @param {object} record - 账本记录（lib/consolidate.js 的 readConsolidation 结果）
 * @returns {string|null} 收据正文；record 不完整时返回 null（宁可没有，也不要一张错的）
 */
function buildReceipt(record) {
  if (!record || !record.consolidationId || !record.source) return null;
  const src = record.source;
  const diary = record.diary || {};
  const memory = record.memory || {};

  const memoryIds = Array.isArray(memory.ids) ? memory.ids.filter(Boolean) : [];
  // ⚠ `none` 是**合法结论**（认真看过、没有值得留的），和 `pending`（压根没跑到）不是一回事。
  // 收据里要说得出区别 —— 说不出来就又是一次静默失败
  const memoryLine = memory.status === 'none'
    ? '这一段判断过，没有值得单独留下的记忆（那是合法结论，不是漏做）。'
    : memoryIds.length
      ? `记忆：${memoryIds.map((id) => `\`${id}\``).join('、')}`
      : `记忆：${memory.status || '未知'}（没有 id）`;

  return [
    '◎ 上一段上下文被整理过了，这是收据 —— 不是待办，是**东西存到哪儿了**。',
    '',
    `区间：${src.fromEvent} → ${src.throughEvent}（${src.kind}${src.sessionId ? ' ' + String(src.sessionId).slice(0, 8) : ''}）`,
    diary.entryId ? `日记：\`${diary.entryId}\`` : `日记：${diary.status || '未知'}`,
    memoryLine,
    '',
    '⚠ 原文还在，只是不在你上下文里了。要复核就去读上面那条日记；',
    `账本：\`node lib/consolidate.js read ${record.consolidationId}\``,
    '',
    '⚠ **不用现在就去读。** 这张纸条的作用是让你知道有东西可以找回来，不是要你先做一遍功课。',
  ].join('\n');
}

module.exports = {
  DEFAULTS, normalizeConfig, evaluateTrigger, localDayString, buildReceipt,
  estimateTextTokens, planTail, buildSplitReminder,
};
