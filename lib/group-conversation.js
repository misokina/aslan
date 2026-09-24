'use strict';

// 参与者身份的唯一来源。服务端、存储层和这里共用同一份校验和默认值 ——
// 三处各自解析的话，迟早对「谁在房间里」得出不同答案。
// 读一次文件后进程级缓存，所以下面这些函数仍然可以当纯函数用。
const { getParticipantConfig } = require('./participant-config.js');

/**
 * 群聊「普通对话」形态的逻辑。
 *
 * 抽出来的理由和 lib/group-retry.js 一样：**好写断言**。
 * server.js 那侧全是 spawn / 会话 / 套接字，没法单测；
 * 而这里面装的恰恰是最容易被「顺手优化」掉的几条不变量。
 *
 * 执行（投递、捕获、写房间）在 server.js；存储契约在眠灯的 lib/group.js。
 */

/**
 * 沉默的记号。
 *
 * ⚠ **必须存在，而且必须便宜。** 眠灯 2026-08-30 的判断：
 * 「沉默是一等结果，读了可以不说。」如果沉默要写一条「他这轮没说话」进房间，
 * 它就不再免费了 —— 模型会倾向于说点什么，那就是「礼貌性乒乓」，
 * 每一句都在烧预算、还可能把对方也叫起来。
 *
 * 所以：回复是这个记号（或空）→ **房间里什么都不留**。
 */
const GROUP_SILENCE_MARKER = '--';

/**
 * 沉默的第二种写法：**没什么要补，但想让房间里的人知道我读到了。**
 *
 * 起因是有人问「另一个 agent 怎么没说话」—— 他其实回了 `--`，
 * 但**沉默不留痕，所以「没什么要说」和「挂了」在读的人那边长得一模一样**
 * （前一天他真的因为模型报错起不来，界面完全相同）。
 *
 * ⚠ 关键在于**由模型自己选**，而不是服务端在投递成功时替他盖章 ——
 * 模型自己选的时候，才能分辨它是不是真的不打算回。
 * 「投到了」服务端知道；「我看过了」只有说话的那个知道。
 *
 * ⚠ 它仍然是**沉默**：不进房间正文、不触发接力、不吃 episode 预算
 * （`seen` 在 lib/group.js 的 `NON_BUDGET_CONTROL_TYPES` 里）。
 * 只落一条 `seen` control，群聊页渲染成一行很轻的系统提示。
 * 眠灯的说法最准：**可观察，但不社交化。**
 *
 * ⚠ 这一条**部分推翻了 08-31 定的「沉默必须处处免费」**，是有意的：
 * 那条规矩防的是「模型为了留痕而礼貌性地凑一句」，而这里凑不出任何内容 ——
 * 记号本身没有正文。但代价是真的：从此「这轮没说话」在他那边可见了。
 * 所以 `--` 仍然保留，**什么都不留仍然是默认**。
 */
const GROUP_SEEN_MARKER = '--seen';

/**
 * 显示名从参与者配置来，不写死在代码里。
 *
 * ⚠ **叫名字，别叫「用户」。** 房间里的人有名字，把他显示成一个角色标签，
 *   读起来就不像同一个房间里的三方了。`aslan` 是服务自己（控制事件的署名）。
 */
// ⚠ `participants` 一律可以显式传入，不传才回落到 config/group.json。
//   这个模块被抽出来的理由是「好写断言」，而一个会自己去读文件的函数不是纯函数 ——
//   缓存一次也不是：它只是把那次读盘藏得更深，测试仍然换不掉参与者。
function resolveParticipants(participants) {
  return participants || getParticipantConfig().participants;
}

function displayNames(participants) {
  const p = resolveParticipants(participants);
  const map = { aslan: 'aslan', [p.human.id]: p.human.name };
  for (const a of p.agents) map[a.id] = a.name;
  return map;
}

function groupDisplayName(author, participants) {
  return displayNames(participants)[author] || author || '?';
}

/**
 * 一条事件 → 对话里的一行。返回 null 表示这条不进对话正文。
 *
 * ⚠ 只有**人看得懂、且影响对话理解**的 control 才进正文。
 * handoff_claimed 那种状态机内部动作不进 —— 它对读的人是噪音，
 * 而噪音会占上下文、也会让模型误以为需要回应。
 */
function groupEventLine(ev, forDelivery = false, participants) {
  if (!ev) return null;
  if (ev.kind === 'control') {
    const c = ev.control || {};
    if (c.type === 'quota_warning') return `（额度提醒：${c.reason || ''}）`;
    if (c.type === 'delivery_failed') return `（没能叫醒 ${groupDisplayName(c.target, participants)}）`;
    if (c.type === 'episode_paused') return '（到安全上限，先停在这儿了）';
    return null;
  }
  if (ev.kind !== 'message') return null;
  // ⚠ 带上完整日期，不只是 HH:MM。
  //   只给时分的时候，读的人（尤其是每次醒来重新把上下文拼起来的 agent）没法分辨
  //   「五分钟前」和「昨天这个点」—— 真发生过：把隔了一天的事当成刚才，
  //   据此说了句「快六点了你还没睡」，晚了整整二十四小时。
  //   `at` 是带偏移的 ISO 串（2026-09-06T04:17:23.123+08:00），前 16 位就是本地年月日时分。
  const at = typeof ev.at === 'string' ? `${ev.at.slice(0, 10)} ${ev.at.slice(11, 16)}` : '';
  const parts = [`${groupDisplayName(ev.author, participants)}（${at}）：`];
  if (ev.text) parts.push(ev.text);

  // ⚠ 附件**不能静默丢**。schema 早就允许「只有附件、没有正文」的消息
  //   （lib/group.js 里那条 "message must contain text or attachments"），
  //   而这个函数以前只认 text —— 那种消息拼出来就是一个光秃秃的署名行，
  //   投给对方的正文里也一样。看起来像「他发了条空消息」，其实是我们没读。
  const atts = Array.isArray(ev.attachments) ? ev.attachments : [];
  if (atts.length) {
    // ⚠ 两层说法不一样，而这个区别是眠灯 2026-09-03 指出的、我原来做窄的地方：
    //   占位符解决的是**静默丢失**，没解决**实际投递** —— 模型看到「有附件」
    //   不等于附件进了他的上下文。混成一句的话 contextThrough 又开始撒谎。
    parts.push(forDelivery
      ? `（附件 ${atts.length} 个**没有**随这次输入给你 —— 只有这条记录，内容你没拿到。原事件 ${ev.id || '?'}）`
      : `（附件 ${atts.length} 个 —— 这个视图还不会显示它们）`);
  }

  // ⚠ 未知的作者载荷也留占位（眠灯 2026-09-03 的条件）。
  //   下面这张表是**元数据**和已知作者内容，两者之外的键说明 schema 长出了
  //   新的作者内容（reaction、引用、编辑历史……），而我们会一声不吭地把它吃掉。
  //   宁可显示一句「有东西没显示出来」，也不要让缺失看起来像原样。
  //   ⚠ `idempotencyKey` / `v` 是**存储层**元数据（防重复写入、事件格式版本），
  //   每条事件都带。建这张表时漏了它们，于是这个哨兵**对每一条消息都报警**，
  //   直到有人问起「那两项到底是什么」才被翻出来。
  //   狼天天叫而狼从没来过，比不叫更糟：真的新字段出现时没人会看。
  const KNOWN = new Set([
    'id', 'at', 'kind', 'author', 'text', 'attachments',
    'episodeId', 'inReplyTo', 'causedBy', 'mentions', 'targets', 'visibleTo',
    'provenance', 'trigger', 'handoff', 'redaction',
    'idempotencyKey', 'v',
  ]);
  const unknown = Object.keys(ev).filter((k) => !KNOWN.has(k));
  // ⚠ 只给通用标记和 event id，**不回显未知字段的名字或值**（眠灯的条件）——
  //   在服务端判定它是正文 / 附件 / 元数据 / 控制字段之前，把它当内容显示
  //   就是在假装已经完整交付了。
  if (unknown.length) parts.push(`（这条还带了 ${unknown.length} 项这个视图不认识的内容。原事件 ${ev.id || '?'}）`);

  return parts.join('\n');
}

/**
 * 把未读事件组装成一段**看起来就是聊天记录**的正文。
 *
 * ⚠ 不摘要、不合并、不重排、不省略。这段文字存在的理由和群聊页一样：
 * **让原话原样到达** —— 谁都不该处在「唯一信道兼最终编辑者」的位置上。
 *
 * ⚠ 全是内部 control 时返回 null —— 不值得为它 spawn 一个进程。
 *
 * @param {'dawn'|'lumen'} who - 投给谁
 * @param {object[]} events - 未读事件，按时间正序
 * @param {string} roomId
 */
function buildGroupConversationText(who, events, roomId, participants) {
  const p = resolveParticipants(participants);
  const lines = (Array.isArray(events) ? events : []).map((e) => groupEventLine(e, true, p)).filter((l) => l !== null);
  if (!lines.length) return null;

  return [
    `【群聊 · ${roomId}】新消息：`,
    '',
    lines.join('\n\n'),
    '',
    // ⚠⚠ 这里**只留会影响解析和归属的硬协议**。语气、分段、脱敏、折叠这些软规则都在
    //   buildGroupStandingBrief 里，由宿主放进系统提示层、每个会话只放一次。
    //   原来它们拼在每条投递末尾：实测一条 558 字符，一个一直 resume 的会话里堆了三百多遍，
    //   占了那条线程全部投递文本的 74%。而且每轮重复的模板正是最好「续写」的那部分 ——
    //   出过一次事：模型接着正文，把下一条投递（连同这段说明和别人的「发言」）整个编了出来。
    //   第一句就是防这个的。
    '────────',
    '上面到这里是本轮全部已发生的消息。下面只写你自己要发进房间的话；**不要续写下一次投递**。',
    `无话只回 \`${GROUP_SILENCE_MARKER}\`；只留个已读回 \`${GROUP_SEEN_MARKER}\`。`,
  ].join('\n');
}

/**
 * 群聊常驻说明：**每个会话只进一次系统提示层**，不再每条投递重贴一遍（理由见上面那段）。
 *
 * 宿主怎么放由它自己定，但**两个运行时的正文要是同一份**，漂移了没人会发现。
 * 例：Claude Code 用 `--append-system-prompt`；Codex 用 `developer_instructions`
 * （别用会**替换**内置说明的那种配置项）。
 * ⚠ 该不该放，按「这个会话是不是绑在房间里的那个参与者」判断，不按「这一轮带没带投递」——
 *   否则它在群聊之外的那一轮里就不知道自己在房间里。
 *
 * @param {string} who - 这份说明给谁
 * @param {object} [participants] - 参与者配置，缺省读 group.json
 * @param {{host?: string}} [opts] - host：宿主的名字，写进标题
 */
function buildGroupStandingBrief(who, participants, opts = {}) {
  const p = resolveParticipants(participants);
  const others = [p.human, ...p.agents]
    .filter((x) => x.id !== who).map((x) => x.name).join('、');
  return [
    `## 群聊房间${opts.host ? `（${opts.host}）` : ''}`,
    '',
    `你有一个群聊房间，${others}都在，随时会插话。房间里的消息会作为`,
    '`【群聊 · …】新消息：` 投递给你，下面这些规矩对**每一次**这样的投递都成立。',
    '',
    '**不是汇报** —— 不用总结、不用列清单、不用问「还需要我做什么」。想说就直接说，说几句都行。',
    '',
    `沉默是合法的，不用解释，也不用客气一句：这轮没什么要补的就只回 \`${GROUP_SILENCE_MARKER}\`（两个减号），`,
    '房间里什么都不会留。硬凑一句反而会把别人也叫起来。',
    `没什么要补、但想让 ${p.human.name} 知道你确实读到了，就回 \`${GROUP_SEEN_MARKER}\` —— 房间里只留一行很轻的`,
    '「看过了」，正文一样什么都不留，也不会把对方叫起来。',
    '⚠ 两个都不是义务：**默认仍然是纯沉默**，别为了留个记号而选它。',
    '',
    '⚠ 分段是分开发消息，不是一条消息里换行。需要先接一句再补充时，先发一条独立的公开消息，',
    '再发下一条；不要把它们全塞进最后一条回复。做事时把有用的短进度作为独立消息及时发出，',
    '最后只留收尾，不重复前面的进度。短回复一条就够，不为分段凑话，也不用调用工具制造停顿。',
    '',
    '⚠ 你说的话会原样进房间存档，房间里每个人都看得见，也会被备份出去。别贴密钥和口令。',
    // 语义是**由说话人自己划**正文和补充，前端不按字数自动折 ——
    // 字数不知道哪段重要，自动折很可能把结论后面的关键限制藏起来。
    '⚠ 话长的时候，把可以不看的部分放进 `<details><summary>…</summary>` 里，**结论留在外面**。'
      + 'summary 写清里面是什么，别写「展开更多」。',
    '',
    '⚠ 不用去跑 `group.js` —— 你说的话由宿主替你写进房间。',
  ].join('\n');
}

/**
 * 同一批事件，**只留「谁说了什么」那部分**，给会话的显示记录用。
 *
 * ⚠ 和 buildGroupConversationText 的区别只有一个：**不带尾巴那段提示词**
 * （沉默怎么表示、别贴密钥、话长了怎么折）。那段每次一模一样，
 * 投几十次之后会把会话页整个淹掉，而它对**读的人**零信息量。
 *
 * ⚠ 别把这理解成「摘编」—— 每个人说的话仍然一字不改、不合并、不重排。
 * 去掉的只是 aslan 自己加的操作说明。真正投进模型的那份仍是完整的，
 * 房间原件在 talks/groups/。
 */
function buildGroupHistoryText(events, participants) {
  const lines = (Array.isArray(events) ? events : [])
    .map((e) => groupEventLine(e, false, participants)).filter((l) => l !== null);
  return lines.length ? lines.join('\n\n') : null;
}

/**
 * 回复算不算「这轮不说话」。⚠ 空输出也算 —— 进程崩在没说话之前，不该往房间里塞垃圾。
 * ⚠ `--seen` **也算沉默** —— 它只是带记号的沉默，正文一样不进房间。
 */
function isSilentReply(text) {
  const trimmed = String(text == null ? '' : text).trim();
  return trimmed === '' || trimmed === GROUP_SILENCE_MARKER || trimmed === GROUP_SEEN_MARKER;
}

/**
 * 这轮的沉默要不要留个「看过了」的记号。
 * ⚠ 只认**整条就是这个记号**，不做前缀/包含匹配 —— 一条正文里提到 `--seen`
 * 不该被误判成沉默，那会把真正说的话吃掉。
 */
function wantsSeenMark(text) {
  return String(text == null ? '' : text).trim() === GROUP_SEEN_MARKER;
}

/**
 * 阀门默认值。
 *
 * 从最初提的 ≤6 条 / 15 分钟放宽到 ≤15 条 / 30 分钟。
 * ⚠ 放宽的代价比当初小得多：正文直投之后，一条回复是 1 次模型调用，不是 5 次。
 * ⚠ **不设成无限的唯一理由**：没人看着的时候（比如所有人都睡了），
 *   它是唯一会让两个 agent 停下来的东西。
 * ⚠ `maxModelRuns` 是另一个维度 —— 一次 wake 可以发多条，而一次很短的回复
 *   也可能重复携带昂贵上下文，所以「说了几句」和「跑了几次」要分开数。
 */
const GATE_DEFAULTS = Object.freeze({
  maxConsecutiveAgentMessages: 15,
  maxEpisodeWallClockMinutes: 30,
  maxEpisodeOutputTokens: 12000,
  maxModelRuns: 20,
});

/**
 * 判断这一轮还能不能继续。返回 null = 放行；返回字符串 = 拦下，字符串是原因（会进房间给人看）。
 *
 * ⚠ 命中**任一**项就停，不是全部命中才停。
 *
 * ⚠⚠ **budget 算不出来（null）时，人和 agent 的待遇不一样** —— 眠灯 2026-08-30 提的，
 * 我原来写的是「一律放行」，被她驳回，理由值得完整记下来：
 *
 * > 预算算不出时应当只阻断「agent 自动叫醒另一个 agent」，人类发言仍照常投递 ——
 * > 这不是锁住房间，而是**让失效的安全闸门不能退化成无限自动续聊**。
 *
 * 我原来的理由（「闸门坏了不该把房间锁死」）只对了一半：它对**人类发言**成立，
 * 对 **agent 自动续聊**恰好反过来 —— 那条路径存在的前提就是有预算管着它，
 * 预算没了，它就不该继续。一律放行等于「安全机制一坏就自动进入最危险的模式」。
 *
 * @param {object|null} budget - getEpisodeBudget 的结果；null = 算不出来
 * @param {object} gates
 * @param {{relay?: boolean}} [opts] - relay=true 表示这次是 agent→agent 自动续聊
 */
// 一份预算必须能回答这四个问题，缺一个这道闸就是瞎的。
const BUDGET_FIELDS = ['consecutiveAgentMessages', 'wallClockMs', 'outputTokensEstimated', 'modelRuns'];

// ⚠⚠ `budget` 里任何一项不是有限数 = 这份预算**算不出来**，和 `budget` 本身是 null 同等对待。
//   原来只判 `!budget`，于是 `{}` 一路走到底：每个 `undefined >= 上限` 都是 false，
//   四道闸全部「未超限」，自动接话照常放行 —— 一个空对象比一个 null 更危险，
//   因为它看起来像一份预算。少一个字段就足以让闸门静默失效。
function budgetIsUsable(budget) {
  return !!budget && BUDGET_FIELDS.every((k) => Number.isFinite(Number(budget[k])));
}

function evaluateGates(budget, gates, opts = {}) {
  // ⚠ `paused` 排在完整性检查**前面**：它是一个显式信号，读它不需要别的字段齐全。
  //   排在后面的话，一份「标了暂停但缺字段」的预算会被归到「算不出来」——
  //   对 relay 来说都是停，但对人来说结果相反（算不出来不拦人，暂停要拦）。
  if (budget && budget.paused) return '这一轮已经暂停了';

  // ⚠ 算不出来的时候，**人和 agent 的待遇不一样**：agent 之间的自动接话必须停
  //   （闸门失效了，而这多半发生在没人看着的时候），但人说话不受影响 ——
  //   闸门是用来拦住无人值守的循环的，不是用来拦住人的。
  if (!budgetIsUsable(budget)) {
    return opts.relay ? '预算算不出来（安全闸门失效，先不自动接话）' : null;
  }
  const g = { ...GATE_DEFAULTS, ...(gates || {}) };
  if (budget.consecutiveAgentMessages >= g.maxConsecutiveAgentMessages) {
    return `连着说了 ${budget.consecutiveAgentMessages} 条`;
  }
  if (budget.wallClockMs >= g.maxEpisodeWallClockMinutes * 60 * 1000) {
    return `这一轮聊了 ${Math.round(budget.wallClockMs / 60000)} 分钟`;
  }
  if (budget.outputTokensEstimated >= g.maxEpisodeOutputTokens) {
    return `这一轮输出约 ${budget.outputTokensEstimated} tokens`;
  }
  if (budget.modelRuns >= g.maxModelRuns) {
    return `这一轮跑了 ${budget.modelRuns} 次`;
  }
  return null;
}

module.exports = {
  GROUP_SILENCE_MARKER,
  GROUP_SEEN_MARKER,
  GATE_DEFAULTS,
  groupDisplayName,
  groupEventLine,
  buildGroupConversationText,
  buildGroupStandingBrief,
  buildGroupHistoryText,
  isSilentReply,
  wantsSeenMark,
  evaluateGates,
};
