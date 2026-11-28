// T2 出站结构化离线用例（改造任务书 v6 S1.5）：新格式 / 老格式并存 / 审计双扫 / 三级兜底 /
// 字段校验（D15）/ 部分成功（D4b）/ 计数落盘（D13）/ 审计脱敏（D12）。不起真进程，mock OneBot。
// 跑法：node test-outbound-v2.mjs，退出码 0 = 全过
import { STATE_ROOT, cleanOnExit } from './test-setup.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInbound, isBusy } from './lib/inbound.mjs';
import { createOutbound, typingDelayMs, shouldQuoteDecision } from './lib/outbound.mjs';
import { stripOsHead, sweepStalePerChat } from './lib/outbound.mjs';
import { parseOutboxBody, startOutboxPolling, bridgeDirs } from './lib/bridge.mjs';
import { sameStickerRecentlyUsed } from './lib/outbound.mjs';

// 审计日志、计数器都落在 STATE_ROOT（一次性临时目录）下——测试不碰生产文件
const AUDIT_LOG = join(STATE_ROOT, 'logs', 'audit.log');

const tmp = mkdtempSync(join(tmpdir(), 'fishv2-'));
cleanOnExit(tmp);
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

// 行内 [SILENT] 标记剥除（2026-11-22 模型把标记当段落间沉默符号——字面漏出站）：剥掉照发；裸词不误伤
{
  const b = calls.length;
  const r = await outbound.processMessage({ text: '心里对你无语。[SILENT]\n\n等等，被 @ 了得回——继续说' }, meta('803', 'silent-inline.json'));
  const s = segs(b);
  const body = s.map((c) => JSON.stringify(c.p.message)).join('');
  ok(r.action === 'sent' && !body.includes('[SILENT]') && body.includes('继续说'), '行内 [SILENT] 剥除照发', JSON.stringify(r));
}
{
  const b = calls.length;
  const r = await outbound.processMessage({ text: "他说'沉默是金'，[沉默]不代表没话说" }, meta('804', 'silent-bare.json'));
  const s = segs(b);
  const body = s.map((c) => JSON.stringify(c.p.message)).join('');
  ok(r.action === 'sent' && !body.includes('[沉默]') && body.includes('沉默是金'), '裸词"沉默"不误伤，标记形态剥除', JSON.stringify(r));
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
  const countersFile = join(STATE_ROOT, 'state', 'counters.json');
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

// 拟真打字（2026-11-25）：typingDelayMs 纯函数边界——下限兼容旧断言（2b/T1b ≥1500ms），上限夹断，关闭分支回退旧节奏
{
  let inRange = true, overMin = false;
  for (let k = 0; k < 100; k++) {
    const d = typingDelayMs('随便一句话'.repeat(8), 0.15);
    if (d < 1500 || d > 8000) inRange = false;
    if (d > 8000) overMin = true;
  }
  ok(inRange, '拟真 100 次采样全部 ∈ [1500, 8000]', overMin ? '超上限' : '');
  const d100 = typingDelayMs('x'.repeat(100), 0.15);
  ok(d100 >= 1500 && d100 <= 8000, '拟真 100 字长行被 8000ms 上限夹断', `d=${d100}`);
  let oldRange = true;
  for (let k = 0; k < 100; k++) {
    const d = typingDelayMs('同一句话', 0);
    if (d < 1500 || d > 4000) oldRange = false;
  }
  ok(oldRange, '拟真 secPerChar=0 回退旧节奏 ∈ [1500, 4000]');
  const dNaN = typingDelayMs('任何', Number.NaN);
  ok(dNaN >= 1500 && dNaN <= 4000, '拟真 NaN 视为关闭，回退旧节奏', `d=${Math.round(dNaN)}`);
}

// 引用概率化（2026-11-28，P1 借鉴 MaiBot quoting）：决策纯函数四规则——must 不挂/多人批必挂/慢回复必挂/闲聊 20%
{
  ok(shouldQuoteDecision({ must: true, batchLen: 1, ageSec: 5 }) === false, 'Q1 被 @/叫名不挂引用（@ 通知已指向）');
  ok(shouldQuoteDecision({ must: false, batchLen: 3, ageSec: 5 }) === true, 'Q2 多人批（≥3 条）必挂（要指定回谁）');
  ok(shouldQuoteDecision({ must: false, batchLen: 1, ageSec: 95 }) === true, 'Q3 慢回复（≥90s）必挂（隔久了要指向）');
  ok(shouldQuoteDecision({ must: false, batchLen: 1, ageSec: 5 }, () => 0.1) === true, 'Q4a 单人闲聊低概率挂（rand<0.2）');
  ok(shouldQuoteDecision({ must: false, batchLen: 2, ageSec: 30 }, () => 0.9) === false, 'Q4b 单人闲聊多数不挂（rand≥0.2）');
  let rate = 0;
  for (let k = 0; k < 1000; k++) if (shouldQuoteDecision({ must: false, batchLen: 1, ageSec: 1 })) rate += 1;
  ok(rate > 120 && rate < 280, 'Q5 闲聊挂引用概率约 20%（1000 次采样）', `rate=${rate / 10}%`);
}

// 同图冷却（2026-11-28，P2 借鉴 MaiBot 600s 降权）：同 chatKey 同 basename 冷却窗内不重发
{
  mkdirSync(join(tmp, 'logs'), { recursive: true }); // recordSpeak 落盘目录（此前测试从未真写过 speak.jsonl）
  writeFileSync(join(tmp, 'emojis', 'other.png'), 'png'); // CD2 的第二张图
  const hasImage = (b) => segs(b).some((c) => c.p.message.some((x) => x.type === 'image'));

  // CD0：g:900 首发同图（此前该群无发言）→ 成功带图，speak.jsonl 记 emoji
  const b0 = calls.length;
  const r0 = await outbound.processMessage({ lines: ['第一张'], sticker: 'test.png' }, meta('900', 'cd0.json'));
  ok(r0.action === 'sent' && hasImage(b0), 'CD0 冷却前首发表情正常带图');

  // CD1：冷却窗内同群同图 → 降级纯文本
  const b1 = calls.length;
  const r1 = await outbound.processMessage({ lines: ['再来一张'], sticker: 'test.png' }, meta('900', 'cd1.json'));
  ok(r1.action === 'sent' && !hasImage(b1), 'CD1 冷却窗内同图被拦（降级纯文本）', JSON.stringify(r1));

  // CD2：冷却窗内同群换图 → 不拦（冷却只管"重复"，量交给条数闸）
  const b2 = calls.length;
  const r2 = await outbound.processMessage({ lines: ['换一张'], sticker: 'other.png' }, meta('900', 'cd2.json'));
  ok(r2.action === 'sent' && hasImage(b2), 'CD2 冷却窗内换图不拦');

  // CD3：冷却窗外（11 分钟前手写记录）同图 → 放行
  const speakFile = join(bridgeDirs(cfg).base, 'logs', 'speak.jsonl');
  appendFileSync(speakFile, JSON.stringify({ ts: new Date(Date.now() - 11 * 60_000).toISOString(), chat: 'g:910', text: '很久以前', source: 'test', emoji: 'test.png' }) + '\n', 'utf8');
  const b3 = calls.length;
  const r3 = await outbound.processMessage({ lines: ['隔了很久'], sticker: 'test.png' }, meta('910', 'cd3.json'));
  ok(r3.action === 'sent' && hasImage(b3), 'CD3 冷却窗外同图放行');

  // CD5 单测：窗口边界/损坏行/ENOENT/fail-closed
  const cfgProbe = { bridge: { fishpondDir: tmp.replace(/\\/g, '/') } };
  const recent = JSON.stringify({ ts: new Date(Date.now() - 60_000).toISOString(), chat: 'g:x', emoji: 'a.png' });
  const stale = JSON.stringify({ ts: new Date(Date.now() - 11 * 60_000).toISOString(), chat: 'g:x', emoji: 'a.png' });
  const probeDir = join(bridgeDirs(cfgProbe).base, 'logs');
  mkdirSync(probeDir, { recursive: true });
  const probeFile = join(probeDir, 'speak.jsonl');
  writeFileSync(probeFile, [recent, '{broken', stale].join('\n') + '\n', 'utf8');
  ok(sameStickerRecentlyUsed(cfgProbe, 'g:x', 'a.png', 600) === true, 'CD5a 窗内同图 → true（损坏行跳过不炸）');
  ok(sameStickerRecentlyUsed(cfgProbe, 'g:x', 'a.png', 60) === false, 'CD5b 超窗（11 分钟前 vs 60s 冷却）→ false');
  ok(sameStickerRecentlyUsed(cfgProbe, 'g:y', 'a.png', 600) === false, 'CD5c 他群记录不串台');
  const cfgNoFile = { bridge: { fishpondDir: mkdtempSync(join(tmpdir(), 'fish-cd-')).replace(/\\/g, '/') } };
  ok(sameStickerRecentlyUsed(cfgNoFile, 'g:x', 'a.png', 600) === false, 'CD5d 无 speak.jsonl（ENOENT）→ false');

  // CD6 总开关（P1-1 审计修复）：enabled=false = 条数闸与同图冷却全关（原先冷却漏关仍生效）
  writeFileSync(join(STATE_ROOT, 'config.json'), JSON.stringify({ emojiGate: { enabled: false, cooldownSec: 600 } }));
  const b6a = calls.length;
  await outbound.processMessage({ lines: ['开关关了第一次'], sticker: 'test.png' }, meta('920', 'cd6a.json'));
  const b6b = calls.length;
  const r6b = await outbound.processMessage({ lines: ['开关关了第二次'], sticker: 'test.png' }, meta('920', 'cd6b.json'));
  ok(hasImage(b6a) && r6b.action === 'sent' && hasImage(b6b), 'CD6 enabled=false：同图二连发都放行（条数闸+冷却全关）', JSON.stringify(r6b));
  unlinkSync(join(STATE_ROOT, 'config.json')); // 还原默认（后续无 config 读取方，防未来用例被污染）
}

// 全角括号漂移（2026-11-28 第三次格式漂移实测：她把图名写进全角括号当"发图"，字面漏出站三连
// ——（叼猎物.png）02:52/02:54/02:56 连发）。处置对齐 11-22 简写漂移：库里存在才转图，不存在保留字面
{
  writeFileSync(join(STATE_ROOT, 'config.json'), JSON.stringify({ emojiGate: { enabled: true, cooldownSec: 600 } }));
  const hasImg = (n) => segs(n).some((c) => c.p.message.some((x) => x.type === 'image'));
  const textOf = (n) => segs(n).map((c) => c.p.message.filter((x) => x.type === 'text').map((x) => x.data.text).join('')).join('');
  writeFileSync(join(tmp, 'emojis', '独处.png'), 'png'); // FR 组专用图（与 CD 组冷却记录隔离）

  // FR1：全角括号+库内图 → 转图发送，字面剥除
  const bF1 = calls.length;
  const rF1 = await outbound.processMessage({ lines: ['吾持保留意见。（独处.png）'] }, meta('930', 'fr1.json'));
  ok(rF1.action === 'sent' && hasImg(bF1), 'FR1 全角括号库内图转表情发送', JSON.stringify(rF1));
  ok(!textOf(bF1).includes('独处.png'), 'FR1b 全角括号字面已剥除（不再漏出站）', textOf(bF1).slice(-80));

  // FR2：全角括号+库外图名 → 不转图，字面保留（不误伤真括号文字）
  const bF2 = calls.length;
  const rF2 = await outbound.processMessage({ lines: ['这个梗（不存在图.png）挺好笑'] }, meta('930', 'fr2.json'));
  ok(rF2.action === 'sent' && !hasImg(bF2), 'FR2 库外全角括号不转图');
  ok(textOf(bF2).includes('（不存在图.png）'), 'FR2b 库外全角括号字面保留', textOf(bF2).slice(-80));

  // FR3：半角圆括号 (独处.png) → 不解析，字面保留（半角不收：英文正文括号注释常见）
  const bF3 = calls.length;
  const rF3 = await outbound.processMessage({ lines: ['半角试试 (独处.png)'] }, meta('930', 'fr3.json'));
  ok(rF3.action === 'sent' && !hasImg(bF3), 'FR3 半角圆括号不转图');
  ok(textOf(bF3).includes('(独处.png)'), 'FR3b 半角括号字面保留', textOf(bF3).slice(-80));

  // FR4：全角转图落 speak.jsonl → 同图冷却联动（600s 内同群同图 → 拦，剥字面降纯文本）
  const bF4 = calls.length;
  const rF4 = await outbound.processMessage({ lines: ['再发一次。（独处.png）'] }, meta('930', 'fr4.json'));
  ok(rF4.action === 'sent' && !hasImg(bF4), 'FR4 全角转图进冷却体系：600s 内同图被拦（FR1 已发过独处.png）');
  ok(!textOf(bF4).includes('独处.png'), 'FR4b 被拦后字面也剥除', textOf(bF4).slice(-80));

  // FR5（2026-11-28 二轮实战变异）：半开形态（独处.png——漏闭括号，字面漏出站两条）→ 也转图
  const bF5 = calls.length;
  const rF5 = await outbound.processMessage({ lines: ['半开也认。（独处.png'] }, meta('931', 'fr5.json'));
  ok(rF5.action === 'sent' && hasImg(bF5), 'FR5 半开形态（漏闭括号）行尾转图', JSON.stringify(rF5));
  ok(!textOf(bF5).includes('独处.png'), 'FR5b 半开字面剥除', textOf(bF5).slice(-80));

  // FR6：半开形态段中（图名后是换行）→ 转图且后续正文完整（换群 g:932：避开 FR5 刚写的 g:931 同图冷却）
  const bF6 = calls.length;
  const rF6 = await outbound.processMessage({ lines: ['照这进度攒不够。（独处.png\n\n不过梦想还是要有的。'] }, meta('932', 'fr6.json'));
  ok(rF6.action === 'sent' && hasImg(bF6), 'FR6 半开形态段中转图', JSON.stringify(rF6));
  const f6text = textOf(bF6);
  ok(f6text.includes('照这进度攒不够。') && f6text.includes('不过梦想还是要有的。') && !f6text.includes('独处.png'), 'FR6b 剥除后前后正文完整无残字', f6text.slice(-80));

  // FR7：括号内引用保护（图名后跟普通空格继续写内容 → 非发图形态，保留字面不转图）
  const bF7 = calls.length;
  const rF7 = await outbound.processMessage({ lines: [' referencing （独处.png 的梗）挺好笑'] }, meta('931', 'fr7.json'));
  ok(rF7.action === 'sent' && !hasImg(bF7), 'FR7 括号内引用（图名后跟空格续写）不转图');
  ok(textOf(bF7).includes('（独处.png 的梗）'), 'FR7b 引用形态字面保留', textOf(bF7).slice(-80));

  unlinkSync(join(STATE_ROOT, 'config.json')); // 还原默认
}

// OS 首段剥除（2026-11-26）：独白混进正文首段时剥段保留正文（11-22/11-26 两次实战形态）
{
  ok(stripOsHead('被 @ 了，得回。\n\n新图金发紫瞳，真不是灯。\n\n但不装懂。', 'g:1') === '新图金发紫瞳，真不是灯。\n\n但不装懂。', 'OS1a 被@独白首段剥除、正文保留');
  ok(stripOsHead('有人叫吾，回一下。\n\n正经回复内容', 'g:1') === '正经回复内容', 'OS1b 有人叫吾形态剥除');
  ok(stripOsHead('今天天气不错。\n\nsecond line', 'g:1') === '今天天气不错。\n\nsecond line', 'OS1c 非 OS 首段不剥');
  ok(stripOsHead('被 @ 了，得回。', 'g:1') === '被 @ 了，得回。', 'OS1d 单段纯 OS 不剥（宁放过，prompt 反例兜）');
  ok(stripOsHead('被 @ 了，得回。这话我记下了。', 'g:1') === '被 @ 了，得回。这话我记下了。', 'OS1e 超长首段不剥（>14 字非 OS）');
}

// perChat 复合键淘汰（审计专项债：`${chatKey}|<replyKey>` 原先只增不清，月级内存单调涨）
{
  const now = Date.now();
  const pc = new Map();
  pc.set('g:1|msg-old', { repliesToLastInbound: 1, ts: now - 40 * 60_000 }); // 超龄复合键
  pc.set('g:1|msg-new', { repliesToLastInbound: 1, ts: now - 60_000 });      // 窗口内复合键
  pc.set('g:1|msg-nots', { repliesToLastInbound: 1 });                        // 无 ts 的老复合键（按 0 清）
  pc.set('g:1', { repliesToLastInbound: 2, proactive: [] });                  // 本体键（不淘汰）
  const removed = sweepStalePerChat(pc, now);
  ok(removed === 2 && !pc.has('g:1|msg-old') && !pc.has('g:1|msg-nots'), 'SW1a 超龄/无 ts 复合键被淘汰', `removed=${removed} keys=${[...pc.keys()].join(',')}`);
  ok(pc.has('g:1|msg-new') && pc.has('g:1'), 'SW1b 窗口内复合键与本体键保留');
  const pc2 = new Map([['g:2|a', { repliesToLastInbound: 0, ts: now }], ['g:2', { proactive: [] }]]);
  ok(sweepStalePerChat(pc2, now) === 0, 'SW1c 无超龄时零删除');
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
