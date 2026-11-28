// 出站投递恢复层（2026-11-28）：包着 outbound.processMessage，处理"没发出去、但值得再努力"的结果。
// 纯逻辑、依赖全注入（process / setTimer），可单测——adapter.mjs 是入口脚本（import 即起服务），
// 逻辑放在那儿测不到（test-adapter 只能子进程跑最轻装配）。
//
//   defer（同群 5 分钟窗口满）：outbox 轮询时代靠"文件保留下轮重发"兜住；2026-11-28 切除 outbox 后
//     patrol 层只打一行日志就废弃批次——defer 变成静默丢失（当天丢 7 条高峰回复，日志还写着"不丢"）。
//     现按延迟表重试，窗口滑走即发出；耗尽则诚实丢弃并留痕。

// 重试延迟表：5 分钟滚动窗口，最早一条出窗平均要 2~3 分钟——两档覆盖大半；总等待 4 分钟封顶
// （再晚就接不上话了，宁可不回）
export const DEFER_RETRY_DELAYS_MS = [90_000, 150_000];

// defer 重试：不阻塞调用方（patrol 的 flush handler 立即返回），到点重投；仍 defer 则按表下一档。
// onDone(result) 无论成败恰好调一次（耗尽 → { action:'dropped', reason:'defer-exhausted' }）。
// 返回取消句柄；timer 已 unref——进程退出不被挂住（代价：重启会丢在途的 1~2 条延迟回复，可接受）。
export function scheduleDeferRetry({
  process, // (text) => Promise<出站结果>
  text,
  delays = DEFER_RETRY_DELAYS_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
  onDone,
  tag = '',
}) {
  let done = false;
  let handle = null;
  const finish = (result) => {
    if (done) return;
    done = true;
    try { onDone?.(result); } catch { /* 回调异常不反噬重试链 */ }
  };
  const attempt = (i) => {
    const wait = delays[i];
    if (wait == null) {
      log(`defer 重试耗尽，放弃${tag}（${delays.length} 次重试窗口均未腾出）`);
      finish({ action: 'dropped', reason: 'defer-exhausted' });
      return;
    }
    handle = setTimer(async () => {
      if (done) return; // cancel 后已入队的回调（竞态）不再重投
      let out;
      try { out = await process(text); } catch (e) { finish({ action: 'error', reason: String(e?.message ?? e) }); return; }
      if (out?.action === 'defer') {
        const next = delays[i + 1];
        if (next != null) log(`defer 重试 #${i + 1} 窗口仍满${tag}，${Math.round(next / 1000)}s 后再试`);
        attempt(i + 1);
        return;
      }
      log(`defer 重试 #${i + 1} → ${out?.action}${out?.reason ? `(${out.reason})` : ''}${tag}`);
      finish(out);
    }, wait);
    handle?.unref?.();
  };
  attempt(0);
  return { cancel: () => { if (done) return; done = true; if (handle) clearTimer(handle); } };
}
