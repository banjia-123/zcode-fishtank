// T2 出站结构化离线用例（改造任务书 v6 S1.5）：新格式 / 老格式并存 / 审计双扫 / 三级兜底 /
// 字段校验（D15）/ 部分成功（D4b）/ 计数落盘（D13）/ 审计脱敏（D12）。不起真进程，mock OneBot。
// 跑法：node test-outbound-v2.mjs，退出码 0 = 全过
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInbound, isBusy } from './lib/inbound.mjs';
import { createOutbound } from './lib/outbound.mjs';
import { parseOutboxBody, startOutboxPolling } from './lib/bridge.mjs';

const ADAPTER_ROOT = join(dirname(fileURLToPath(import.meta.url)));
const AUDIT_LOG = join(ADAPTER_ROOT, 'logs', 'audit.log');

const tmp = mkdtempSync(join(tmpdir(), 'fishv2-'));
const cfg = {
  onebot: { selfId: '10000' },
  bridge: { mode: 'file', fishpondDir: tmp.replace(/\\/g, '/') },
  botName: '测试鱼',
  p1: { busyWindowMs: 300000, busyMsgThreshold: 3, busyUserThreshold: 2, nonMustThrottleMs: 120000, staleMinutes: 10, maxPendingPerPoll: 50 },
  allow: { groups: ['100', '200', '300', '400', '500', '600', '700', '800'], private: ['1'], allowAllWhenEmpty: false },
  ownerQQ: '1',
  limits: { maxRepliesPerMessage: 2, maxProactivePerGroupPerMinute: 1, maxDailyTotal: 200, maxRepliesPerGroupPer5Min: 50, maxWindow5MinMs: 300000, maxSegments: 4, busyMaxSegments: 2, maxTotalChars: 150 },
  zcode: { botId: 't', secret: '', callbackUrl: '' },
  bannedWords: [],
  audit: {},
};
mkdirSync(join(tmp, 'emojis'), { recursive: true });
writeFileSync(join(tmp, 'emojis', 'test.png'), 'png');

const calls = []; // { cmd, p, t }
let failNextSend = 0; // D4b 用：让第 N 次 send_group_msg 失败
const onebot = {
  action: async (cmd, p) => {
    calls.push({ cmd, p, t: Date.now() });
    if (cmd === 'send_group_msg' && failNextSend > 0) { failNextSend -= 1; return { status: 'fail', retcode: 1 }; }
    return { status: 'ok' };
  },
};
const inboundState = new Map();
const outbound = createOutbound(cfg, onebot, inboundState);
const meta = (chatId, f) => ({ chatType: 'group', chatId, userId: '1', inboxFile: f, source: 'test' });

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const segs = (before) => calls.slice(before).filter((c) => c.cmd.startsWith('send_'));

// 用例 1 · 老格式 {text} → 正常发，行为与改造前一致
{
  const b = calls.length;
  const r = await outbound.processMessage({ text: '你好' }, meta('100', 'c1.json'));
  ok(r.action === 'sent' && segs(b).length === 1 && segs(b)[0].p.message[0].data.text === '你好', '1 老格式 text 正常发', JSON.stringify(r));
}

// 用例 2 · 新格式 2 行 → 发 2 条，间隔 ≥1.5 秒
{
  const b = calls.length;
  const r = await outbound.processMessage({ lines: ['第一句', '第二句'] }, meta('100', 'c2.json'));
  const s = segs(b);
  ok(r.action === 'sent' && s.length === 2, '2a 新格式2行→2段', `got ${s.length}`);
  ok(s[1].t - s[0].t >= 1500, '2b 段间延迟≥1.5s', `Δ=${s[1].t - s[0].t}`);
  ok(s[0].p.message[0].data.text === '第一句', '2c 行序保持');
}

// 用例 3 · 某行含盘符路径 → 整条丢弃 + audit.log 有记录且不含原文（D12）
{
  const b = calls.length;
  const r = await outbound.processMessage({ lines: ['看看这个', '就在 C:\\Users\\Administrator\\secret.txt 里'] }, meta('300', 'c3.json'));
  ok(r.action === 'dropped' && r.reason === 'audit-win-path' && segs(b).length === 0, '3a 盘符路径整条丢弃', JSON.stringify(r));
  const tail = readFileSync(AUDIT_LOG, 'utf8').trim().split('\n').at(-1);
  ok(tail.includes('rule=win-path') && tail.includes('fp='), '3b audit.log 有指纹记录', tail.slice(0, 120));
  ok(!tail.includes('secret.txt'), '3c audit.log 不含原文（D12）');
}

// 用例 4 · 某行含 sk- 密钥 → 整条丢弃
{
  const b = calls.length;
  const r = await outbound.processMessage({ lines: ['密钥是 sk-abcdefghijklmnop'] }, meta('300', 'c4.json'));
  ok(r.action === 'dropped' && r.reason === 'audit-api-key' && segs(b).length === 0, '4 sk- 整条丢弃', JSON.stringify(r));
}

// 用例 5 · silent 最高优先：lines + silent:true → 一条不发
{
  const b = calls.length;
  const r = await outbound.processMessage({ lines: ['其实想说'], silent: true }, meta('300', 'c5.json'));
  ok(r.action === 'dropped' && r.reason === 'silent' && segs(b).length === 0, '5 silent 优先于 lines', JSON.stringify(r));
}

// 用例 6 · reply_to 非数字 → 不挂引用，正常发
{
  const b = calls.length;
  const r = await outbound.processMessage({ lines: ['回答'], reply_to: 'abc' }, meta('100', 'c6.json'));
  const s = segs(b);
  ok(r.action === 'sent' && s.length === 1 && !s[0].p.message.some((x) => x.type === 'reply'), '6 非法 reply_to 忽略不挂引用', JSON.stringify(r));
}

// 用例 7 · lines 8 项 → 只发前 5，返回 truncated:3
{
  const b = calls.length;
  const r = await outbound.processMessage({ lines: ['一', '二', '三', '四', '五', '六', '七', '八'] }, meta('400', 'c7.json'));
  const s = segs(b);
  ok(r.action === 'sent' && s.length === 5 && r.truncated === 3, '7 超行截断 truncated=3', `sent=${s.length} truncated=${r.truncated}`);
}

// 用例 8 · 带代码块围栏的合法结构 → 能解析（S1.4 二级兜底）
{
  const raw = '```json\n{"lines":["围栏里的话"],"chatType":"group","chatId":"500"}\n```';
  const parsed = parseOutboxBody(raw);
  ok(parsed.degraded === 'fence' && Array.isArray(parsed.body.lines) && parsed.body.lines[0] === '围栏里的话', '8 剥围栏解析', JSON.stringify(parsed.degraded));
}

// 用例 9 · 完全不是 JSON 的一段话 → 整段当 text，不丢
{
  const raw = '这不是JSON，就是一段话';
  const parsed = parseOutboxBody(raw);
  ok(parsed.degraded === 'plaintext' && parsed.body.text === raw, '9 坏 JSON 整段当文本', JSON.stringify(parsed.degraded));
}

// 用例 10 · 跨行拼接密钥：["sk-", "abcdefghijklmnop"] → 整条丢弃（先整段后逐行，顺序不可换）
{
  const b = calls.length;
  const r = await outbound.processMessage({ lines: ['sk-', 'abcdefghijklmnop'] }, meta('300', 'c10.json'));
  ok(r.action === 'dropped' && r.reason === 'audit-api-key' && segs(b).length === 0, '10 跨行拼接整条丢弃', JSON.stringify(r));
}

// 用例 11 · busy 时新格式 5 行 → 仍发满 5 条（maxSegments 解耦，不许被老逻辑砍成 2）
{
  const ib = createInbound(cfg, onebot);
  let mid = Date.now() % 100000000000; // 随机化：seen.jsonl 落盘跨进程，固定 id 会让第二轮测试被去重拦住
  for (const uid of ['11', '12', '13', '11']) {
    await ib.handle({ message_type: 'group', group_id: 600, user_id: Number(uid), message_id: mid++, message: [{ type: 'text', data: { text: '哈' } }], time: Date.now() / 1000, sender: { nickname: 'n' } });
  }
  ok(isBusy('g:600', cfg) === true, '11a busy 判定');
  const b = calls.length;
  const r = await outbound.processMessage({ lines: ['一', '二', '三', '四', '五'] }, meta('600', 'c11.json'));
  ok(r.action === 'sent' && segs(b).length === 5, '11b busy 不砍新格式行数', `sent=${segs(b).length}`);
}

// 用例 12 · 缺 inboxFile（文件桥真实轮询）：正常发送 + outbox/inbox 文件都被删（D3：以适配器注入名为准）
{
  const outbox = join(tmp, '.outbox');
  const inbox = join(tmp, '.inbox');
  mkdirSync(outbox, { recursive: true });
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(outbox, '9900000000-12345.json'), JSON.stringify({ lines: ['轮询发送'], chatType: 'group', chatId: '700' }), 'utf8');
  writeFileSync(join(inbox, '9900000000-12345.json'), '{}', 'utf8');
  const stop = startOutboxPolling(cfg, (body, m) => outbound.processMessage(body, m), 50);
  await new Promise((r) => setTimeout(r, 600));
  stop();
  ok(!existsSync(join(outbox, '9900000000-12345.json')), '12a outbox 已删');
  ok(!existsSync(join(inbox, '9900000000-12345.json')), '12b inbox 联动删除（模型无 inboxFile 也不重复回复）');
}

// 用例 13 · 老格式路径收到对象参数 → 不崩、正常发（D7 回滚兼容）
{
  const r = await outbound.processMessage({ text: '对象形态的老格式' }, meta('800', 'c13.json'));
  ok(r.action === 'sent', '13 对象形态老格式正常发', JSON.stringify(r));
}

// D15 · 结构化字段校验：非法忽略字段，正文照发
{
  const b = calls.length;
  const r = await outbound.processMessage({ lines: ['正文照发'], reply_to: '../../etc/passwd', sticker: '../config.json', voice: '你好' }, meta('800', 'd15.json'));
  const s = segs(b);
  const hasImage = s.some((c) => c.p.message.some((x) => x.type === 'image'));
  ok(r.action === 'sent' && s.length === 1 && !s[0].p.message.some((x) => x.type === 'reply') && !hasImage, 'D15 三个非法字段全部忽略', JSON.stringify(r));
}

// sticker 有效 → 图文同条
{
  const b = calls.length;
  const r = await outbound.processMessage({ lines: ['带图'], sticker: 'test.png' }, meta('800', 'stk.json'));
  const s = segs(b);
  const hasImage = s.some((c) => c.p.message.some((x) => x.type === 'image' && String(x.data?.file ?? '').includes('emojis/test.png')));
  ok(r.action === 'sent' && hasImage, 'sticker 有效 → 图文同条', JSON.stringify(r));
}

// 简写标记 [xxx.png]（2026-11-22 简写漂移修复）：库里存在 → 解析成表情；不在库内 → 字面保留不误伤
{
  const b = calls.length;
  const r = await outbound.processMessage({ text: '散了散了。[test.png]' }, meta('801', 'short.json'));
  const s = segs(b);
  const hasImage = s.some((c) => c.p.message.some((x) => x.type === 'image' && String(x.data?.file ?? '').includes('emojis/test.png')));
  const body = s.map((c) => JSON.stringify(c.p.message)).join('');
  ok(r.action === 'sent' && hasImage && !body.includes('[test.png]'), '简写 [test.png] 在库内 → 发表情不留字面', JSON.stringify(r));
}
{
  const b = calls.length;
  const r = await outbound.processMessage({ text: '这是个梗 [不存在的图.png]' }, meta('802', 'short-miss.json'));
  const s = segs(b);
  const hasImage = s.some((c) => c.p.message.some((x) => x.type === 'image'));
  const hasLiteral = s.some((c) => String(c.p.message?.[0]?.data?.text ?? '').includes('[不存在的图.png]'));
  ok(r.action === 'sent' && !hasImage && hasLiteral, '简写 [不在库内] → 字面保留不发图', JSON.stringify(r));
}

// D4b · 部分成功即成功：第 1 段成功、第 2 段失败 → 已发的不重发、整体算 sent（不进重试）
{
  const b = calls.length;
  const origAction = onebot.action;
  let sendN = 0;
  onebot.action = async (cmd, p) => {
    if (cmd === 'send_group_msg') { sendN += 1; if (sendN === 2) return { status: 'fail', retcode: 1 }; }
    return origAction(cmd, p);
  };
  const r = await outbound.processMessage({ lines: ['一段', '二段', '三段'] }, meta('800', 'd4b.json'));
  onebot.action = origAction;
  const s = segs(b);
  // mock 里失败那次不进 calls（NapCat 拒收）——适配器视角=成功发出 1 段，且不重试
  ok(r.action === 'sent' && s.length === 1, 'D4b 部分成功返回 sent 不重试', `action=${r.action} sent=${s.length}`);
  const texts = s.map((c) => c.p.message.find((x) => x.type === 'text')?.data?.text);
  ok(texts.length === 1 && texts[0] === '一段', 'D4b 只含失败前的段（二段三段不重发）', JSON.stringify(texts));
}

// D13 · 计数器落盘：发送成功后 state/counters.json 存在且含当日计数
{
  const countersFile = join(ADAPTER_ROOT, 'state', 'counters.json');
  ok(existsSync(countersFile), 'D13a counters.json 落盘');
  const o = JSON.parse(readFileSync(countersFile, 'utf8'));
  ok(typeof o.dailyCount === 'number' && o.dailyCount > 0 && o.day === `${new Date().getFullYear()}-${new Date().getMonth() + 1}-${new Date().getDate()}`, 'D13b 计数与日期正确', JSON.stringify(o).slice(0, 120));
}

// 回归 · 老格式行为不变：busy 收缩 / maxTotalChars / SILENT 前缀
{
  const r = await outbound.processMessage('[SILENT] 不想回', meta('500', 'r1.json'));
  ok(r.reason === 'silent', '回归 [SILENT] 不出群');
  const b = calls.length;
  const line = 'x'.repeat(80);
  const r2 = await outbound.processMessage([line, line, line].join('\n'), meta('500', 'r2.json'));
  const total = segs(b).reduce((acc, c) => acc + c.p.message.filter((x) => x.type === 'text').reduce((a, x) => a + x.data.text.length, 0), 0);
  ok(r2.action === 'sent' && total <= 160, '回归 老格式字数闸门仍生效', `total=${total}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
