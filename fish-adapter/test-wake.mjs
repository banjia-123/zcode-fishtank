// S2-D 离线测试：wake 客户端（app-server.mjs）+ 护栏（safe.mjs），对 fake-app-server 跑
// 覆盖：协议往返 / SILENT / turn-failed / 超时 / 并发闸 / 同群串行 / 熔断 / 限额 /
//       静默时段 / 最小间隔 / 崩溃重启 / wake.jsonl 留痕
// 注意：会写 state/wake-counters.json（测前备份测后恢复）和 logs/wake.jsonl（[test] 标记行）
//       ——ROOT_DIR 已指向一次性临时目录（test-setup.mjs），不碰生产文件
import './test-setup.mjs';
import { createAppServerClient } from './wake/app-server.mjs';
import { createWakeSafe } from './wake/safe.mjs';
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT_DIR } from './lib/util.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}

// —— 生产状态保护：counters 备份/恢复 ——
const COUNTERS = join(ROOT_DIR, 'state', 'wake-counters.json');
const BAK = COUNTERS + '.test-bak';
const hadCounters = existsSync(COUNTERS);
if (hadCounters) copyFileSync(COUNTERS, BAK);

const baseCfg = {
  patrol: {
    // 替身是源码文件：按测试文件自身位置定位，不走 ROOT_DIR（隔离后它指向一次性临时目录）
    cliPath: join(dirname(fileURLToPath(import.meta.url)), 'wake', 'fake-app-server.mjs'),
    batchWindowMs: 100, mustWindowMs: 50,
    minWakeIntervalMs: 0,          // 默认用例不受间隔影响
    maxDailyWakes: 1000,
    model: { providerId: 'fake', modelId: 'fake-model', reasoningLevel: 'low' },
    silentHours: null,
    wakeTimeoutMs: 90_000,
  },
};

// —— W1-W4 协议往返 ——
{
  const client = createAppServerClient(baseCfg);
  const safe = createWakeSafe(baseCfg, client);
  const r1 = await safe.wakeSafe('g:1', 'FAKE:OK', { batchId: 'b1', msgs: 1 });
  ok(r1.content === 'OK' && r1.usage?.inputTokens === 1, 'W1 正常往返：content=OK + usage', JSON.stringify(r1).slice(0, 120));
  const r2 = await safe.wakeSafe('g:1', 'FAKE:SILENT', { batchId: 'b2', msgs: 1 });
  ok(r2.silent === true, 'W2 [SILENT] 判定：result=silent', JSON.stringify(r2).slice(0, 120));
  const r3 = await safe.wakeSafe('g:1', 'FAKE:FAIL', { batchId: 'b3', msgs: 1 });
  ok(r3.error && /turn-failed/.test(r3.error), 'W3 turn-failed：错误上抛', String(r3.error).slice(0, 80));
  client.stop();
}

// —— W4 超时（短超时实例，不真等 90s）——
{
  const cfg = { ...baseCfg, patrol: { ...baseCfg.patrol, wakeTimeoutMs: 1500 } };
  const client2 = createAppServerClient(cfg);
  const safe2 = createWakeSafe(cfg, client2);
  const t0 = Date.now();
  const r4 = await safe2.wakeSafe('g:1', 'FAKE:HANG', { batchId: 'b4', msgs: 1 }).catch((e) => ({ error: e.message }));
  ok(/wake-timeout/.test(String(r4.error)) && Date.now() - t0 < 3600, 'W4 超时拒绝（1.5s 超时 + 冷启动 1.5s）', `err=${r4.error} elapsed=${Date.now() - t0}`);
  client2.stop();
}

// —— W5 并发闸：全局最多 2 个，第三个排队 ——
{
  const client = createAppServerClient({ ...baseCfg, patrol: { ...baseCfg.patrol, wakeTimeoutMs: 8000 } });
  const safe = createWakeSafe({ ...baseCfg, patrol: { ...baseCfg.patrol, wakeTimeoutMs: 8000 } }, client);
  const t0 = Date.now();
  const ps = [1, 2, 3].map((i) => safe.wakeSafe(`g:c${i}`, 'FAKE:SLOW', { batchId: `c${i}`, msgs: 1 }));
  const rs = await Promise.all(ps);
  const elapsed = Date.now() - t0;
  ok(rs.every((r) => r.content === 'OK'), 'W5a 三个并发全部成功');
  ok(elapsed >= 750 && elapsed < 3000, 'W5b 并发闸：2 个并行 + 1 个排队（总时长 ~800ms）', `elapsed=${elapsed}`);
  client.stop();
}

// —— W6 同群串行 ——
{
  const client = createAppServerClient(baseCfg);
  const safe = createWakeSafe(baseCfg, client);
  const t0 = Date.now();
  const [a, b] = await Promise.all([
    safe.wakeSafe('g:s', 'FAKE:SLOW', { batchId: 's1', msgs: 1 }),
    safe.wakeSafe('g:s', 'FAKE:SLOW', { batchId: 's2', msgs: 1 }),
  ]);
  const elapsed = Date.now() - t0;
  ok(a.content === 'OK' && b.content === 'OK', 'W6a 同群两个都成功');
  ok(elapsed >= 750, 'W6b 同群串行：第二个等第一个完成（总时长 ~800ms）', `elapsed=${elapsed}`);
  client.stop();
}

// —— W7 熔断：连续 3 次失败 → 第 4 次被闸拦 ——
{
  const client = createAppServerClient(baseCfg);
  const safe = createWakeSafe(baseCfg, client);
  for (let i = 0; i < 3; i++) await safe.wakeSafe('g:f', 'FAKE:FAIL', { batchId: `f${i}`, msgs: 1 });
  const r = await safe.wakeSafe('g:f', 'FAKE:OK', { batchId: 'f3', msgs: 1 });
  ok(r.skipped === true && /circuit-open/.test(String(r.reason)), 'W7 熔断：3 败后第 4 次被拦', JSON.stringify(r).slice(0, 100));
  // 其他群不受影响
  const r2 = await safe.wakeSafe('g:other', 'FAKE:OK', { batchId: 'f4', msgs: 1 });
  ok(r2.content === 'OK', 'W7b 熔断只作用于该群，别群照常');
  client.stop();
}

// —— W8 限额：maxDailyWakes=2 ——
{
  const cfg = { ...baseCfg, patrol: { ...baseCfg.patrol, maxDailyWakes: 2 } };
  const client = createAppServerClient(cfg);
  const safe = createWakeSafe(cfg, client);
  await safe.wakeSafe('g:q1', 'FAKE:OK', { batchId: 'q1', msgs: 1 });
  await safe.wakeSafe('g:q2', 'FAKE:OK', { batchId: 'q2', msgs: 1 });
  const r = await safe.wakeSafe('g:q3', 'FAKE:OK', { batchId: 'q3', msgs: 1 });
  ok(r.skipped === true && /limit-daily-wakes/.test(String(r.reason)), 'W8 每日唤醒限额：第 3 次被拦', JSON.stringify(r).slice(0, 100));
  client.stop();
}

// —— W9 静默时段：全覆盖区间 ——
{
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const cfg = { ...baseCfg, patrol: { ...baseCfg.patrol, silentHours: { start: '00:00', end: '23:59' } } };
  const client = createAppServerClient(cfg);
  const safe = createWakeSafe(cfg, client);
  const r = await safe.wakeSafe('g:h', 'FAKE:OK', { batchId: 'h1', msgs: 1 });
  ok(r.skipped === true && r.reason === 'silent-hours', 'W9 静默时段零唤醒（本地拦截不花钱）', JSON.stringify(r));
  // S3.2：私聊不套群静默时段（半夜来一条，回一句比装死好），但走私聊独立限额
  const rp = await safe.wakeSafe('p:h', 'FAKE:OK', { batchId: 'h2', msgs: 1 });
  ok(rp.content === 'OK', 'W9b 私聊豁免静默时段（仍照常唤醒）', JSON.stringify(rp).slice(0, 100));
  void now; void pad;
  client.stop();
}

// —— W13 私聊独立每日限额（S3.2：与全局总额各过一遍，不是二选一）——
{
  // W9b 的私聊唤醒会把 privateWakes 写进共享 counters 文件——本用例前重置，从 0 起算
  writeFileSync(COUNTERS, JSON.stringify({ day: new Date().toISOString().slice(0, 10), dailyWakes: 0, privateWakes: 0 }));
  const cfg = { ...baseCfg, patrol: { ...baseCfg.patrol, silentHours: null }, private: { maxPerDay: 1 } };
  const client = createAppServerClient(cfg);
  const safe = createWakeSafe(cfg, client);
  const r1 = await safe.wakeSafe('p:q', 'FAKE:OK', { batchId: 'pq1', msgs: 1 });
  const r2 = await safe.wakeSafe('p:q', 'FAKE:OK', { batchId: 'pq2', msgs: 1, must: true });
  ok(r1.content === 'OK', 'W13a 私聊第 1 次正常（独立限额从 0 起）');
  ok(r2.skipped === true && /limit-private-per-day/.test(String(r2.reason)), 'W13b 私聊第 2 次被独立限额拦（must 也不豁免成本闸）', JSON.stringify(r2).slice(0, 100));
  const rg = await safe.wakeSafe('g:q', 'FAKE:OK', { batchId: 'pq3', msgs: 1 });
  ok(rg.content === 'OK', 'W13c 私聊限额不影响群（各记各的）');
  client.stop();
}

// —— W10 最小间隔 ——
{
  const cfg = { ...baseCfg, patrol: { ...baseCfg.patrol, minWakeIntervalMs: 60_000 } };
  const client = createAppServerClient(cfg);
  const safe = createWakeSafe(cfg, client);
  const r1 = await safe.wakeSafe('g:i', 'FAKE:OK', { batchId: 'i1', msgs: 1 });
  const r2 = await safe.wakeSafe('g:i', 'FAKE:OK', { batchId: 'i2', msgs: 1 });
  ok(r1.content === 'OK' && r2.skipped === true && /min-interval/.test(String(r2.reason)), 'W10 同群最小间隔：紧跟着的第二次被拦', JSON.stringify(r2).slice(0, 100));
  // must 批次豁免最小间隔（有人叫她必须回；间隔闸是防闲聊刷屏的）
  const r3 = await safe.wakeSafe('g:i', 'FAKE:OK', { batchId: 'i3', msgs: 1, must: true });
  ok(r3.content === 'OK', 'W10b must 批次豁免最小间隔（@消息紧跟也必唤醒）', JSON.stringify(r3).slice(0, 100));
  client.stop();
}

// —— W11 崩溃重启 ——
{
  const client = createAppServerClient(baseCfg);
  const safe = createWakeSafe(baseCfg, client);
  const r1 = await safe.wakeSafe('g:x', 'FAKE:CRASH', { batchId: 'x1', msgs: 1 }).catch((e) => ({ error: e.message }));
  ok(/exited|timeout|request/i.test(String(r1.error)), 'W11a 崩溃当次失败', String(r1.error).slice(0, 80));
  await sleep(3200); // 等自动重启（1s 退避 + 1.5s 就绪）
  const r2 = await safe.wakeSafe('g:x', 'FAKE:OK', { batchId: 'x2', msgs: 1 }).catch((e) => ({ error: e.message }));
  ok(r2.content === 'OK', 'W11b 崩溃后自动重启恢复', JSON.stringify(r2).slice(0, 100));
  client.stop();
}

// —— W12 wake.jsonl 留痕 ——
{
  const lines = readFileSync(join(ROOT_DIR, 'logs', 'wake.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const results = new Set(lines.map((l) => l.result));
  ok(lines.length > 0, 'W12a wake.jsonl 有记录', `lines=${lines.length}`);
  ok(results.has('sent') && results.has('silent') && results.has('error') && results.has('skipped'), 'W12b 四种 result 都留痕（sent/silent/error/skipped）', [...results].join(','));
  ok(lines.every((l) => l.batchId && l.chatKey), 'W12c 每行带 batchId/chatKey（D8）');
}

// —— W14-W16 协议漂移面（D6：fake 补齐 attachments 回执/思考帧/备选 sessionId 后锁定）——
{
  const client = createAppServerClient(baseCfg);
  // W14 attachments 通路：附件从 wakeOnce 一路序列化进 session/send 帧——fake 回执里见真章
  const r14 = await client.wakeOnce('FAKE:ATT', { attachments: [
    { kind: 'image', localPath: 'D:/x/a.jpg', filename: 'a.jpg', mimeType: 'image/jpeg' },
    { kind: 'image', localPath: 'D:/x/b.png', filename: 'b.png', mimeType: 'image/png' },
  ] });
  ok(/OK/.test(r14.content) && r14.content.includes('[att:a.jpg|b.png]'), 'W14 attachments 通路：回执含两个文件名', JSON.stringify(r14.content));
  const r14b = await client.wakeOnce('FAKE:ATT', {});
  ok(r14b.content.includes('[att:none]'), 'W14b 无附件时回执 none（字段可缺省）', r14b.content);
  // W15 thinking 帧：reasoning_delta（协议实测命名）→ thinking 采集
  const r15 = await client.wakeOnce('FAKE:THINK', {});
  ok(r15.thinking === '思考内容' && r15.content === 'OK', 'W15 reasoning_delta 思考帧采集', JSON.stringify(r15).slice(0, 120));
  // W16 备选 sessionId 形状（payload.sessionId）：串线过滤兼容两种帧形态
  const r16 = await client.wakeOnce('FAKE:ALT-SID', {});
  ok(r16.content === 'OK', 'W16 payload.sessionId 备选形状不误杀', JSON.stringify(r16).slice(0, 100));
  client.stop();
}

// —— W17 counters 损坏 fail-closed（审计"兜底债"核心路径：损坏 = 按已达上限保守拦截，当日哑）——
{
  writeFileSync(COUNTERS, '{bad json');
  const cfg = { ...baseCfg, patrol: { ...baseCfg.patrol, maxDailyWakes: 5 } };
  const client = createAppServerClient(cfg);
  const safe = createWakeSafe(cfg, client);
  const r = await safe.wakeSafe('g:corrupt', 'FAKE:OK', { batchId: 'corrupt1', msgs: 1 });
  ok(r.skipped === true && /limit-daily-wakes/.test(String(r.reason)), 'W17 counters 损坏被保守拦截（fail-closed 当日哑）', JSON.stringify(r).slice(0, 100));
  client.stop();
}

// —— 恢复生产 counters ——
if (hadCounters) copyFileSync(BAK, COUNTERS);
else try { rmSync(COUNTERS); } catch { /* 本来就没有 */ }
try { rmSync(BAK); } catch { /* 无备份 */ }

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
