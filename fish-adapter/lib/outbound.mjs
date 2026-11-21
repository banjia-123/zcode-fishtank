// 出站链路（规格 §4.4 / 改造任务书 v6 阶段 1 · T2 出站结构化）：
// ① silent → ② 验签外层 → ③ [SILENT] → ④ 禁词 → ⑤ 出站审计（整段+逐行双扫，命中整条丢弃）
// → ⑥ 限额 → ⑦ 分段发送（部分成功即成功，不整条重发）
// 入参归一化（D7，永久保留）：老格式 {text} / 新格式 {lines,reply_to,sticker,voice,silent} / 纯字符串
// HTTP 回调（/zcode）与文件桥（outbox 轮询）共用 processMessage 核心。
import { auditAlert, log, ROOT_DIR } from './util.mjs';
import { isBusy } from './inbound.mjs';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { bridgeDirs } from './bridge.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 表情包（鱼发表情 v1）：三重防穿越校验（basename 化 / 扩展名白名单 / 存在性）——
// v6 起拆成纯校验函数：老格式走 text 里 [表情: 文件名] 标记，新格式走 sticker 字段，共用同一套校验
const EMOJI_EXTS = /\.(jpe?g|png|gif|webp)$/i;
const EMOJI_MARK = /\[表情[:：]\s*([^\]]{1,120}?)\s*\]/g;

// 表情文件名 → 库内绝对路径；不合法/不存在返回 null（降级纯文本）
function resolveEmojiFile(cfg, name) {
  const base = String(name ?? '').replace(/\\/g, '/').split('/').pop(); // basename 化：任何路径成分一律剥掉
  if (!base || !EMOJI_EXTS.test(base)) return null;
  const abs = join(bridgeDirs(cfg).base, 'emojis', base);
  try { if (statSync(abs).isFile()) return abs; } catch { /* 不存在 → 降级 */ }
  return null;
}

// 把 text 里的 [表情: xxx] 标记全部剥除（防字面外漏），返回清理后文本
function stripEmojiMarks(rawText, cfg, chatKey) {
  let text = rawText;
  const marks = [...text.matchAll(EMOJI_MARK)];
  for (const m of marks) {
    if (!resolveEmojiFile(cfg, m[1].trim())) {
      log('outbound', `emoji skipped: "${m[1].trim().slice(0, 60)}"（不在库内或扩展名不符，按纯文本发）`);
    }
    text = text.replace(m[0], '');
  }
  return text.trim();
}

// 发言记录（v3 §8.2 feedback 迭代基础）：鱼每次成功发言追加一行，供"像人/像AI"标注
// emojiPath：随行的表情绝对路径（记 basename）——控制台表情包页"使用次数/从未使用"的数据源（G2 起累积）
function recordSpeak(cfg, chatKey, text, source, emojiPath) {
  try {
    const dir = join(bridgeDirs(cfg).base, 'logs');
    appendFileSync(join(dir, 'speak.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), chat: chatKey, text: text.slice(0, 500), source,
      ...(emojiPath ? { emoji: basename(emojiPath) } : {}),
    }) + '\n', 'utf8');
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
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// —— D13 · 计数器落盘（state/counters.json）：重启不清零，限额才兜得住失控 ——
// 写入时机：每次成功发送后（原子写：临时文件 + rename）。损坏时保守处理：按已达上限，宁可不发也不超发
const STATE_DIR = join(ROOT_DIR, 'state');
const COUNTERS_FILE = join(STATE_DIR, 'counters.json');

// —— D7 · 入参归一化（永久保留，阶段 4 也不许删）——
// 老代码假设入参是字符串；格式一改，切回 bridge.mode=file 时模型输出的 JSON 会变成 text='' → 鱼彻底沉默。
// 这一个函数是新格式与老格式并存、回滚能成立的前提。
function normalize(raw) {
  if (typeof raw === 'string') return { text: raw };
  if (raw && Array.isArray(raw?.lines)) {
    return { lines: raw.lines, reply_to: raw?.reply_to, voice: raw?.voice, sticker: raw?.sticker, silent: raw?.silent === true || raw?.silent === 'true' };
  }
  if (raw && typeof raw?.text === 'string') return { text: raw.text };
  return { text: '' }; // 兜底：宁可发空走丢弃逻辑，也不抛
}

export function createOutbound(cfg, onebot, inboundState) {
  const perChat = new Map(); // chatKey -> { repliesToLastInbound, proactive: number[] }
  const rollWindow = new Map(); // chatKey -> ts[]，同群 5 分钟滚动窗口（防多轮触发叠加刷屏）
  const lastDeferLog = new Map(); // chatKey -> ts，defer 日志节流（轮询 1s 一次，不能每条都打）
  const windowMs = cfg.limits?.maxWindow5MinMs ?? 300_000;
  let dailyCount = 0;
  let daily = dayKey();

  // 启动读回计数器（D13）：跨天清零；损坏按已达上限（保守）
  let countersCorrupted = false;
  try {
    const o = JSON.parse(readFileSync(COUNTERS_FILE, 'utf8'));
    if (o.day === dayKey()) {
      dailyCount = o.dailyCount | 0;
      for (const [k, arr] of Object.entries(o.roll ?? {})) {
        const f = (Array.isArray(arr) ? arr : []).filter((t) => Date.now() - t < windowMs);
        if (f.length) rollWindow.set(k, f);
      }
      log('outbound', `counters restored: daily=${dailyCount} roll=${rollWindow.size}群`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      countersCorrupted = true;
      log('outbound', `WARN counters.json 损坏（${e.message}）——保守处理：今日按已达上限，宁可不发也不超发`);
      dailyCount = cfg.limits.maxDailyTotal;
    }
  }

  function saveCounters() {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      const roll = {};
      for (const [k, arr] of rollWindow) {
        const f = arr.filter((t) => Date.now() - t < windowMs);
        if (f.length) roll[k] = f;
      }
      const tmp = COUNTERS_FILE + '.tmp';
      writeFileSync(tmp, JSON.stringify({ day: dayKey(), dailyCount, roll }), 'utf8');
      renameSync(tmp, COUNTERS_FILE);
    } catch (e) {
      log('outbound', `counters save failed: ${e.message}`);
    }
  }

  // 核心：一条待发送内容的完整出站处理。meta = { chatType, chatId, userId, source, inboxFile? }
  // 返回 { action: 'sent'|'dropped'|'error'|'defer', reason?, truncated?, inboxFile? }
  async function processMessage(raw, meta) {
    const batch = normalize(raw);
    const isNew = Array.isArray(batch.lines);
    // D3：模型输出里的 inboxFile 一律忽略——删哪个信箱文件是适配器的责任，不能让鱼决定
    const inboxFile = typeof meta.inboxFile === 'string' ? meta.inboxFile : null;
    const chatType = meta.chatType === 'group' ? 'group' : 'private';
    const chatId = meta.chatId != null ? String(meta.chatId) : null;
    const userId = meta.userId != null ? String(meta.userId) : null;
    const source = meta.source ?? 'http';

    const drop = (reason, extra = '') => {
      log('outbound', `dropped (${reason}) ${extra} [${source}]`);
      return { action: 'dropped', reason };
    };

    // ⓪ silent 最高优先：模型明确说闭嘴就一个字都不发（有 lines 也忽略）
    if (batch.silent === true) return drop('silent');

    // ① 表情与文本提取
    // 老格式：text 里 [表情: xxx] 标记剥除（在 empty 检查前：纯表情无文字也合法）
    // 新格式：sticker 字段为表情通道（同三重校验）；行内的表情标记一律剥掉防字面外漏
    let joinedRaw;
    let textLines;
    let truncated = 0;
    if (isNew) {
      const wanted = batch.lines.filter((s) => typeof s === 'string' && s.trim()).map((s) => stripEmojiMarks(String(s).trim(), cfg)).filter(Boolean);
      if (wanted.length > 5) {
        truncated += wanted.length - 5;
        log('outbound', `WARN outbound lines-overflow n=${wanted.length} kept=5 [${source}]`);
      }
      const kept = wanted.slice(0, 5).map((s) => {
        if (s.length > 60) { truncated += 1; return s.slice(0, 60); } // 单条超 60 字截断，计入 truncated
        return s;
      });
      textLines = kept;
      joinedRaw = kept.join('\n');
    } else {
      joinedRaw = String(batch.text ?? '');
    }
    const emoji0 = isNew
      ? { text: joinedRaw, emojiPath: batch.sticker != null ? resolveEmojiFile(cfg, batch.sticker) : null }
      : (() => {
          const stripped = stripEmojiMarks(joinedRaw, cfg);
          let emojiPath = null;
          for (const m of [...joinedRaw.matchAll(EMOJI_MARK)]) {
            const p = resolveEmojiFile(cfg, m[1].trim());
            if (p && !emojiPath) emojiPath = p;
          }
          return { text: stripped, emojiPath };
        })();
    const text = emoji0.text;
    const emojiPath = emoji0.emojiPath;
    // 新格式 sticker 校验失败的降级日志（字段非法/文件不在库内 → 纯文本发）
    if (isNew && batch.sticker != null && !emojiPath) {
      log('outbound', `WARN outbound sticker 非法已忽略: ${String(batch.sticker).slice(0, 40)} [${source}]`);
    }

    if (!text.trim() && !emojiPath) return drop('empty');
    if (chatType === 'group' && !chatId) return drop('missing-chat-id', '(出站报文没有 chatId，核对报文字段)');
    if (chatType === 'private' && !userId) return drop('missing-user-id');

    const chatKey = chatType === 'group' ? `g:${chatId}` : `p:${userId}`;

    // ② [SILENT] 过滤（对整段——模型可能两种格式都写）
    if (SILENT_PREFIX.test(text)) return drop('silent');

    // ③ 禁词（默认空表；config.bannedWords 配置，命中丢弃 + 审计）
    const banned = Array.isArray(cfg.bannedWords) ? cfg.bannedWords : [];
    const hitWord = banned.find((w) => w && text.includes(w));
    if (hitWord) {
      auditAlert('banned-word', hitWord.slice(0, 40), text, chatKey);
      return drop('banned-word');
    }

    // ④ 出站审计（D1 双扫+无缝拼接，顺序不可换）：先整段，再无缝拼接（抓跨行拆密钥：
    //    lines:["sk-","abc…"] 拼起来才是完整密钥，带换行的整段抓不到），最后逐行。
    //    带 g 标志的正则必须用 match（不受 lastIndex 残留影响）。任一形态命中 → 整条不发。
    const joined = text;
    const auditTargets = [joined, joined.replace(/\n/g, ''), ...text.split(/\r?\n/).filter(Boolean)];
    for (const s of auditTargets) {
      for (const rule of BLOCK_RULES) {
        const m = s.match(rule.re);
        if (m) {
          auditAlert('leak', rule.name, s, chatKey);
          return drop('audit-' + rule.name);
        }
      }
    }
    if (cfg.audit?.blockPrivateIP && PRIVATE_IP_RE.test(joined)) {
      auditAlert('leak', 'private-ip', joined, chatKey);
      return drop('audit-private-ip');
    }

    // ⑤ 限额（D13：计数器已落盘，重启不清零）：daily 兜底 / 单条消息回复数 / 每群主动消息频率 / 滚动窗口
    if (daily !== dayKey()) { daily = dayKey(); dailyCount = 0; saveCounters(); }
    if (dailyCount >= cfg.limits.maxDailyTotal) return drop('limit-daily', `count=${dailyCount}`);

    const st = perChat.get(chatKey) ?? { repliesToLastInbound: 0, proactive: [] };
    const inbound = inboundState.get(chatKey);
    // 回复归属：文件桥出站带 inboxFile → 按入站文件计数（每条消息回复数天然 1:1）；
    // 无 inboxFile（webhook 模式/主动消息）→ 退回时间窗近似（入站 2 分钟内算回复）
    const replyKey = inboxFile;
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

    // 滚动窗口（第四类）：同群 5 分钟出站总量封顶。超限返回 defer：不丢（必回的也要发），错峰延后
    const windowMin = windowMs / 60_000;
    const maxPerWindow = cfg.limits?.maxRepliesPerGroupPer5Min;
    const rl = (rollWindow.get(chatKey) ?? []).filter((t) => Date.now() - t < windowMs);
    rollWindow.set(chatKey, rl);
    if (chatType === 'group' && maxPerWindow != null && rl.length >= maxPerWindow) {
      const last = lastDeferLog.get(chatKey) ?? 0;
      if (Date.now() - last > 30_000) {
        log('outbound', `defer (limit-window-${windowMin}min) chat=${chatKey} queued=${rl.length}（错峰延后，不丢）`);
        lastDeferLog.set(chatKey, Date.now());
      }
      return { action: 'defer', reason: 'limit-window' };
    }

    // ⑥ 发送（经 NapCat HTTP）。
    // 行来源解耦（D2）：新格式以 lines 为准（5 条硬上限，不受 maxTotalChars/maxSegments 约束）；
    // 老格式维持原逻辑（maxSegments 分段 + maxTotalChars 总字数闸门，宁说一半不刷屏）
    let segments;
    if (isNew) {
      segments = textLines;
      if (!segments.length && emojiPath) segments = [];
    } else {
      const maxSegs = isBusy(chatKey, cfg)
        ? (cfg.limits?.busyMaxSegments ?? 2)
        : (cfg.limits?.maxSegments ?? 4);
      const raw = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, maxSegs);
      // 总字数闸门：累计超限截断（至少保留 1 段），宁说一半不刷屏
      const maxChars = cfg.limits?.maxTotalChars ?? 150;
      let acc = 0;
      segments = [];
      for (const l of raw) {
        segments.push(l);
        acc += l.length;
        if (acc >= maxChars) break;
      }
      if (segments.length && segments[segments.length - 1] !== raw[raw.length - 1]) {
        log('outbound', `truncated → ${chatKey}（${raw.length} 段 ${text.length} 字超 maxTotalChars=${maxChars}，保留 ${segments.length} 段）`);
        truncated += raw.length - segments.length;
      }
      if (!segments.length && text.trim()) segments = [text.trim().slice(0, maxChars)];
    }
    const emojiSeg = emojiPath ? { type: 'image', data: { file: 'file:///' + emojiPath.replace(/\\/g, '/') } } : null;
    // 引用目标（S1.2）：新格式 reply_to 优先（D15 校验：纯数字 15~20 位，非法则 WARN 忽略），回落文件名正则（老行为）
    let replyToId = null;
    const replyCandidate = isNew && batch.reply_to != null ? String(batch.reply_to) : String(meta.replyToMessageId ?? '');
    if (isNew && batch.reply_to != null && !/^\d{15,20}$/.test(replyCandidate)) {
      log('outbound', `WARN outbound reply_to 非法已忽略: ${replyCandidate.slice(0, 20)} [${source}]`);
      replyToId = /^\d+$/.test(String(meta.replyToMessageId ?? '')) ? Number(meta.replyToMessageId) : null;
    } else {
      replyToId = /^\d+$/.test(replyCandidate) ? Number(replyCandidate) : null;
    }
    if (isNew && batch.voice != null) {
      // voice：本阶段只占位（只接受纯数字语音 id，其余 WARN 忽略——文本请走 lines）
      if (!/^\d{1,20}$/.test(String(batch.voice))) log('outbound', `WARN outbound voice 非法已忽略: ${String(batch.voice).slice(0, 20)} [${source}]`);
      else log('outbound', `voice ignored (not implemented) [${source}]`);
    }

    // 干跑（控制台测试发送预检）：⓪-⑤ 四道闸 + ⑥ 分段全部走完后原路返回——
    // 不发送、不扣任何额度（计数器变更全在真发成功之后，⓪-⑤ 只读），预检结论与真发一致
    if (meta.dryRun === true) {
      log('outbound', `dry-run → ${chatKey} segments=${segments.length || (emojiSeg ? 1 : 0)}${emojiPath ? ' +emoji' : ''} [${source}]`);
      return {
        action: 'dry-run',
        segments: segments.length || (emojiSeg ? 1 : 0),
        emoji: emojiPath ? true : null,
        replyTo: replyToId,
        truncated,
      };
    }

    try {
      // 纯表情（无文字）：只发一条 image 消息；否则文字段逐条发，首段挂引用、末段拼表情（图文同条）
      let r = null;
      let sent = 0;
      let lastErr = null;
      if (!segments.length && emojiSeg) {
        const message = [emojiSeg];
        if (replyToId != null) message.unshift({ type: 'reply', data: { id: replyToId } });
        r = chatType === 'group'
          ? await onebot.action('send_group_msg', { group_id: /^\d+$/.test(chatId) ? Number(chatId) : chatId, message })
          : await onebot.action('send_private_msg', { user_id: /^\d+$/.test(userId) ? Number(userId) : userId, message });
        if (r && r.status === 'ok') sent = 1; else lastErr = r;
      } else {
        for (let i = 0; i < segments.length; i++) {
          // 拟人打字节奏：段间 1.5~4 秒随机延迟——同样的内容，六连发是刷屏，隔几秒蹦一句是聊天
          if (i > 0) await sleep(1500 + Math.random() * 2500);
          const message = [{ type: 'text', data: { text: segments[i] } }];
          if (i === segments.length - 1 && emojiSeg) message.push(emojiSeg);
          if (i === 0 && replyToId != null) message.unshift({ type: 'reply', data: { id: replyToId } }); // 引用只挂首条
          if (chatType === 'group') {
            const gid = /^\d+$/.test(chatId) ? Number(chatId) : chatId;
            r = await onebot.action('send_group_msg', { group_id: gid, message });
          } else {
            const uid = /^\d+$/.test(userId) ? Number(userId) : userId;
            r = await onebot.action('send_private_msg', { user_id: uid, message });
          }
          if (!r || r.status !== 'ok') { lastErr = r; break; }
          sent += 1;
        }
      }
      // D4b · 部分成功即成功：发出去至少一段就不重试（宁可少发一段，不为补一句把整段刷两遍）。
      // 一段都没发出去才算 error——此时重试是安全的（没有重复）。
      if (sent > 0) {
        dailyCount += 1;
        if (chatType === 'group') { rl.push(Date.now()); rollWindow.set(chatKey, rl); }
        saveCounters();
        const partial = sent < (segments.length || 1) ? `${sent}/${segments.length || 1}` : null;
        if (partial) log('outbound', `WARN outbound partial ${partial} chat=${chatKey} err=${JSON.stringify(lastErr).slice(0, 120)} [${source}]`);
        recordSpeak(cfg, chatKey, text, source, emojiPath);
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
        log('outbound', `sent → ${chatKey} (${isReply ? 'reply' : 'proactive'} daily=${dailyCount} lines=${sent}${partial ? ` partial=${partial}` : ''}${truncated ? ` truncated=${truncated}` : ''}${emojiPath ? ' +emoji' : ''}) [${source}]`);
        return { action: 'sent', truncated, inboxFile };
      }
      log('outbound', `onebot send failed: ${JSON.stringify(lastErr).slice(0, 200)} [${source}]`);
      return { action: 'error', reason: 'onebot-send-failed', inboxFile };
    } catch (e) {
      log('outbound', `send error (${chatKey}): ${e.message} [${source}]`);
      return { action: 'error', reason: 'send-error', inboxFile };
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

    const payload = typeof body.text === 'string' || Array.isArray(body.lines)
      ? body
      : (typeof body.message === 'string' ? { text: body.message } : { text: '' });
    const meta = {
      chatType: body.chatType,
      chatId: body.chatId != null ? String(body.chatId) : (body.group_id != null ? String(body.group_id) : (body.groupId != null ? String(body.groupId) : null)),
      userId: body.userId != null ? String(body.userId) : (body.user_id != null ? String(body.user_id) : null),
      source: 'http',
    };
    const result = await processMessage(payload, meta);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.action === 'sent' ? { ok: true, action: 'sent' } : { ok: true, action: result.action, reason: result.reason }));
  }

  // 控制台 /stats 用（只读快照，无副作用）：今日已说条数 / 上限 / 各群滚动窗口余量
  function stats() {
    const roll = {};
    for (const [k, arr] of rollWindow) {
      const f = arr.filter((t) => Date.now() - t < windowMs);
      if (f.length) roll[k] = f.length;
    }
    return { dailyCount, maxDailyTotal: cfg.limits.maxDailyTotal, roll };
  }

  return { handle, processMessage, stats };
}
