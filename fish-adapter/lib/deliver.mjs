// 出站投递恢复层（2026-11-28）：包着 outbound.processMessage，处理"没发出去、但值得再努力"的结果。
// 纯逻辑、依赖全注入（process / setTimer），可单测——adapter.mjs 是入口脚本（import 即起服务），
// 逻辑放在那儿测不到（test-adapter 只能子进程跑最轻装配）。
//
//   defer（同群 5 分钟窗口满）：outbox 轮询时代靠"文件保留下轮重发"兜住；2026-11-28 切除 outbox 后
//     patrol 层只打一行日志就废弃批次——defer 变成静默丢失（当天丢 7 条高峰回复，日志还写着"不丢"）。
//     现按延迟表重试，窗口滑走即发出；耗尽则诚实丢弃并留痕。
//   intercepted（缀冷却/缀-only/OS 首段拦截）：原先一律机械降级（剥缀保正文/剥光丢弃/剥段保留），
//     现让模型拿"草稿+原因"重写一版；拿不到重写正文才降级（deliverWithRecovery）。

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

// 打回重写（上限 1 次）：出站返回 intercepted（缀冷却/缀-only/OS 首段）→ 让模型拿"草稿+原因"重写一版。
// 前提由 outbound 保证：能走到 intercepted 的草稿已过全部安全闸（审计/禁词/QQ 泄露命中的不返回它）。
// 重写版再走一遍出站，不带 rewriteable——仍被拦则由 outbound 机械降级（所以不会循环）。
// 拿不到重写正文（关闭/跳过/失败/沉默/空）→ 兜底=降级到现有机械处理：发 strippedText，剥光的丢弃。
// 返回 { out, finalText, rewritten }：finalText 是最终尝试发送的文本（便签、defer 重试用）
export async function deliverWithRecovery({ process, rewrite, text, rewriteEnabled = true, log = () => {} }) {
  let finalText = text;
  // 开关关闭：首调就不带 rewriteable——拦截在 outbound 内机械降级，与打回重写上线前逐字一致
  let out = await process(finalText, rewriteEnabled ? { rewriteable: true } : undefined);
  if (out?.action !== 'intercepted') return { out, finalText, rewritten: false };

  const why = String(out.reason ?? '?');
  const hint = out.hint ?? {};
  const fallback = typeof hint.strippedText === 'string' ? hint.strippedText.trim() : '';

  let fresh = '';
  if (rewriteEnabled && typeof rewrite === 'function') {
    let rw = null;
    try { rw = await rewrite(hint.originalText ?? finalText, out); } catch (e) { log(`打回（${why}）：重写调用异常（${e?.message ?? e}）`); }
    fresh = typeof rw?.content === 'string' ? rw.content.trim() : '';
    if (!fresh && rw) {
      const s = rw.skipped ? `skipped: ${rw.reason ?? ''}` : rw.error ? `error: ${rw.error}` : rw.silent ? 'silent' : '空响应';
      log(`打回（${why}）：重写没拿到正文（${s}）`);
    }
  } else {
    log(`打回（${why}）：重写未启用`);
  }

  const tag = (o) => `${o?.action}${o?.reason ? `/${o.reason}` : ''}`;
  if (fresh) {
    finalText = fresh;
    out = await process(finalText); // 重写版不再带 rewriteable：仍被拦则在 outbound 内机械降级
    log(`打回（${why}）→ 发重写版（${tag(out)}）`);
    return { out, finalText, rewritten: true };
  }
  if (!fallback) {
    log(`打回（${why}）：机械降级后无正文 → 丢弃`);
    return { out: { action: 'dropped', reason: 'empty', intercepted: why }, finalText, rewritten: false };
  }
  finalText = fallback;
  out = await process(finalText);
  log(`打回（${why}）→ 兜底发机械降级版（${tag(out)}）`);
  return { out, finalText, rewritten: false };
}
