// S2-B 离线测试：Peer 缓冲与攒批窗口（peer.mjs）
// 跑法：node test-peer.mjs（纯本地，不碰 NapCat/ZCode/真实文件）
// 覆盖：debounce 攒批 / 窗口重置 / must 短窗 / must 全量 flush / 满 N 立即 flush /
//       D9 排序 / sweep 兜底 / 空缓冲无害 / handler 异常不反噬 / flush 后按群释放 / 短窗传播
import './test-setup.mjs'; // peer.mjs 的 log() 会写 ROOT_DIR/logs——指向临时目录
import { createPeers } from './lib/peer.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}

// —— 测试配置（小时间窗加速；语义与生产默认一致）——
const mkCfg = (over = {}) => ({
  patrol: { batchWindowMs: 200, mustWindowMs: 100, maxBufferPerPeer: 30, bufferStaleMs: 30000, ...over },
});

// T1 · debounce 攒批：多条非 must 合成一批
{
  const flushes = [];
  const peers = createPeers(mkCfg(), (ck, batch) => flushes.push({ ck, batch }));
  peers.push('g:1', { messageId: 101, time: 1000, must: false });
  await sleep(50);
  peers.push('g:1', { messageId: 102, time: 1001, must: false });
  await sleep(50);
  peers.push('g:1', { messageId: 103, time: 1002, must: false });
  await sleep(350);
  ok(flushes.length === 1 && flushes[0].batch.length === 3, 'T1 debounce：3 条合并 1 次 flush', JSON.stringify(flushes.map((f) => f.batch.length)));
  ok(peers.size() === 0, 'T1b flush 后按群释放');
}

// T2 · 窗口重置（debounce）：后到的消息把窗口往后推
{
  const flushes = [];
  const peers = createPeers(mkCfg(), (ck, batch) => flushes.push({ ck, batch, at: Date.now() }));
  const t0 = Date.now();
  peers.push('g:2', { messageId: 201, time: 2000, must: false });
  await sleep(120); // 超过半窗，但随后有新消息进来
  peers.push('g:2', { messageId: 202, time: 2001, must: false });
  await sleep(350);
  ok(flushes.length === 1 && flushes[0].batch.length === 2, 'T2 窗口重置：只 flush 一次、含 2 条');
  ok(flushes[0].at - t0 >= 300, 'T2b flush 发生在第二条消息之后（窗口被重置）', `elapsed=${flushes[0].at - t0}`);
}

// T3/T4 · must 短窗 + 全量 flush（不许只挑 must 那条）
{
  const flushes = [];
  const peers = createPeers(mkCfg({ batchWindowMs: 2000 }), (ck, batch, info) => flushes.push({ ck, batch, info }));
  peers.push('g:3', { messageId: 301, time: 3000, must: false });
  await sleep(40);
  peers.push('g:3', { messageId: 302, time: 3001, must: true }); // must 触发短窗
  await sleep(130); // mustWindow=100ms 从 must 入缓冲起算，40+100=140ms 处 flush；标准窗 2000ms 远未到
  ok(flushes.length === 1, 'T3 must 短窗：不等标准窗就 flush', `flushes=${flushes.length}`);
  ok(flushes[0].batch.length === 2, 'T4 must 全量 flush：缓冲里的非 must 一起走', `got=${flushes[0]?.batch.length}`);
  ok(flushes[0].batch.some((m) => m.must), 'T4b 批内含 must 消息');
}

// T5 · 满 N 立即 flush（不丢最旧）
{
  const flushes = [];
  const peers = createPeers(mkCfg({ maxBufferPerPeer: 5, batchWindowMs: 2000 }), (ck, batch) => flushes.push({ ck, batch }));
  for (let i = 0; i < 5; i++) peers.push('g:4', { messageId: 400 + i, time: 4000 + i, must: false });
  await sleep(30);
  ok(flushes.length === 1 && flushes[0].batch.length === 5, 'T5 满 5 立即 flush：5 条全在、没丢最旧', `flushes=${flushes.length} got=${flushes[0]?.batch.length}`);
}

// T6 · D9 排序：后到的先入缓冲（time 大的先 push），flush 按时间序
{
  const flushes = [];
  const peers = createPeers(mkCfg({ batchWindowMs: 150 }), (ck, batch) => flushes.push({ ck, batch }));
  peers.push('g:5', { messageId: 503, time: 5005, must: false }); // 最新
  peers.push('g:5', { messageId: 501, time: 5001, must: false }); // 最旧
  peers.push('g:5', { messageId: 502, time: 5003, must: false });
  await sleep(300);
  const ids = flushes[0]?.batch.map((m) => m.messageId);
  ok(JSON.stringify(ids) === JSON.stringify([501, 502, 503]), 'T6 D9 排序：按 time 升序出批', JSON.stringify(ids));
}

// T7 · sweep 兜底：窗口 timer 因故没跑（标准窗设大），滞留消息靠 sweep 强制 flush
{
  const flushes = [];
  const peers = createPeers(mkCfg({ batchWindowMs: 60_000, bufferStaleMs: 100 }), (ck, batch, info) => flushes.push({ ck, batch, info }));
  peers.push('g:6', { messageId: 601, time: 6001, must: false });
  await sleep(150); // 超过 bufferStaleMs
  peers.sweep();
  ok(flushes.length === 1 && flushes[0].batch.length === 1 && flushes[0].info.reason === 'stale-sweep',
    'T7 sweep 兜底：滞留消息被强制 flush', `flushes=${flushes.length} reason=${flushes[0]?.info.reason}`);
}

// T8 · 空缓冲 flush 无害
{
  let threw = false;
  const peers = createPeers(mkCfg(), () => {});
  try { peers.flush('g:none', 'manual'); } catch { threw = true; }
  ok(!threw, 'T8 空缓冲 flush 不抛异常');
}

// T9 · handler 抛异常不反噬缓冲层
{
  let calls = 0;
  const peers = createPeers(mkCfg({ batchWindowMs: 80 }), () => { if (calls++ === 0) throw new Error('boom'); });
  peers.push('g:7', { messageId: 701, time: 7001, must: false });
  await sleep(150);
  ok(calls === 1, 'T9a 第一次 flush handler 抛异常');
  let ok2 = false;
  const peers2 = createPeers(mkCfg({ batchWindowMs: 80 }), () => { ok2 = true; });
  peers2.push('g:8', { messageId: 801, time: 8001, must: false });
  await sleep(150);
  ok(ok2, 'T9b 抛过异常的进程里新 peer 照常 flush（不反噬）');
}

// T10 · mustPending 短窗传播：must 进过缓冲后，同批后续非 must 也按短窗节奏走
{
  const flushes = [];
  const peers = createPeers(mkCfg({ batchWindowMs: 2000, mustWindowMs: 150 }), (ck, batch) => flushes.push({ ck, batch }));
  peers.push('g:9', { messageId: 901, time: 9001, must: true });
  await sleep(80); // 短窗内来一条非 must
  peers.push('g:9', { messageId: 902, time: 9002, must: false });
  await sleep(200); // 短窗 150ms 从第二条（重置点 t=80）起算，t=230 flush；若按标准窗 2000ms 则不会 flush
  ok(flushes.length === 1 && flushes[0].batch.length === 2, 'T10 短窗传播：must 之后的消息跟着短窗节奏 flush', `flushes=${flushes.length} got=${flushes[0]?.batch.length}`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
