/**
 * 群聊补投：从「某人的未读」里挑出该重新投递的那条。纯函数，不碰文件系统。
 *
 * 为什么需要补投：投递失败的原因大多是**暂时的** —— T13 的互斥
 * （订阅登录的 Codex 共用一份 OAuth 凭据，同时跑会互相刷掉登录状态）、对方正忙、服务重启。
 * 消息本身没丢（房间是原件、游标没推），但**没有任何东西会再叫她一次**，
 * 那就变成「等一个永远不会来的唤醒」。
 *
 * ⚠ 三条不变量，改这里之前先读：
 *
 * 1. **只补「本该叫醒她」的。** 房间里未读的普通消息**不触发唤醒** ——
 *    不点名就不叫人 —— 房间里有人说话，不等于在向谁提问。
 *    所以判据是未读里有指向她的 `delivery_failed`，不是「有未读」。
 * 2. **补投的是当初那条消息，不是失败记录本身。**
 * 3. **重试再失败不追加新的 control** —— 第一条已经说明白了，
 *    再追加只会把房间刷成一屏失败记录。（这条在调用方，这里只负责挑。）
 */
'use strict';

/**
 * @param {Array} unread  该 owner 游标之后的事件，按时间正序
 * @param {string} who    'dawn' | 'lumen'
 * @returns {object|null} 该重投的那条 message 事件；null = 不该补投
 */
function pickRetryTarget(unread, who) {
  if (!Array.isArray(unread) || !unread.length || !who) return null;

  // 未读里**最后一条**指向她的投递失败 —— 取最后一条，因为中间可能失败过多次
  let failed = null;
  for (const e of unread) {
    if (e && e.kind === 'control' && e.control
      && e.control.type === 'delivery_failed' && e.control.target === who) {
      failed = e;
    }
  }
  if (!failed) return null;

  // 补投当初那条消息。causedBy 指得到就用它
  if (failed.causedBy) {
    const cause = unread.find((e) => e && e.id === failed.causedBy && e.kind === 'message');
    if (cause) return cause;
  }
  // ⚠⚠ causedBy 断了的时候，**只认点名了她的那条消息**。
  //
  // 这里原来是「退回到失败记录之前最近的一条消息」，不看点名。实测出来的后果：
  // 一条只点名 lumen 的消息，会被 `delivery_failed(target=dawn)` 挑中补投给 dawn ——
  // 补投的内容和失败的那次根本不是同一件事，而房间里看不出任何异常。
  //
  // 「最近的一条」不是因果，只是时间上的邻近。宁可这次不补，也不要补错一条：
  // 不补的话，未读还在，人再说一句就能带出来；补错的话，两边都以为对上了。
  let fallback = null;
  for (const e of unread) {
    if (e === failed) break;
    if (e && e.kind === 'message' && Array.isArray(e.targets) && e.targets.includes(who)) {
      fallback = e;
    }
  }
  return fallback;
}

module.exports = { pickRetryTarget };
