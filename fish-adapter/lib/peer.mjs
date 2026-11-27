// Peer 缓冲与攒批窗口（S2.2 / D9 / S2.13）：本地巡逻的攒批层
// patrol.enabled=true 时消息 push 进该群缓冲；窗口到期 flush 整批交给 flushHandler（S2-E 起接 wakeSafe）
// 硬规则（任务书原文）：
//   ① 不能「收到就调」——攒批防成本×10、回复碎成 N 条
//   ② 必回消息（must）走 1~2 秒短窗，且触发时 flush 整个缓冲，不许只挑 must 那条
//   ③ 缓冲上限 30 条，满了立即 flush——丢最旧是禁止的（热闹刷屏正是该说话的时候）
//   ④ flush 前 D9 排序：inbound 的引用解析/附件下载是网络请求，后到的消息可能先入缓冲，
//      不排序鱼会「先回后问」
//   ⑤ 60 秒兜底 sweep：队首滞留超 bufferStaleMs 强制 flush（WS 断流不把消息憋死）
//   ⑥ flush 后按群释放，空 peer 不留（S2.16「连跑 24h 内存不涨」）
import { log } from './util.mjs';

export function createPeers(cfg, flushHandler) {
  const P = cfg.patrol ?? {};
  const batchWindowMs = P.batchWindowMs ?? 5000;
  const mustWindowMs = P.mustWindowMs ?? 1500;
  const maxBuffer = P.maxBufferPerPeer ?? 30;
  const staleMs = P.bufferStaleMs ?? 30000;

  const peers = new Map(); // chatKey -> { msgs:[], timer, mustPending }

  function peerOf(chatKey) {
    let p = peers.get(chatKey);
    if (!p) {
      p = { msgs: [], timer: null, mustPending: false };
      peers.set(chatKey, p);
    }
    return p;
  }

  function flush(chatKey, reason) {
    const p = peers.get(chatKey);
    if (!p || p.msgs.length === 0) return;
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    // D9：按消息时间排序，同秒按 message_id 兜底（防网络请求乱序导致「先回后问」）
    p.msgs.sort((a, b) => (a.time - b.time) || (Number(a.messageId) - Number(b.messageId)));
    const batch = p.msgs.splice(0);
    peers.delete(chatKey); // 整批取走、按群释放
    log('peer', `flush ${chatKey} msgs=${batch.length} reason=${reason}（must=${batch.some((m) => m.must) ? 'y' : 'n'}）`);
    // handler 崩溃不反噬缓冲层（S2-E 起 handler 内部另有超时/熔断）。
    // async IIFE 包装：裸 try/catch 只接得住同步 throw——handler 是 async，rejection 会变
    // 悬空 promise（unhandledRejection = 进程崩），timer 路径无人 catch 时缓冲消息全部白丢
    (async () => flushHandler(chatKey, batch, { reason, batchId: `${chatKey}-${Date.now()}` }))()
      .catch((e) => log('peer', `WARN flushHandler error/rejected (${chatKey}): ${e.message}`));
  }

  function arm(chatKey, ms) {
    const p = peerOf(chatKey);
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => flush(chatKey, 'window'), ms);
    p.timer.unref?.();
  }

  // entry 至少带：messageId、time（QQ 秒级时间戳，排序用）、must、receivedAt（入缓冲时刻，sweep 用）
  function push(chatKey, entry) {
    const p = peerOf(chatKey);
    p.msgs.push({ receivedAt: Date.now(), ...entry });
    if (entry.must) {
      // must 走短窗；期间后续非 must 也跟着短窗（这批要以 must 的节奏走）
      p.mustPending = true;
      arm(chatKey, mustWindowMs);
    } else {
      arm(chatKey, p.mustPending ? mustWindowMs : batchWindowMs);
    }
    if (p.msgs.length >= maxBuffer) flush(chatKey, 'full'); // 满 30 立即 flush，禁止丢最旧
  }

  // 兜底扫描（外部 setInterval 60 秒调一次）：队首滞留超 staleMs 强制 flush
  function sweep() {
    const now = Date.now();
    for (const [chatKey, p] of [...peers]) {
      const head = p.msgs[0];
      if (head && now - (head.receivedAt ?? now) > staleMs) flush(chatKey, 'stale-sweep');
    }
  }

  // 控制台 /stats 用：各群当前缓冲条数（peers Map 闭包私有，这里开只读口）
  const pending = () => [...peers].map(([chatKey, p]) => ({ chatKey, pending: p.msgs.length }));

  return { push, flush, sweep, size: () => peers.size, pending };
}
