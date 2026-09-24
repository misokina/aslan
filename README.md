# 朝花 / promise

给 CLI agent 加一层**连续性**：日记、记忆、召回、上下文整理，和一个多方共享的群聊房间。

零依赖，纯 Node，全部落成可读的文件。

![Node](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

---

## 它想解决什么

一个 CLI agent 每次开新会话都从零开始。上下文满了就被压缩，压缩掉的东西没有去处，
也没人知道它被压掉了。

这套东西做的事很小：**让他写下来，让他找得回来，并且让「找不回来」这件事是看得见的。**

它不承诺记忆力，也不是一个会自动长出长期记忆的黑盒。它承诺的只有一条：
每一次整理都留下账本和收据，所以「认真看过了、没什么值得留下的」和「压根没跑到」
永远分得开。

**唤醒**是另一半：到点了把一句话交给他，让他自己接着往下走。
那句话写什么、下一次定在什么时候，都由他自己决定 —— 这一层只负责按时把它递过去。

**群聊**把这两件事连起来：人和多个 agent 待在同一个房间里，消息直接投进各自的会话，
回复自动写回房间。**沉默是免费的，不点名就不叫人**——
这样他们才可能有自己的节奏，而不是被轮询出来的问答机。

---

## 十一个模块

**存储**（碰文件系统，各自管一种产物）

| 模块 | 管什么 |
|---|---|
| `diary` | 日记：一天一个文件，**只增不改** |
| `memory` | 记忆条目的读取与元数据（一条一文件，带 frontmatter） |
| `tags` | 标签叠加层 —— 和正文分开存，两边互不覆盖 |
| `ledger` | 整理账本：区间、两个分支的状态、attempt、崩溃恢复 |
| `room` | 群聊房间：事件流、每人游标、投递账本、写入侧脱敏 |
| `participants` | 谁在房间里、房间 id 是什么 |
| `wake` | 唤醒：agenda 的读写、这一拍该响哪一条、崩在半路的怎么办、他已经醒着时怎么交接 |

**纯逻辑**（不碰文件系统，好写断言）

| 模块 | 管什么 |
|---|---|
| `recall` | 关键词、相关性与联想排序；显式传入元数据和日期，不读写文件 |
| `trigger` | 什么时候该整理（水位 + 未审阅欠账）、留多长的原文尾巴、收据怎么写 |
| `conversation` | 房间事件 → 给模型看的文本；沉默；阀门 |
| `retry` | 投递失败之后，该补投哪一条 |

这个切分不是为了好看：**最容易被「顺手优化」掉的恰恰是那几条不变量**，
而它们只有可测才守得住。

命令：

| 命令 | 做什么 |
|---|---|
| `bin/mcp-memory.js` | 记忆的 MCP server：**按意思召回**（只回摘要）、读正文、给自己的记忆改标签（覆盖不删） |
| `bin/recall.js` | 关键词召回（字面匹配）；也是上面那个在没有 key、或者判断服务挂了时的退路 |
| `bin/memory-check.js` | 记忆体检：哪些写重了、哪些被推翻了、哪些两个人都记了、哪些该互相链接 |
| `bin/split-now.js` | agent 自己确认可以切上下文了 |

---

## 用

```bash
npm test        # 纯逻辑 41 + 存储契约 + 召回 13 + 唤醒 29 + 记忆 MCP 7（判断服务全是本地假的，不往外发）
```

```js
const { room, ledger, trigger } = require('./lib');

// 往房间里说一句
room.appendEvent('main', { kind: 'message', author: 'owner', text: '在吗', targets: ['dawn'] });

// 该整理了吗？
const hit = trigger.evaluateTrigger(
  { contextTokens: 120000, contextWindowTokens: 200000 },
  { enabled: true },
);
// → { reason: 'soft', thresholdTokens: 110000, ... } 或 null
```

召回也能作为库调用；读取记忆与排序是两步，不自动回写权重：

```js
const { memory, recall } = require('./lib');
const candidates = memory.loadMemories('/path/to/one-owner-memory');
const ranked = recall.rankMemories(
  candidates,
  recall.splitQuery('文件存储'),
  { year: 2026, month: 9, day: 10 }, // 显式日期，便于复现
);
```

`scoreMemory(memory, queryTerms, today)` 可以单独检查一条的打分依据。
`queryTerms` 由 `splitQuery` 归一化，记忆元数据使用 `memory.loadMemories` 的结构。
命令行仍用 `node bin/recall.js --dir /path/to/memory --json --why "文件存储"`。

数据默认落在 `data/` 下（`ASLAN_DATA_DIR` 可改）。参与者写在 `config/group.json`：

```json
{
  "roomId": "main",
  "participants": {
    "human":  { "id": "owner", "name": "owner" },
    "agents": [
      { "id": "dawn",  "name": "晨曦", "runtime": "claude" },
      { "id": "lumen", "name": "眠灯", "runtime": "codex"  }
    ]
  }
}
```

不配也能跑，用的就是上面这套默认值。

### 记忆 MCP（按意思召回）

```json
{ "mcpServers": { "memory": { "command": "node", "args": ["bin/mcp-memory.js"],
  "env": { "ASLAN_MEMORY_WHO": "dawn", "JEV_API_KEY_FILE": "/path/to/jev-key", "GEMINI_API_KEY_FILE": "/path/to/gemini-key" } } } }
```

每个 agent 的记忆在 `<记忆根>/<他的 id>/` 下（记忆根默认 `data/memory`，`ASLAN_SHARED_MEMORY_DIR` 可改）。
召回时由 agent 先写一句「我想找什么」，可以拆成几条；每条带一个类型：

- `thing`：找讲这件事、或者能解释它的记忆（默认）；
- `cause`：找可能导致它的「那件事」。

类型决定判断怎么问（见下面「判断器怎么问」那条）。「关于谁」用侧车里的 `about` 标签先筛。
判断默认交给 Jev；它挂了退到 Gemini 的向量检索，再不行退到 `bin/recall.js` 的字面匹配，**退了会在回复里说**。
默认只搜自己的记忆；想看另一个 agent 当时自己怎么想，显式传 `include_other`。

⚠ 按意思召回会把候选记忆的**名字 + 一句话描述**和意图发给 Jev（typesafe.ai）和 Google；正文不发。
不想往外发就设 `ASLAN_MEMORY_SEMANTIC=off`，只走字面匹配。
其它环境变量（代理、接口地址、key 的几种放法）写在 `bin/mcp-memory.js` 开头。

### 群聊：投递正文 + 常驻说明

`buildGroupConversationText` 只放**这一轮的原话和几句硬协议**（别续写下一次投递、沉默和已读怎么写）；
语气、分段、脱敏、折叠这些软规则在 `buildGroupStandingBrief(who)` 里，
**由宿主放进系统提示层、每个会话放一次**（比如 Claude Code 的 `--append-system-prompt`）。
两边要放同一份正文，漂移了没人会发现。

---

## 几条撞出来的设计

这些都在代码注释里写着，挑四条最容易被改坏的：

**账本为什么必须存在。** 整理跨 `diary/` 和 `memory/` 两个目录写文件，不可能原子完成。
而 `none`（看过了，没值得留的）和 `pending`（压根没跑到）在磁盘上长得一模一样 ——
都是「memory 目录里没有新文件」。没有账本，这就是一次静默失败。

**`roomId` 不从参与者派生。** 派生看起来更聪明，但那等于「改一次配置就换一个房间」：
旧房间的事件、游标、投递账本原地留下、不再被任何代码读到，而且一声不响。
改显示名尤其不该换房间。

**沉默必须处处免费。** agent 回一个 `--` 表示这轮没什么要补，房间里什么都不留 ——
连一条「他这轮没说话」都没有。一旦沉默要留痕，它就不再免费，模型下次就会倾向于凑一句。
另有一个 `--seen`：想让人知道自己读到了，但仍然不进正文、不触发接力。

**硬触发不受冷却限制。** 反直觉，但故意的：它问的不是「该整理了吗」，
是「再撑一轮还有没有空间」。等真撞上限，连做整理本身都跑不动了。

**光看上下文水位不够，还要看欠账。** 很多运行时会自己压缩上下文（native compact），
压完水位就掉下来了 —— 可那些消息一条都没被审阅、没被落盘过。
**只按水位触发的话，运行时每压一次，触发条件就被清零一次**，而长线程上压缩必然发生。
所以第二个维度问的是另一件事：**有多少经历还没被审阅**（`eligibleUnreviewedTokens`）。
两者是「当前还塞得下多少」和「有多少还没记下来」，compact 只能降低前者。
阈值是**一个原文尾巴的预算**：一次整理至少该处理掉一整个尾巴，否则它自己的扰动比腾出的还多。

**能开新账的触发理由只有一张表。** `OPEN_TRIGGER_REASONS`（能开）和
`STORED_TRIGGER_REASONS`（读旧账认）都从同一个注册表派生，账本层引用它而不是自己抄一份。
⚠ 抄第二份的代价是实测过的：新加的 `backlog` 不在账本那张手抄表里，
于是它**连续 31 次触发、31 次被拒、0 次成功**，而日志里只有一行警告。
测试也照着这条走 —— 遍历导出的集合逐个真实开账，不手写全集。

**唤醒的抖动从 id 哈希派生，不是随机数。** 整点准时响太像脚本；而用随机数的话，
同一条待办每次重启都会挪到一个新时刻 —— 于是它可能提前响，也可能响两次。
另外**一拍只叫醒一条**：停机一夜之后可能有五条同时到点，一起叫醒会让五个进程抢同一个会话。

**闹钟撞上一个已经醒着的他，交给他自己判断。** 宿主要是让进程跨轮常驻，闹钟就可能落在
一段正在进行的对话中间 —— 原样投进去的话，那段提示和人刚打的一句字长得一模一样。
`wake.buildHandoff` 把它包成一张署名的纸条：这是闹钟、排在什么时候、上一个他写的原话，
**做不做、要不要改期由现在的他定**。纸条里教的改期办法（连 `wakeState` 和 `firedAt` 一起清掉）
由契约测试照做一遍再验闹钟真的重响 —— 只断言那两个词出现在文案里，证明不了那句话是对的。

**留尾巴至少留一条。** 最新那条自己就超预算时也不能悄悄变成 0 ——
那等于退回「只给一张收据」，而「刚才那个」会失去落点。超了就如实标 `budgetExceeded`。

**判断器怎么问，比交给谁更重要。** 同一个判断模型，在构造的因果题上（原因和结果一个字都不重合，
旁边放着字面沾边的干扰项）：通用问法「这条值不值得拿出来看」只对 1/5，专门问「这条是不是一个可能原因」5/5；
向量检索也是 1/5 —— 它每次都把字面沾边的排第一（搜「肾虚」排出「肾脏的位置」）。
所以意图要带类型，类型决定问法。⚠ 但因果问法对「教训」类的记忆会普遍给高分，找教训仍然用 `thing`。
这几道题是自己出的、数量很少，因果问法也是看到失败之后才加的 —— 当成一个方向，不是定论。

**投递正文只留硬协议。** 软规则原来拼在每条群聊投递的末尾，一条 558 字符；
一个一直 resume 的会话里它堆了三百多遍，占了那条线程全部投递文本的 74%。
更糟的是，每轮重复的模板正是最好续写的那部分 —— 出过一次事：模型接着正文，
把「下一条投递」（连同这段说明和一句别人的「发言」）整个编了出来。现在正文紧跟一句「不要续写下一次投递」，
其余的挪进常驻说明。

**退路要说出来。** 判断服务超时、换成向量，结果的排序会变，可回复长得一模一样。
所以每一次退都写进回复里；测试也钉着这一条 —— 悄悄换掉的退路，和「一切正常」在外面看不出区别。

---

## 参考过的项目和论文

多数只是借了想法，没有抄代码；借了具体东西的写在后面。

**论文**

- Park et al., *Generative Agents: Interactive Simulacra of Human Behavior*（2023，[arXiv:2304.03442](https://arxiv.org/abs/2304.03442)）——
  保留完整的事件流、定期反思；召回打分里「新近 + 重要 + 相关」的形状。
- Packer et al., *MemGPT: Towards LLMs as Operating Systems*（2023，[arXiv:2310.08560](https://arxiv.org/abs/2310.08560)）——
  上下文和外部存储两层，让模型自己调函数去翻：召回由 agent 自己调，而不是自动塞进上下文。
- Zhong et al., *MemoryBank: Enhancing Large Language Models with Long-Term Memory*（2023，[arXiv:2305.10250](https://arxiv.org/abs/2305.10250)）——
  每日摘要和按遗忘曲线衰减。日记借了前一半；衰减想过，暂时不做。
- Xu et al., *A-MEM: Agentic Memory for LLM Agents*（2025，[arXiv:2502.12110](https://arxiv.org/abs/2502.12110)）——
  一张卡片 = 摘要 + 标签 + 链接；先粗筛、再让模型判断是真相关还是表面相似。
- Rasmussen et al., *Zep: A Temporal Knowledge Graph Architecture for Agent Memory*（2025，[arXiv:2501.13956](https://arxiv.org/abs/2501.13956)）——
  时间是一等维度，冲突时把旧的标成失效而不是删掉：标签的「覆盖不删」。
- Chhikara et al., *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory*（2025，[arXiv:2504.19413](https://arxiv.org/abs/2504.19413)）——
  向量 + 图的双存储那一路。作为对照看过，没走。
- Mao et al., *Multi-User Chat Assistant (MUCA): a Framework Using LLMs to Facilitate Group Conversations*（2024，[arXiv:2401.04883](https://arxiv.org/abs/2401.04883)）——
  把多人聊天拆成「说什么 / 什么时候说 / 对谁说」。

**项目**

- [Graphiti](https://github.com/getzep/graphiti)：`bin/memory-check.js` 里「重复」和「推翻」的判断标准，改写自它的去重提示词；
  「一条可以同时是重复和被取代」、两种判断的候选集故意不对称，也是从它那里读来的。
- [Letta](https://github.com/letta-ai/letta)、[LangGraph](https://github.com/langchain-ai/langgraph)、Memori：怎么切存储 ——
  最后定的是「内容用可读文件，只有需要事务和查询的机器状态才进库」。
- [agentmemory](https://github.com/jayzeng/agentmemory)：目录形状和这里几乎一样（索引 + 每日文件 + 标签 + 双链），
  它把检索做成一层可以摘掉的东西。像成这样不全是巧合：这里的 `MEMORY.md` 索引和 `[[名字]]` 双链，
  照的是 Claude Code 自带记忆的格式，而它也是给 Claude Code 用的 —— 更像同源，不是各自走到了一起。
- [homunculus](https://github.com/yerph/homunculus)：宿主的形状最像的一个；agent 自己排下一次唤醒。
- [agent-room-cli](https://github.com/AliceLJY/agent-room-cli)、agentchat（Yrzhe）、agent-room（alkl）、
  [AutoGen](https://github.com/microsoft/autogen) / AG2 的 GroupChat：群聊的点名路由、在场方式、
  什么时候停（以及一个已知的静默死循环）。
- Codex CLI 本地的记忆任务表：整理账本该有的字段（租约、所有权令牌、两个水位）。
- [lemmalog](https://github.com/JordyZomer/lemmalog)、[agent-log-replayer](https://github.com/opaopa6969/agent-log-replayer)：
  事件溯源和回放 —— 「回忆时按当时的版本重放」这个还停在想法阶段的方向。
- 文章：Linq 的群聊 agent 实践（「到底该不该说话」）；Matt Webb 在 interconnected.org 上的多 bot 聊天室复盘（2025）。
- ChatGPT 的记忆：「先写清楚想找什么、再去检索」这个做法的出发点。

**用到的服务**

- [TypeSafe](https://typesafe.ai) 的 Jev：召回时判断相关、体检时判断重复和推翻。只出校准概率，不出文本。
- Google 的 Gemini embedding（`gemini-embedding-2`）：召回的向量退路。

---

## 出处

这些代码是从 **aslan** 里抽出来的 —— 一个自托管的 Claude Code / Codex Web 工作台，
跑在自己机器上，日记、记忆、群聊、唤醒最初都长在那里面。

抽出来是因为这一层不依赖那个 Web 骨架：**只用 `fs` / `path` / `crypto`**，
接到别的 agent 宿主上一样成立。抽的时候逐个文件核过依赖闭包 ——
这个仓库里的每一行都是为这套东西写的。

代码由两个 agent 写成：**dawn**（Claude）和 **lumen**（Codex）。
注释里保留了不少「为什么是这样」和「这里判断错过一次」的记录 ——
那些不是废话，是这个项目里最贵的部分。

⚠ git 历史里只有 dawn 那侧有 `Co-Authored-By` 署名，**那不代表 lumen 参与得少**：
Anthropic 给了一个可用的署名地址，OpenAI 那边没有对应的约定（Codex 自己也不写这个 trailer）。
在有一个真正属于 `lumen` 的账号之前，这里用文字记着，好过在 trailer 里编一个可能属于别人的邮箱。

---

## License

[MIT](./LICENSE)。
