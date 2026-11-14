// 出站链路（规格 §4.4）：
// ① 验签 → ② [SILENT] → ③ 禁词 → ④ 出站审计（整条丢弃）→ ⑤ 限额 → ⑥ 发送
// HTTP 回调（/zcode）与文件桥（outbox 轮询）共用 processMessage 核心。
import { auditAlert, log } from './util.mjs';
import { isBusy } from './inbound.mjs';
import { appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { bridgeDirs } from './bridge.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 表情包（鱼发表情 v1）：text 里 [表情: 文件名] → 剥除标记，发送时拼 image 段（图文同条）——
// 库 = fishpond/emojis/（人工策展，放入即可用），索引 = emojis/index.json（learner/人维护描述）
// 三重防穿越：basename 化 / 扩展名白名单 / 存在性校验；一条消息最多 1 个表情
const EMOJI_EXTS = /\.(jpe?g|png|gif|webp)$/i;
const EMOJI_MARK = /\[表情[:：]\s*([^\]]{1,120}?)\s*\]/g;

function extractEmoji(cfg, rawText) {
  let text = rawText;
  let emojiPath = null;
  const marks = [...text.matchAll(EMOJI_MARK)];
  for (const m of marks) {
    const name = m[1].trim();
    const base = name.replace(/\\/g, '/').split('/').pop(); // basename 化：任何路径成分一律剥掉
    let ok = null;
    if (base && EMOJI_EXTS.test(base)) {
      const abs = join(bridgeDirs(cfg).base, 'emojis', base);
      try { if (statSync(abs).isFile()) ok = abs; } catch { /* 不存在 → 降级 */ }
    }
    if (ok && !emojiPath) emojiPath = ok; // 只取第一个有效的表情
    else if (!ok) log('outbound', `emoji skipped: "${name.slice(0, 60)}"（不在库内或扩展名不符，按纯文本发）`);
    text = text.replace(m[0], ''); // 所有标记一律从 text 清除（防字面外漏）
  }
  return { text: text.trim(), emojiPath };
}

// 发言记录（v3 §8.2 feedback 迭代基础）：鱼每次成功发言追加一行，供"像人/像AI"标注
function recordSpeak(cfg, chatKey, text, source) {
  try {
    const dir = join(bridgeDirs(cfg).base, 'logs');
    appendFileSync(join(dir, 'speak.jsonl'), JSON.stringify({ ts: new Date().toISOString(), chat: chatKey, text: text.slice(0, 500), source }) + '\n', 'utf8');
  } catch { /* 记录失败不阻断发送 */ }
}

// 模型说沉默就沉默——适配器层硬拦，不依赖提示词（提示词说"不想回就输出 [SILENT]"，模型可能忘）
// 词后必须非字母：防 "password=..."、"passing" 这类正常文本被误判为 pass（冒烟测试实测抓到）
const SILENT_PREFIX = /^\s*\[?(SILENT|沉默|不说话|pass)\]?(?![a-zA-Z])/i;

// 出站审计：命中即整条丢弃，不脱敏（脱敏可能漏，漏一次就是不可逆的泄露）
const BLOCK_RULES = [
  { name: 'win-path', re: /[A-Z]:\\[^\s"'<>|]{3,}/g },
  { name: 'unc-path', re: /\\\\[\w.-]+\\[\w$.-]+/g },
  { name: 'credential', re: /(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S{8,}/gi },
  { name: 'api-key', re: /\bsk-[A-Za-z0-9]{16,}\b/g },
];
// 内网 IP 默认关闭（误伤率高：群里聊"192.168.1.1 连不上"很常见）。要开就 config.audit.blockPrivateIP: true
const PRIVATE_IP_RE = /\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/;

function dayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function createOutbound(cfg, onebot, inboundState) {
  const perChat = new Map(); // chatKey -> { repliesToLastInbound, proactive: number[] }
  const rollWindow = new Map(); // chatKey -> ts[]，同群 5 分钟滚动窗口（防多轮触发叠加刷屏）
  const lastDeferLog = new Map(); // chatKey -> ts，defer 日志节流（轮询 1s 一次，不能每条都打）
  let dailyCount = 0;
  let daily = dayKey();

  // 核心：一条待发送文本的完整出站处理。meta = { chatType, chatId, userId, source }
  // 返回 { action: 'sent'|'dropped'|'error', reason? }
  async function processMessage(rawText, meta) {
    // 表情标记先剥（在 empty 检查前：纯表情无文字也合法）
    const emoji0 = typeof rawText === 'string' ? extractEmoji(cfg, rawText) : { text: '', emojiPath: null };
    const text = emoji0.text;
    const emojiPath = emoji0.emojiPath;
    const chatType = meta.chatType === 'group' ? 'group' : 'private';
    const chatId = meta.chatId != null ? String(meta.chatId) : null;
    const userId = meta.userId != null ? String(meta.userId) : null;
    const source = meta.source ?? 'http';

    const drop = (reason, extra = '') => {
      log('outbound', `dropped (${reason}) ${extra} [${source}]`);
      return { action: 'dropped', reason };
    };

    if (!text.trim() && !emojiPath) return drop('empty');
    if (chatType === 'group' && !chatId) return drop('missing-chat-id', '(出站报文没有 chatId，核对报文字段)');
    if (chatType === 'private' && !userId) return drop('missing-user-id');

    const chatKey = chatType === 'group' ? `g:${chatId}` : `p:${userId}`;

    // ② [SILENT] 过滤
    if (SILENT_PREFIX.test(text)) return drop('silent');

    // ③ 禁词（默认空表；config.bannedWords 配置，命中丢弃 + 审计）
    const banned = Array.isArray(cfg.bannedWords) ? cfg.bannedWords : [];
    const hitWord = banned.find((w) => w && text.includes(w));
    if (hitWord) {
      auditAlert('banned-word', `hit "${hitWord}" chat=${chatKey} text=${JSON.stringify(text.slice(0, 200))}`);
      return drop('banned-word');
    }

    // ④ 出站审计：命中即整条丢弃
    for (const rule of BLOCK_RULES) {
      const m = text.match(rule.re);
      if (m) {
        auditAlert('leak', `${rule.name}: ${m[0].slice(0, 80)} chat=${chatKey} text=${JSON.stringify(text.slice(0, 200))}`);
        return drop('audit-' + rule.name);
      }
    }
    if (cfg.audit?.blockPrivateIP && PRIVATE_IP_RE.test(text)) {
      auditAlert('leak', `private-ip chat=${chatKey} text=${JSON.stringify(text.slice(0, 200))}`);
      return drop('audit-private-ip');
    }

    // ⑤ 限额：daily 兜底 / 单条消息回复数 / 每群主动消息频率 / 同群 5 分钟滚动窗口
    if (daily !== dayKey()) { daily = dayKey(); dailyCount = 0; }
    if (dailyCount >= cfg.limits.maxDailyTotal) return drop('limit-daily', `count=${dailyCount}`);

    const st = perChat.get(chatKey) ?? { repliesToLastInbound: 0, proactive: [] };
    const inbound = inboundState.get(chatKey);
    // 回复归属：文件桥出站带 inboxFile → 按入站文件计数（每条消息回复数天然 1:1）；
    // 无 inboxFile（webhook 模式/主动消息）→ 退回时间窗近似（入站 2 分钟内算回复）
    const replyKey = meta.inboxFile ?? null;
    const isReply = replyKey != null || Boolean(inbound && Date.now() - inbound.lastInboundAt < 120_000);
    const countKey = replyKey != null ? `${chatKey}|${replyKey}` : chatKey;
    if (isReply) {
      const used = replyKey != null ? 0 : st.repliesToLastInbound;
      const cnt = (perChat.get(countKey)?.repliesToLastInbound ?? used);
      if (cnt >= cfg.limits.maxRepliesPerMessage) {
        return drop('limit-replies-per-message', `key=${countKey} count=${cnt}`);
      }
    } else {
      const now = Date.now();
      st.proactive = st.proactive.filter((t) => now - t < 60_000);
      if (st.proactive.length >= cfg.limits.maxProactivePerGroupPerMinute) {
        return drop('limit-proactive', `chat=${chatKey}`);
      }
    }

    // 滚动窗口（第四类）：同群 5 分钟出站总量封顶。多轮触发各自都在限额内，
    // 叠加起来照样刷屏——这里统一兜住。超限返回 defer：不丢（必回的也要发），错峰延后
    const windowMin = (cfg.limits?.maxWindow5MinMs ?? 300_000) / 60_000;
    const maxPerWindow = cfg.limits?.maxRepliesPerGroupPer5Min;
    const rl = (rollWindow.get(chatKey) ?? []).filter((t) => Date.now() - t < (cfg.limits?.maxWindow5MinMs ?? 300_000));
    rollWindow.set(chatKey, rl);
    if (chatType === 'group' && maxPerWindow != null && rl.length >= maxPerWindow) {
      const last = lastDeferLog.get(chatKey) ?? 0;
      if (Date.now() - last > 30_000) {
        log('outbound', `defer (limit-window-${windowMin}min) chat=${chatKey} queued=${rl.length}（错峰延后，不丢）`);
        lastDeferLog.set(chatKey, Date.now());
      }
      return { action: 'defer', reason: 'limit-window' };
    }

    // ⑥ 发送（经 NapCat HTTP）。QQ 分条发送（SOUL 硬性要求）：按行拆分逐条发，
    //    整体文本已过审计/限额，拆分只是呈现方式（计数仍按一条回复）
    try {
      // 段数动态收缩（防刷屏）：热闹（P1 窗口）时最多 2 段，平时 4 段——热闹场合没人想看长文
      const maxSegs = isBusy(chatKey, cfg)
        ? (cfg.limits?.busyMaxSegments ?? 2)
        : (cfg.limits?.maxSegments ?? 4);
      let lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, maxSegs);
      // 总字数闸门：累计超限截断（至少保留 1 段），宁说一半不刷屏
      const maxChars = cfg.limits?.maxTotalChars ?? 150;
      let acc = 0;
      const kept = [];
      for (const l of lines) {
        kept.push(l);
        acc += l.length;
        if (acc >= maxChars) break;
      }
      if (kept.length && kept[kept.length - 1] !== lines[lines.length - 1]) {
        log('outbound', `truncated → ${chatKey}（${lines.length} 段 ${text.length} 字超 maxTotalChars=${maxChars}，保留 ${kept.length} 段）`);
      }
      // 纯表情（无文字）：只发一条 image 消息；否则文字段逐条发，最后一段拼表情段（图文同条）
      const segments = kept.length > 0 ? kept : (emojiPath ? [] : [text.trim().slice(0, maxChars)]);
      const emojiSeg = emojiPath ? { type: 'image', data: { file: 'file:///' + emojiPath.replace(/\\/g, '/') } } : null;
      let r = null;
      if (!segments.length && emojiSeg) {
        const message = [emojiSeg];
        r = chatType === 'group'
          ? await onebot.action('send_group_msg', { group_id: /^\d+$/.test(chatId) ? Number(chatId) : chatId, message })
          : await onebot.action('send_private_msg', { user_id: /^\d+$/.test(userId) ? Number(userId) : userId, message });
      } else {
        for (let i = 0; i < segments.length; i++) {
          // 拟人打字节奏：段间 1.5~4 秒随机延迟——同样的内容，六连发是刷屏，隔几秒蹦一句是聊天
          if (i > 0) await sleep(1500 + Math.random() * 2500);
          const message = [{ type: 'text', data: { text: segments[i] } }];
          if (i === segments.length - 1 && emojiSeg) message.push(emojiSeg);
          if (chatType === 'group') {
            const gid = /^\d+$/.test(chatId) ? Number(chatId) : chatId;
            r = await onebot.action('send_group_msg', { group_id: gid, message });
          } else {
            const uid = /^\d+$/.test(userId) ? Number(userId) : userId;
            r = await onebot.action('send_private_msg', { user_id: uid, message });
          }
          if (!r || r.status !== 'ok') break;
        }
      }
      if (r && r.status === 'ok') {
        dailyCount += 1;
        if (chatType === 'group') { rl.push(Date.now()); rollWindow.set(chatKey, rl); }
        recordSpeak(cfg, chatKey, text, source);
        if (replyKey != null) {
          const ck = perChat.get(countKey) ?? { repliesToLastInbound: 0, proactive: [] };
          ck.repliesToLastInbound += 1;
          perChat.set(countKey, ck);
        } else if (isReply) {
          st.repliesToLastInbound += 1;
          perChat.set(chatKey, st);
        } else {
          st.proactive.push(Date.now());
          perChat.set(chatKey, st);
        }
        log('outbound', `sent → ${chatKey} (${isReply ? 'reply' : 'proactive'} daily=${dailyCount}${emojiPath ? ' +emoji' : ''}) [${source}]`);
        return { action: 'sent' };
      }
      log('outbound', `onebot send failed: ${JSON.stringify(r).slice(0, 200)} [${source}]`);
      return { action: 'error', reason: 'onebot-send-failed' };
    } catch (e) {
      log('outbound', `send error (${chatKey}): ${e.message} [${source}]`);
      return { action: 'error', reason: 'send-error' };
    }
  }

  // HTTP 回调入口（ZCode webhook 出站模式用；文件桥模式不走这里）
  async function handle(req, res, body) {
    // ① 验签：x-zcode-bot-secret 必须与配置一致；secret 为空 = 显式禁用（本机回环临时模式）
    const configuredSecret = String(cfg.zcode.secret ?? '');
    if (configuredSecret) {
      const got = String(req.headers['x-zcode-bot-secret'] ?? '');
      if (got !== configuredSecret) {
        log('outbound', `rejected: bad/missing x-zcode-bot-secret (ip=${req.socket?.remoteAddress})`);
        res.writeHead(403).end('forbidden');
        return;
      }
    }

    const text = typeof body.text === 'string' ? body.text : (typeof body.message === 'string' ? body.message : '');
    const meta = {
      chatType: body.chatType,
      chatId: body.chatId != null ? String(body.chatId) : (body.group_id != null ? String(body.group_id) : (body.groupId != null ? String(body.groupId) : null)),
      userId: body.userId != null ? String(body.userId) : (body.user_id != null ? String(body.user_id) : null),
      source: 'http',
    };
    const result = await processMessage(text, meta);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.action === 'sent' ? { ok: true, action: 'sent' } : { ok: true, action: result.action, reason: result.reason }));
  }

  return { handle, processMessage };
}
