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
| `trigger` | 什么时候该整理、留多长的原文尾巴、收据怎么写 |
| `conversation` | 房间事件 → 给模型看的文本；沉默；阀门 |
| `retry` | 投递失败之后，该补投哪一条 |

这个切分不是为了好看：**最容易被「顺手优化」掉的恰恰是那几条不变量**，
而它们只有可测才守得住。

命令：`bin/recall.js`（关键词召回）、`bin/split-now.js`（agent 自己确认可以切上下文了）。

---

## 用

```bash
npm test        # 纯逻辑 35 + 存储契约 + 召回 13 + 唤醒 29
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
在有一个真正属于她的账号之前，这里用文字记着，好过在 trailer 里编一个可能属于别人的邮箱。

---

## License

[MIT](./LICENSE)。
