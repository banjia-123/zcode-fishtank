// 出站链路（规格 §4.4 / 改造任务书 v6 阶段 1 · T2 出站结构化）：
// ① silent → ② 验签外层 → ③ [SILENT] → ④ 禁词 → ⑤ 出站审计（整段+逐行双扫，命中整条丢弃）
// → ⑥ 限额 → ⑦ 分段发送（部分成功即成功，不整条重发）
// 入参归一化（D7，永久保留）：老格式 {text} / 新格式 {lines,reply_to,sticker,voice,silent} / 纯字符串
// HTTP 回调（/zcode）与文件桥（outbox 轮询）共用 processMessage 核心。
import { auditAlert, hotJson, log, ROOT_DIR } from './util.mjs';
import { isBusy } from './inbound.mjs';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { bridgeDirs } from './bridge.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

// —— 表情包（鱼发表情 v1）：三重防穿越校验（basename 化 / 扩展名白名单 / 存在性）——
// v6 起拆成纯校验函数：老格式走 text 里 [表情: 文件名] 标记，新格式走 sticker 字段，共用同一套校验
const EMOJI_EXTS = /\.(jpe?g|png|gif|webp)$/i;
const EMOJI_MARK = /\[表情[:：]\s*([^\]]{1,120}?)\s*\]/g;
// 简写标记 [欸嘿嘿.jpg]（2026-11-22 模型格式漂移实测：教的是 [表情: xxx]，她偷懒省前缀——
// 字面文本漏出站两次后补的宽容解析）。库里存在才解析，不存在保留字面（不误伤真想发 [xx.jpg] 文字的场景）
const EMOJI_SHORT = /\[([^\[\]]{1,40}\.(?:jpe?g|png|gif|webp))\]/gi;
// 全角括号（叼猎物.png）（2026-11-28 第三次漂移实测：群内全角括号文化（）强势，她连发三条把图名写进
// 全角括号当"发图"，字面漏出站——选图没错（索引描述与语境吻合），发送形态错）。处置对齐简写漂移：
// 库里存在才转图，不存在保留字面；半角圆括号不收（英文正文括号注释常见，误伤面大）
// 2026-11-28 二轮实战：主修复生效（完整形态转图+冷却首拦）后漂移变异出半开形态（欸嘿嘿.jpg——漏闭
// 括号，两条字面漏出站）。正则放宽为"开括号+图名"即可，前瞻要求图名后紧跟闭括号/空白/行尾/中文标点
// （防"（xx.jpg 的梗）"这类括号内引用被误转——图名后紧跟非空白才保留）；剥除时完整括号优先，半开退而剥
const EMOJI_SHORT_FULL = /（([^（）]{1,40}\.(?:jpe?g|png|gif|webp))(?=）|[\n\r]|$|[，。！？；、])/g;

// 表情文件名 → 库内绝对路径；不合法/不存在返回 null（降级纯文本）
function resolveEmojiFile(cfg, name) {
  const base = String(name ?? '').replace(/\\/g, '/').split('/').pop(); // basename 化：任何路径成分一律剥掉
  if (!base || !EMOJI_EXTS.test(base)) return null;
  const abs = join(bridgeDirs(cfg).base, 'emojis', base);
  try { if (statSync(abs).isFile()) return abs; } catch { /* 不存在 → 降级 */ }
  return null;
}

// 把 text 里的表情标记全部剥除（防字面外漏），返回清理后文本。
// [表情: xxx] 教过的规范格式：一律剥除（不在库内也剥，只留日志）；
// [xxx.ext] 简写漂移：库里存在才剥（会作为表情发送），不存在保留字面。
function stripEmojiMarks(rawText, cfg, chatKey) {
  let text = rawText;
  const marks = [...text.matchAll(EMOJI_MARK)];
  for (const m of marks) {
    if (!resolveEmojiFile(cfg, m[1].trim())) {
      log('outbound', `emoji skipped: "${m[1].trim().slice(0, 60)}"（不在库内或扩展名不符，按纯文本发）`);
    }
    text = text.replace(m[0], '');
  }
  for (const m of [...text.matchAll(EMOJI_SHORT)]) {
    if (resolveEmojiFile(cfg, m[1])) {
      log('outbound', `emoji shorthand accepted: "${m[1].slice(0, 60)}"（简写漂移，按表情发）`);
      text = text.replace(m[0], '');
    }
  }
  for (const m of [...text.matchAll(EMOJI_SHORT_FULL)]) {
    if (resolveEmojiFile(cfg, m[1])) {
      log('outbound', `emoji fullwidth-paren accepted: "${m[1].slice(0, 60)}"（全角括号漂移，按表情发）`);
      text = text.replace(m[0] + '）', '').replace(m[0], ''); // 完整括号优先剥；半开形态只剥开括号段
    }
  }
  return text.trim();
}

// —— 表情硬闸（G9b，2026-11-21）：emojiGate.enabled 且该 chatKey 最近 window 条发言已有 ≥ max 条
// 带表情 → 本次表情降级纯文本。prompt 软引导（踩坑 31 / 措辞 v1-v3）对 Flash/low 档无效的工程兜底。
// 开关/阈值现读 config（mtime 缓存）——控制台切开关即时生效，无需重启适配器。
const EMOJI_GATE_DEFAULT = { enabled: true, window: 5, max: 2, cooldownSec: 600 };
// EMOJI_GATE_FILE（2026-11-23 修复）：此前按 import.meta.url 推导，指向不存在的 lib/config.json，
// 硬闸永远走默认值——控制台开关从未生效过。配置在包根 config.json（= ROOT_DIR）；测试隔离下 ROOT_DIR
// 指向临时目录、读不到即走默认，行为不变。
const EMOJI_GATE_FILE = join(ROOT_DIR, 'config.json');
function emojiGateState() {
  try {
    const g = hotJson(EMOJI_GATE_FILE, (d) => d.emojiGate ?? {}) ?? {};
    const cd = Math.floor(Number(g.cooldownSec));
    return {
      enabled: g.enabled !== false,
      window: Math.max(2, Number(g.window) || 5),
      max: Math.max(1, Number(g.max) || 2),
      // 同图冷却秒数（P2）：显式 0 = 关闭；非法回退默认 600
      cooldownSec: Number.isFinite(cd) && cd >= 0 ? cd : EMOJI_GATE_DEFAULT.cooldownSec,
    };
  } catch (e) { log('outbound', `WARN emojiGate 读 config 失败，回退默认 ${JSON.stringify(EMOJI_GATE_DEFAULT)}: ${e.message}`); return { ...EMOJI_GATE_DEFAULT }; }
}
// —— 拟真打字节奏（2026-11-25，借鉴 dsh-sansan-qq 的 typingDelayMs）——
// 段间延迟按上一行字数 × 打字速度算：长句等得久、短句快，外加构思抖动与 12% 概率手快。
// 下限 1500ms 与旧算法下限一致（防洪节奏不变，测试 2b/T1b 断言零修改兼容）；
// 上限 8000ms 防长行极端（60 字截断已物理限长）。
// typingSecPerChar 现读 config（mtime 缓存，同 emojiGateState 模式）：≤0 或显式 0 = 回退旧随机节奏。
const TYPING_FILE = EMOJI_GATE_FILE; // 同源：包根 config.json（与 emojiGate 共享 hotJson 的同文件缓存）
function typingSecPerChar() {
  try {
    const n = Number(hotJson(TYPING_FILE, (d) => d.limits?.typingSecPerChar));
    return n > 0 ? n : (n === 0 ? 0 : 0.15);
  } catch (e) { log('outbound', `WARN typingSecPerChar 读 config 失败，回退 0.15: ${e.message}`); return 0.15; }
}
// 纯函数可单测：secPerChar 无效（≤0/NaN）走旧分支 1500~4000ms
export function typingDelayMs(prevText, secPerChar) {
  if (!(Number(secPerChar) > 0)) return 1500 + Math.random() * 2500;
  const chars = Array.from(String(prevText ?? '')).length; // 码点数（emoji 代理对按 1）
  let sec = rand(0.8, 2.2) + chars * secPerChar * rand(0.8, 1.2); // 构思 + 按字打
  sec *= rand(0.85, 1.15); // 总抖动
  if (Math.random() < 0.12) sec *= 0.5; // 偶尔手快
  return Math.min(8000, Math.max(1500, Math.round(sec * 1000)));
}

// —— 引用概率化（2026-11-28，借鉴 MaiBot scenes/group/quoting.py 的离线拟合思路，砍成规则+低概率）——
// 此前巡逻回复每条首段必挂引用——真人不这样：QQ 的 @ 通知天然指向，被 @ 回复没人引用；
// 单人闲聊回复最近一条直接说；只有多人同时说话（要指定回复谁）和隔久了的慢回复才需要引用指方向。
// 纯函数可单测，rand 注入（测试固定行为）。
export function shouldQuoteDecision({ must, batchLen, ageSec }, rand = Math.random) {
  if (must) return false; // 被 @/叫名：@ 通知已指向，引用冗余
  if (batchLen >= 3) return true; // 多人讨论：不引用不知道在回谁
  if (ageSec >= 90) return true; // 慢回复（错峰/熔断延迟）：隔久了要指向
  return rand() < 0.2; // 单人闲聊偶尔引用——真人会引用好笑的那条
}

// —— OS 首段剥除（2026-11-26）：模型的"内心 OS"（被 @ 了、有人叫吾、得回）偶尔混进正文首段——
// 群友看到的是她的决策过程而非回复（11-22/11-26 两次实战）。特征：首段极短且是"叙述自己收到消息"
// 的元语句。剥掉该段保留后续正常正文（比整条丢弃好——本次 89 字好内容差点陪葬）；无后续段则整条照发
// （纯 OS 也可能是真想说的短话，宁放过不误杀，靠 prompt 反例兜）。
const OS_HEAD_RE = /^(?:被\s*@\s*了?|有人?[在要]?[叫喊@]吾|得回[一-]?|该吾回)/;
export function stripOsHead(text, chatKey) {
  const segs = String(text ?? '').split(/\r?\n/);
  if (segs.length <= 1) return text; // 单段不剥（可能是真短话）
  const head = segs[0].trim();
  if (head.length <= 14 && OS_HEAD_RE.test(head)) {
    log('outbound', `os-head stripped → ${chatKey}: "${head.slice(0, 20)}"`);
    return segs.slice(1).join('\n').trim();
  }
  return text;
}

// speak.jsonl 尾部读取（P2-2b，2026-11-28）：文件长期只增不删（控制台表情统计页的数据源，
// 不能清），冷却/条数闸每次发表情都全文件 scan+parse 会随时间线性变慢——只扫尾部 256KB
//（≈4000 行，两个闸的窗口绰绰有余），截断点首行不完整直接丢（宁丢不错）。ENOENT 返回空，
// 真读失败抛给调用方（fail-closed 语义各自处理）。
const SPEAK_TAIL_BYTES = 256 * 1024;
function readSpeakLines(cfg) {
  const speak = join(bridgeDirs(cfg).base, 'logs', 'speak.jsonl');
  let buf;
  try {
    buf = readFileSync(speak);
  } catch (e) {
    if (e?.code === 'ENOENT') return []; // 还没发过言（首跑）= 0 条记录，不是错误
    throw e; // 其他读失败原样抛，fail-closed 语义归调用方
  }
  const oversized = buf.length > SPEAK_TAIL_BYTES;
  const str = (oversized ? buf.subarray(-SPEAK_TAIL_BYTES) : buf).toString('utf8');
  const lines = str.split('\n');
  if (oversized) lines.shift();
  return lines.filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function recentEmojiCount(cfg, chatKey, window) {
  try {
    const rows = readSpeakLines(cfg).filter((r) => r.chat === chatKey).slice(-window);
    return rows.filter((r) => r.emoji).length;
  } catch (e) {
    // 真读失败（损坏/权限/磁盘）：fail-closed——按"已达上限"拦截。
    // 原先 return 0 是 fail-open：speak.jsonl 读不了时硬闸无声失效，表情照发（G9b 的后门）
    log('outbound', `WARN emoji gate 读 speak.jsonl 失败，本次按已达上限拦截: ${e.message}`);
    return Infinity;
  }
}

// 同图冷却（P2，2026-11-28，借鉴 MaiBot emoji_system 对 600s 内用过的表情降权）：条数闸（G9b）
// 只防"表情刷屏"，防不了"同一张图连发"——复读机形态。数据源复用 speak.jsonl 的 emoji 字段
// （recordSpeak 已记 basename），零新存储。冷却窗内该 chatKey 发过同 basename → 拦。
// 真读失败 fail-closed 当冷却命中（与 recentEmojiCount 同哲学）。
export function sameStickerRecentlyUsed(cfg, chatKey, emojiBase, cooldownSec, now = Date.now()) {
  try {
    return readSpeakLines(cfg).some((r) => r.chat === chatKey
      && r.emoji === emojiBase
      && now - Date.parse(r.ts) < cooldownSec * 1000);
  } catch (e) {
    log('outbound', `WARN emoji cooldown 读 speak.jsonl 失败，本次按冷却命中拦截: ${e.message}`);
    return true;
  }
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
  } catch (e) {
    // 记录失败不阻断发送，但必须留痕——静默吞掉 = 表情统计/同图冷却的数据源无声消失
    //（P2-2a 审计修复：原先空 catch，测试环境目录缺失时冷却直接失效无人知晓）
    log('outbound', `WARN speak.jsonl 记录失败（表情统计/同图冷却数据源缺失）: ${e.message}`);
  }
}

// 模型说沉默就沉默——适配器层硬拦，不依赖提示词（提示词说"不想回就输出 [SILENT]"，模型可能忘）
// 词后必须非字母：防 "password=..."、"passing" 这类正常文本被误判为 pass（冒烟测试实测抓到）
const SILENT_PREFIX = /^\s*\[?(SILENT|沉默|不说话|pass)\]?(?![a-zA-Z])/i;
// 行内 SILENT 标记（2026-11-22 模型把 [SILENT] 当段落间沉默符号写在正文中间——字面漏出站）：
// 只剥方括号标记形态，裸词不动（防误伤"沉默是金"这类正文）；开头的真沉默由 SILENT_PREFIX 整条丢
const SILENT_INLINE = /\s*\[(?:SILENT|沉默|不说话|pass)\]/gi;

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

// —— D7 · 入参归一化（永久保留，不许删）——
// 老代码假设入参是字符串；信箱回滚路径（outbox 轮询 → processMessage）传的是老格式 JSON，
// 这里不归一模型输出的 JSON 会变成 text='' → 鱼彻底沉默。这一个函数是回滚能成立的前提。
function normalize(raw) {
  if (typeof raw === 'string') return { text: raw };
  if (raw && Array.isArray(raw?.lines)) {
    return { lines: raw.lines, reply_to: raw?.reply_to, voice: raw?.voice, sticker: raw?.sticker, silent: raw?.silent === true || raw?.silent === 'true' };
  }
  if (raw && typeof raw?.text === 'string') return { text: raw.text };
  return { text: '' }; // 兜底：宁可发空走丢弃逻辑，也不抛
}

// perChat 复合键淘汰（审计专项债）：`${chatKey}|<replyKey>` 每条被回复消息生成一个键，
// 原先只增不清（月级内存单调上涨）。回复窗口实际只有几分钟——超龄复合键不会有人再读。
// 本体键（纯 chatKey）数量有限（白名单群+私聊），不淘汰。导出纯函数供单测。
export function sweepStalePerChat(perChat, now, maxAgeMs = 30 * 60_000) {
  let removed = 0;
  for (const [k, v] of perChat) {
    if (k.includes('|') && (v?.ts ?? 0) < now - maxAgeMs) { perChat.delete(k); removed += 1; }
  }
  return removed;
}

export function createOutbound(cfg, onebot, inboundState) {
  const perChat = new Map(); // chatKey -> { repliesToLastInbound, proactive: number[], ts }
  const rollWindow = new Map(); // chatKey -> ts[]，同群 5 分钟滚动窗口（防多轮触发叠加刷屏）
  const lastDeferLog = new Map(); // chatKey -> ts，defer 日志节流（轮询 1s 一次，不能每条都打）
  const windowMs = cfg.limits?.maxWindow5MinMs ?? 300_000;
  let dailyCount = 0;
  let daily = dayKey();
  // 复合键定期淘汰（10 分钟一轮；unref 不挡进程退出，测试多实例无碍）
  setInterval(() => { sweepStalePerChat(perChat, Date.now()); }, 10 * 60_000).unref?.();

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
    let inlineEmoji = null; // 行内标记兜底提取的结果（isNew 分支赋值；sticker 字段显式给出时仍优先）
    if (isNew) {
      // 行内标记兜底提取（2026-11-28）：模型把表情写在 lines 里（而非 sticker 字段）是常态——
      // 此前新格式只认 sticker 字段，行内 [表情: xxx]/[xxx.ext]/（xxx.ext）一律只剥不转图，图静默丢失
      // （11-28 实战：全角括号三连漏字面）。先提取后剥除；sticker 字段显式给出时仍优先（含非法降级语义）
      for (const s of batch.lines) {
        const t = String(s);
        for (const m of [...t.matchAll(EMOJI_MARK), ...t.matchAll(EMOJI_SHORT), ...t.matchAll(EMOJI_SHORT_FULL)]) {
          const p = resolveEmojiFile(cfg, m[1].trim());
          if (p && !inlineEmoji) inlineEmoji = p;
        }
      }
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
      ? { text: joinedRaw, emojiPath: batch.sticker != null ? resolveEmojiFile(cfg, batch.sticker) : inlineEmoji }
      : (() => {
          const stripped = stripEmojiMarks(joinedRaw, cfg);
          let emojiPath = null;
          for (const m of [...joinedRaw.matchAll(EMOJI_MARK), ...joinedRaw.matchAll(EMOJI_SHORT), ...joinedRaw.matchAll(EMOJI_SHORT_FULL)]) {
            const p = resolveEmojiFile(cfg, m[1].trim());
            if (p && !emojiPath) emojiPath = p;
          }
          return { text: stripped, emojiPath };
        })();
    let text = emoji0.text;
    let emojiPath = emoji0.emojiPath;
    // 新格式 sticker 校验失败的降级日志（字段非法/文件不在库内 → 纯文本发）
    if (isNew && batch.sticker != null && !emojiPath) {
      log('outbound', `WARN outbound sticker 非法已忽略: ${String(batch.sticker).slice(0, 40)} [${source}]`);
    }

    const chatKey = chatType === 'group' ? `g:${chatId}` : `p:${userId}`;

    // ①.5 表情硬闸判定（G9b）：闸开且该 chatKey 最近 window 条已带 ≥ max 次表情 → 本次降级纯文本
    const gate = emojiGateState();
    if (emojiPath && gate.enabled) {
      const recent = recentEmojiCount(cfg, chatKey, gate.window);
      if (recent >= gate.max) {
        log('outbound', `emoji gated: ${chatKey} 最近 ${gate.window} 条已带 ${recent} 次表情（上限 ${gate.max}）——本次降级纯文本`);
        emojiPath = null;
      }
    }

    // ①.6 同图冷却（P2）：同 chatKey 同 basename 在 cooldownSec 窗内已发过 → 本次降级纯文本。
    // 显式 cooldownSec=0 关闭；与条数闸独立——刷屏闸管"量"，冷却管"重复"。
    // enabled=false = 总开关关闭，两个闸（含冷却）全关（P1-1 审计修复：原先只关条数闸，
    // 冷却仍以默认 600s 生效——控制台"关闭硬闸"的意图是表情自由）
    if (emojiPath && gate.enabled && gate.cooldownSec > 0 && sameStickerRecentlyUsed(cfg, chatKey, basename(emojiPath), gate.cooldownSec)) {
      log('outbound', `emoji cooldown: ${chatKey} "${basename(emojiPath).slice(0, 40)}" ${gate.cooldownSec}s 内已用过——本次降级纯文本`);
      emojiPath = null;
    }

    if (!text.trim() && !emojiPath) return drop('empty');

    // ② [SILENT] 过滤（对整段——模型可能两种格式都写）
    if (SILENT_PREFIX.test(text)) return drop('silent');
    // ②.5 行内 [SILENT] 标记剥除：混合输出（说完话补个标记）里标记已是噪音，剥掉照发
    text = text.replace(SILENT_INLINE, '').trim();

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
    // ④.5 QQ 号泄露拦截（2026-11-21 实际事故：她把主人 QQ 明文发进群）：
    // 配置里所有 QQ 数字（selfId/ownerQQ/白名单群与私聊）出现在出站文本 → 整条丢弃。
    // 数字来自配置自身（非硬编码），QQ 号是主人隐私——按纪律宁可不说也不漏。
    const qqDigits = [...new Set([
      String(cfg.onebot?.selfId ?? ''),
      String(cfg.ownerQQ ?? ''),
      ...(Array.isArray(cfg.allow?.groups) ? cfg.allow.groups.map(String) : []),
      ...(Array.isArray(cfg.allow?.private) ? cfg.allow.private.map(String) : []),
    ].filter((q) => /^\d{5,12}$/.test(q)))];
    const qqHit = qqDigits.find((q) => text.includes(q) || joined.includes(q));
    if (qqHit) {
      auditAlert('qq-leak', 'QQ号 ' + qqHit.slice(0, 3) + '****', text, chatKey);
      return drop('qq-leak');
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
    // 回复归属：出站带 inboxFile → 按入站文件计数（每条消息回复数天然 1:1）；
    // 无 inboxFile（主动消息）→ 退回时间窗近似（入站 2 分钟内算回复）
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
      segments = textLines; // 纯表情轮走下方 !segments.length && emojiSeg 分支，无需在此重置
    } else {
      const maxSegs = isBusy(chatKey, cfg)
        ? (cfg.limits?.busyMaxSegments ?? 2)
        : (cfg.limits?.maxSegments ?? 4);
      const raw = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, maxSegs);
      // OS 首段剥除：首段是"被 @ 了/得回"这类内心 OS 时去掉（正文在后续段）；新格式 lines 同样过这道
      const cleaned = stripOsHead(raw.join('\n'), chatKey);
      if (cleaned !== raw.join('\n')) {
        const kept = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, maxSegs);
        if (kept.length) { raw.length = 0; raw.push(...kept); }
      }
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

    // ⑤.5 限额预占（C1）：计数点从"发送成功后"提前到"检查通过后（dry-run 已 return 不占）"。
    // 本点与限额检查之间无 await（同一同步段，JS 单线程天然原子）——原先检查与计数隔着
    // 1.5~8s 拟真打字延迟 + 网络往返，两个并发 processMessage 都能通过检查再各自发送（TOCTOU 超发）。
    // 预占后发送失败也占额度：宁少发不多发（fail-closed，与计数器损坏按上限同哲学）。
    dailyCount += 1;
    saveCounters();
    if (chatType === 'group') { rl.push(Date.now()); rollWindow.set(chatKey, rl); }
    if (replyKey != null) {
      const ck = perChat.get(countKey) ?? { repliesToLastInbound: 0, proactive: [] };
      ck.repliesToLastInbound += 1;
      ck.ts = Date.now(); // 复合键淘汰依据（sweepStalePerChat）
      perChat.set(countKey, ck);
    } else if (isReply) {
      st.repliesToLastInbound += 1;
      perChat.set(chatKey, st);
    } else {
      st.proactive.push(Date.now());
      perChat.set(chatKey, st);
    }

    // 发送分支（D5 收敛）：群/私聊 + 纯数字 ID 归一（OneBot 要 Number）——原先纯表情/文字循环两处四份同构
    const sendMsg = (message) => chatType === 'group'
      ? onebot.action('send_group_msg', { group_id: /^\d+$/.test(chatId) ? Number(chatId) : chatId, message })
      : onebot.action('send_private_msg', { user_id: /^\d+$/.test(userId) ? Number(userId) : userId, message });

    try {
      // 纯表情（无文字）：只发一条 image 消息；否则文字段逐条发，首段挂引用、末段拼表情（图文同条）
      let r = null;
      let sent = 0;
      let lastErr = null;
      if (!segments.length && emojiSeg) {
        const message = [emojiSeg];
        if (replyToId != null) message.unshift({ type: 'reply', data: { id: replyToId } });
        r = await sendMsg(message);
        if (r && r.status === 'ok') sent = 1; else lastErr = r;
      } else {
        for (let i = 0; i < segments.length; i++) {
          // 拟真打字：段间延迟按上一行字数 × 速度算（长句慢短句快，12% 手快）——
          // 下限 1500ms 同旧算法（防洪节奏不变）；typingSecPerChar=0 可热切回旧随机
          if (i > 0) await sleep(typingDelayMs(segments[i - 1], typingSecPerChar()));
          const message = [{ type: 'text', data: { text: segments[i] } }];
          if (i === segments.length - 1 && emojiSeg) message.push(emojiSeg);
          if (i === 0 && replyToId != null) message.unshift({ type: 'reply', data: { id: replyToId } }); // 引用只挂首条
          r = await sendMsg(message);
          if (!r || r.status !== 'ok') { lastErr = r; break; }
          sent += 1;
        }
      }
      // D4b · 部分成功即成功：发出去至少一段就不重试（宁可少发一段，不为补一句把整段刷两遍）。
      // 一段都没发出去才算 error——此时重试是安全的（没有重复）。
      // 限额计数已在 ⑤.5 预占（C1），此处不再动计数器。
      if (sent > 0) {
        const partial = sent < (segments.length || 1) ? `${sent}/${segments.length || 1}` : null;
        if (partial) log('outbound', `WARN outbound partial ${partial} chat=${chatKey} err=${JSON.stringify(lastErr).slice(0, 120)} [${source}]`);
        recordSpeak(cfg, chatKey, text, source, emojiPath);
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

  // 控制台 /stats 用（只读快照，无副作用）：今日已说条数 / 上限 / 各群滚动窗口余量
  function stats() {
    const roll = {};
    for (const [k, arr] of rollWindow) {
      const f = arr.filter((t) => Date.now() - t < windowMs);
      if (f.length) roll[k] = f.length;
    }
    return { dailyCount, maxDailyTotal: cfg.limits.maxDailyTotal, roll };
  }

  return { processMessage, stats };
}
