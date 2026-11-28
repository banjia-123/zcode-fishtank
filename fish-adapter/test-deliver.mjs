// 出站投递恢复层测试（2026-11-28）：lib/deliver.mjs 是纯逻辑、依赖全注入，直接单测。
// Part A 覆盖 defer 重试：默认延迟表 / 首试成功 / 第二档成功 / 两档均满耗尽 / 其他 action 透传 /
//       process 抛错不炸 / onDone 恰好一次 / cancel（含入队回调竞态）/ 自定义延迟表
// 跑法：node test-deliver.mjs，退出码 0 = 全过
import { scheduleDeferRetry, DEFER_RETRY_DELAYS_MS } from './lib/deliver.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

// 假定时器：收集 (fn, ms)，测试手动 fire——真实 90s 等不起
const tick = () => new Promise((r) => setImmediate(r));
function fakeTimers() {
  const queue = [];
  return {
    queue,
    setTimer: (fn, ms) => { const h = { fn, ms, fired: false, cleared: false, unrefCalled: false, unref() { this.unrefCalled = true; } }; queue.push(h); return h; },
    clearTimer: (h) => { h.cleared = true; },
    // 触发最早一个未触发的定时器（按入队序）；返回 null 表示没有可触发的
    async fire() {
      const h = queue.find((x) => !x.fired);
      if (!h) return null;
      h.fired = true;
      h.fn();
      await tick();
      return h;
    },
  };
}
// 按序返回结果的假 process，并记录每次收到的 text
function seqProcess(results) {
  const seen = [];
  let i = 0;
  const fn = async (text) => { seen.push(text); const r = results[i++]; if (r instanceof Error) throw r; return r; };
  fn.seen = seen;
  return fn;
}
const run = (process, over = {}) => {
  const t = fakeTimers();
  const done = [];
  const logs = [];
  const h = scheduleDeferRetry({ process, text: '草稿', setTimer: t.setTimer, clearTimer: t.clearTimer, log: (m) => logs.push(m), onDone: (r) => done.push(r), ...over });
  return { t, done, logs, h };
};

ok(Array.isArray(DEFER_RETRY_DELAYS_MS) && DEFER_RETRY_DELAYS_MS.join() === '90000,150000', 'DV1 默认延迟表 = 90s / 150s', String(DEFER_RETRY_DELAYS_MS));

// DV2 首试成功
{
  const p = seqProcess([{ action: 'sent' }]);
  const { t, done, logs } = run(p);
  ok(p.seen.length === 0 && t.queue.length === 1, 'DV2a 排程时不立即重投，挂一个定时器', `seen=${p.seen.length} timers=${t.queue.length}`);
  ok(t.queue[0].ms === 90_000 && t.queue[0].unrefCalled, 'DV2b 首档延迟 90s 且 timer 已 unref（不挂住进程退出）');
  await t.fire();
  ok(p.seen.length === 1 && p.seen[0] === '草稿', 'DV2c 到点用原文重投');
  ok(done.length === 1 && done[0].action === 'sent', 'DV2d 首试成功 → onDone(sent)', JSON.stringify(done));
  ok(logs.some((l) => l.includes('defer 重试 #1 → sent')), 'DV2e 留痕"重试 #1 → sent"');
}

// DV3 第二档成功
{
  const p = seqProcess([{ action: 'defer', reason: 'limit-window' }, { action: 'sent' }]);
  const { t, done, logs } = run(p);
  await t.fire();
  ok(t.queue.length === 2 && t.queue[1].ms === 150_000, 'DV3a 首试仍满 → 按表排第二档 150s', `timers=${t.queue.map((x) => x.ms).join(',')}`);
  ok(logs.some((l) => l.includes('重试 #1 窗口仍满') && l.includes('150s 后再试')), 'DV3b 留痕"窗口仍满，150s 后再试"');
  ok(done.length === 0, 'DV3c 中途不调 onDone');
  await t.fire();
  ok(done.length === 1 && done[0].action === 'sent' && p.seen.length === 2, 'DV3d 第二档成功 → onDone(sent)', JSON.stringify(done));
}

// DV4 两档均满 → 耗尽
{
  const p = seqProcess([{ action: 'defer', reason: 'limit-window' }, { action: 'defer', reason: 'limit-window' }, { action: 'sent' }]);
  const { t, done, logs } = run(p, { tag: ' batch=g:1-1' });
  await t.fire();
  await t.fire();
  ok(t.queue.length === 2 && p.seen.length === 2, 'DV4a 只重试表里的两档，不超表', `timers=${t.queue.length} process=${p.seen.length}`);
  ok(done.length === 1 && done[0].action === 'dropped' && done[0].reason === 'defer-exhausted', 'DV4b 耗尽 → onDone(dropped / defer-exhausted)', JSON.stringify(done));
  ok(logs.some((l) => l.includes('defer 重试耗尽，放弃') && l.includes('batch=g:1-1')), 'DV4c 留痕含放弃原因与 tag');
  ok(!(await t.fire()), 'DV4d 不再排新定时器');
}

// DV5 重试拿到其他 action → 原样透传并结束
{
  const dropped = { action: 'dropped', reason: 'limit-daily' };
  const { t, done } = run(seqProcess([dropped]));
  await t.fire();
  ok(done.length === 1 && done[0] === dropped, 'DV5 其他 action 原样透传', JSON.stringify(done));
  ok(!(await t.fire()), 'DV5b 不再重试');
}

// DV6 process 抛错 → error 结果，链不炸
{
  const { t, done } = run(seqProcess([new Error('boom')]));
  await t.fire();
  ok(done.length === 1 && done[0].action === 'error' && done[0].reason === 'boom', 'DV6 process 抛错 → onDone(error)，不炸', JSON.stringify(done));
}

// DV7 onDone 恰好一次（耗尽后多余的回调不重复结算）
{
  const p = seqProcess([{ action: 'defer' }, { action: 'defer' }]);
  const { t, done } = run(p);
  await t.fire();
  await t.fire();
  t.queue[0].fn(); // 模拟同一定时器被重复触发
  await tick();
  ok(done.length === 1 && p.seen.length === 2, 'DV7 onDone 恰好一次，重复回调不重投', `done=${done.length} process=${p.seen.length}`);
}

// DV8 cancel：取消后不再重投；已入队回调（竞态）也不投
{
  const p = seqProcess([{ action: 'sent' }]);
  const { t, done, h } = run(p);
  h.cancel();
  ok(t.queue[0].cleared === true, 'DV8a cancel 清掉定时器');
  await t.fire(); // 回调仍被调用（竞态）——应被 done 标志拦住
  ok(p.seen.length === 0 && done.length === 0, 'DV8b cancel 后入队回调不再重投、不调 onDone', `seen=${p.seen.length} done=${done.length}`);
  h.cancel(); // 二次 cancel 无害
  ok(true, 'DV8c 重复 cancel 无害');
}

// DV9 onDone 抛错不反噬
{
  const { t } = run(seqProcess([{ action: 'sent' }]), { onDone: () => { throw new Error('cb boom'); } });
  await t.fire();
  ok(true, 'DV9 onDone 抛错被吞，链不炸');
}

// DV10 自定义延迟表
{
  const { t } = run(seqProcess([{ action: 'defer' }, { action: 'sent' }]), { delays: [1_000] });
  ok(t.queue[0].ms === 1_000, 'DV10 自定义延迟表生效');
  await t.fire();
  ok(t.queue.length === 1, 'DV10b 单档表耗尽后不再排程');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
