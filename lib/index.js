'use strict';

/**
 * 朝花 —— 给 CLI agent 加一层连续性。
 *
 * 十个模块分两类：
 *
 *   **存储**（碰文件系统，各自管一种产物）
 *     diary        日记：一天一个文件，只增不改
 *     memory       记忆条目的读取与元数据
 *     tags         记忆的标签叠加层（和正文分开存，互不覆盖）
 *     ledger       整理账本：区间、两个分支的状态、attempt
 *     room         群聊房间：事件流、游标、投递账本、写入侧脱敏
 *     participants 参与者身份（谁在房间里，房间 id 是什么）
 *     wake         唤醒：agenda 的读写、该响哪一条、崩在半路的怎么办
 *
 *   **纯逻辑**（不碰文件系统，好写断言）
 *     recall       关键词粗筛与排序；调用方提供元数据、查询词和日期
 *     trigger      什么时候该整理、留多长的尾巴、收据怎么写
 *     conversation 群聊事件 → 给模型看的文本；沉默；阀门
 *     retry        投递失败之后，补投哪一条
 *
 * 这个切分不是为了好看：凡是能做成纯函数的判断都挪进了第二类，
 * 因为**最容易被顺手优化掉的恰恰是那几条不变量**，而它们只有可测才守得住。
 */

// ⚠ 惰性加载，不是图省事：`require('promise')` 不该有副作用。
//   参与者配置一被引用就会读 group.json 并在配置损坏时抛错 —— 那是对的行为，
//   但它该发生在你**用到**它的时候，不是在 import 这一行。
//   （踩过一次：另一个模块的顶层代码在被 require 的瞬间就去扫磁盘、往 stderr 写警告。）
const lazy = (name) => ({ get() { return require(name); }, enumerable: true });

module.exports = Object.defineProperties({}, {
  // 存储
  diary: lazy('./diary'),
  memory: lazy('./memory-metadata'),
  tags: lazy('./tags'),
  ledger: lazy('./consolidate'),
  room: lazy('./group'),
  participants: lazy('./participant-config'),
  wake: lazy('./wake'),

  // 纯逻辑
  recall: lazy('./recall'),
  trigger: lazy('./consolidation'),
  conversation: lazy('./group-conversation'),
  retry: lazy('./group-retry'),
});

// bin/recall.js 负责文件读取、当前日期和输出格式；recall 只负责排序。
