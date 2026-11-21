// 防刷屏冒烟测试：段数收缩 / busy 收缩 / 字数闸门 / 段间延迟 / 5min 滚动窗口 defer / 回归
// v6：群号与 message_id 换新（test-outbound-v2 的 state 落盘会跨进程泄漏，这里全部错开）；
//     T3 断言改按文本字数统计；T4 写 outbox 前先建目录
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInbound, isBusy } from './lib/inbound.mjs';
import { createOutbound } from './lib/outbound.mjs';
import { startOutboxPolling } from './lib/bridge.mjs';
import { ROOT_DIR } from './lib/util.mjs';

// —— 跨进程状态隔离（D13 落盘副作用）：counters.json 的 dailyCount/roll 窗口会被上一轮
//    测试写进盘并被本轮读回（T4/T6 的 5min 窗口直接满格）。备份→清场→测后恢复
const COUNTERS = join(ROOT_DIR, 'state', 'counters.json');
const COUNTERS_BAK = COUNTERS + '.test-bak';
const hadCounters = existsSync(COUNTERS);
if (hadCounters) copyFileSync(COUNTERS, COUNTERS_BAK);
if (hadCounters) rmSync(COUNTERS);

const tmp = mkdtempSync(join(tmpdir(), 'fishflood-'));
const cfg = {
  onebot: { selfId: '10000' },
  bridge: { mode: 'file', fishpondDir: tmp.replace(/\\/g, '/') },
  botName: '测试鱼',
  p1: { busyWindowMs: 300000, busyMsgThreshold: 3, busyUserThreshold: 2, nonMustThrottleMs: 120000, staleMinutes: 10, maxPendingPerPoll: 10 },
  allow: { groups: ['100', '200', '310', '450', '500', '610', '620'], private: ['1'], allowAllWhenEmpty: false },
  ownerQQ: '1',
  limits: { maxRepliesPerMessage: 2, maxProactivePerGroupPerMinute: 1, maxDailyTotal: 200, maxRepliesPerGroupPer5Min: 5, maxWindow5MinMs: 300000, maxSegments: 4, busyMaxSegments: 2, maxTotalChars: 150 },
  zcode: { botId: 't', secret: '', callbackUrl: '' },
  bannedWords: [],
  audit: {},
};

const calls = []; // { cmd, p, t }
const onebot = { action: async (cmd, p) => { calls.push({ cmd, p, t: Date.now() }); return { status: 'ok' }; } };
const inboundState = new Map();
const outbound = createOutbound(cfg, onebot, inboundState);
const meta = (chatId, f) => ({ chatType: 'group', chatId, userId: '1', inboxFile: f, source: 'test' });

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

// T1 非 busy 段数收缩：6 行只发前 4 段（maxSegments=4），且段间有 ≥1.5s 延迟
{
  const before = calls.length;
  const r = await outbound.processMessage('一\n二\n三\n四\n五\n六', meta('110', 't1.json'));
  const seg = calls.slice(before);
  ok(r.action === 'sent' && seg.length === 4, 'T1a 6行→4段', `got ${seg.length}`);
  ok(seg[3].t - seg[1].t >= 3000, 'T1b 段间延迟≥1.5s×2', `Δ=${seg[3].t - seg[1].t}ms`);
}

// T2 busy 收缩：灌 4 条消息（3 人，阈值 3/2）→ 热闹 → 6 行只发 2 段
{
  const ib = createInbound(cfg, onebot);
  let mid = 77001 + (Date.now() % 9_000_000) * 10; // 每次跑全新 id 段：seen.jsonl 5min TTL 内二跑不再误判重复
  for (const uid of ['11', '12', '13', '11']) {
    await ib.handle({ message_type: 'group', group_id: 610, user_id: Number(uid), message_id: mid++, message: [{ type: 'text', data: { text: '哈' } }], time: Date.now() / 1000, sender: { nickname: 'n' } });
  }
  ok(isBusy('g:610', cfg) === true, 'T2a 窗口热闹判定');
  const before = calls.length;
  const r = await outbound.processMessage('一\n二\n三\n四\n五\n六', meta('610', 't2.json'));
  ok(r.action === 'sent' && calls.length - before === 2, 'T2b 热闹时6行→2段', `got ${calls.length - before}`);
}

// T3 字数闸门：3 行 × 80 字 = 240 字 > 150 → 截到 2 段（160 字，按文本字数统计）
{
  const line = 'x'.repeat(80);
  const before = calls.length;
  const r = await outbound.processMessage([line, line, line].join('\n'), meta('310', 't3.json'));
  const sent = calls.slice(before);
  const total = sent.reduce((s, c) => s + c.p.message.filter((x) => x.type === 'text').reduce((a, x) => a + x.data.text.length, 0), 0);
  ok(r.action === 'sent' && sent.length === 2 && total === 160, 'T3 超长截断', `got ${sent.length}段${total}字`);
}

// T4 5min 滚动窗口：g:450 发满 5 条后第 6 条 defer；defer 经文件桥保留不删
{
  for (let i = 1; i <= 5; i++) {
    const r = await outbound.processMessage(`第${i}条`, meta('450', `t4-${i}.json`));
    if (r.action !== 'sent') ok(false, `T4a 第${i}条应发送`, r.reason);
  }
  ok(true, 'T4a 同群连发5条（窗口=5）');
  const r6 = await outbound.processMessage('第6条', meta('450', 't4-6.json'));
  ok(r6.action === 'defer' && r6.reason === 'limit-window', 'T4b 第6条defer', JSON.stringify(r6));
  // 文件桥 defer 保留：第 6 条走真实轮询，文件应原样保留
  const outbox = join(tmp, '.outbox');
  mkdirSync(outbox, { recursive: true }); // v6：轮询外的手动写入先建目录
  writeFileSync(join(outbox, 't4-6.json'), JSON.stringify({ text: '第6条', chatType: 'group', chatId: '450', userId: '1', inboxFile: 't4-6.json' }), 'utf8');
  const stop = startOutboxPolling(cfg, outbound.processMessage, 50);
  await new Promise((r) => setTimeout(r, 300));
  stop();
  ok(existsSync(join(outbox, 't4-6.json')), 'T4c defer文件保留待错峰');
}

// T5 回归：SILENT / 审计 / 私聊不受群窗口限制
{
  ok((await outbound.processMessage('[SILENT] 不想回', meta('500', 't5a.json'))).reason === 'silent', 'T5a SILENT 不出群');
  ok((await outbound.processMessage('key = sk-abcdefghijklmnopqrst', meta('500', 't5b.json'))).reason === 'audit-api-key', 'T5b 审计整条丢弃');
  const r = await outbound.processMessage('私聊不受群窗口影响', { chatType: 'private', userId: '1', inboxFile: 't5c.json', source: 'test' });
  ok(r.action === 'sent', 'T5c 私聊正常');
}

// T6 回归：同一 inboxFile 回复计数仍按 1:1（maxRepliesPerMessage=2）
{
  ok((await outbound.processMessage('回1', meta('620', 't6.json'))).action === 'sent', 'T6a 第1条');
  ok((await outbound.processMessage('回2', meta('620', 't6.json'))).action === 'sent', 'T6b 第2条');
  ok((await outbound.processMessage('回3', meta('620', 't6.json'))).reason === 'limit-replies-per-message', 'T6c 第3条被拦');
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
// —— 恢复生产 counters（本测试写下的测试计数不外泄）——
if (hadCounters) copyFileSync(COUNTERS_BAK, COUNTERS);
else try { rmSync(COUNTERS); } catch { /* 本来就没有 */ }
try { rmSync(COUNTERS_BAK); } catch { /* 无备份 */ }
process.exit(fail ? 1 : 0);
