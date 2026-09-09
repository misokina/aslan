#!/usr/bin/env node
/**
 * 「我现在可以切了」—— 由 agent 自己跑。
 * 要不要切、什么时候切，由当事的那个 agent 判断；朝花只负责提醒。
 *
 * 用法：
 *   node bin/split-now.js <consolidationId>
 *
 * 它只做一件事：在 config/split-requests/ 下放一张条子。
 * 服务端下一拍（整理 5 分钟一次）看到条子 → 取出即删 → 真的切。
 *
 * ⚠ **为什么不是斜杠命令。** agent 的回复是**输出**，不是发给会话的消息 ——
 *   在正文里写 `/split` 不会被执行。而让服务端去解析回复正文里的意图，
 *   正是这个项目定过「server 不从回复猜判断结果」要避免的那件事：
 *   猜错了不会报错，只会在某个没人看着的时刻切掉一段还在用的上下文。
 *
 * ⚠ **为什么不是直接改 session JSON。** 服务端也在写那个文件（全量覆盖），
 *   两边读改写会静默互相盖掉。一次性的小条子没这个问题。
 *
 * ⚠ **跑完不会立刻切。** 最多等一拍（5 分钟）。这段时间里照常说话没问题 ——
 *   切的时候最后一段原文会跟着过去。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = process.env.ASLAN_CONFIG_DIR || path.join(__dirname, '..', 'config');
const DIR = path.join(CONFIG_DIR, 'split-requests');

function main() {
  const id = (process.argv[2] || '').trim();
  if (!id) {
    console.error('用法：node bin/split-now.js <consolidationId>');
    console.error('（那个 id 在「可以切了」那张提醒里，也能用 node lib/consolidate.js read <id> 核对）');
    process.exitCode = 1;
    return;
  }
  // ⚠ 只收账本 id 的形状。这张条子的文件名直接由它拼出来，
  //   放行 `../` 就是让调用方决定往哪儿写文件。
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    console.error(`这不像一个账本 id：${id}`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({
    consolidationId: id,
    at: new Date().toISOString(),
    by: process.env.ASLAN_SPLIT_BY || 'agent',
  }, null, 2) + '\n', 'utf8');

  console.log(`好了，条子放下了：${file}`);
  console.log('服务端下一拍（最多 5 分钟）会切。这段时间照常说话没关系 ——');
  console.log('切的时候最后一段原文会跟着过去，另外给你一张收据说东西存到哪儿了。');
}

main();
