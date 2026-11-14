// 工具集：日志、审计、OneBot 消息文本化、属性转义、配置加载
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // fish-adapter/
const LOG_DIR = join(ROOT_DIR, 'logs');
try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* 已存在 */ }

export function log(tag, ...parts) {
  const line = `[${new Date().toISOString()}] [${tag}] ${parts.join(' ')}`;
  console.log(line);
  try { appendFileSync(join(LOG_DIR, 'adapter.log'), line + '\n'); } catch { /* 日志失败不阻断业务 */ }
}

// 审计告警：出站敏感信息命中、禁词命中。独立文件，排查误伤/泄露先看这里
export function auditAlert(tag, ...parts) {
  const line = `[${new Date().toISOString()}] [${tag}] ${parts.join(' ')}`;
  console.error('[AUDIT] ' + line);
  try { appendFileSync(join(LOG_DIR, 'audit.log'), line + '\n'); } catch { /* 同上 */ }
}

// OneBot v11 message → 纯文本（段数组为主，兼容 CQ 码字符串格式）
export function plainText(event) {
  const msg = event?.message;
  if (typeof msg === 'string') {
    return msg.replace(/\[CQ:[^\]]*\]/g, '').trim();
  }
  if (!Array.isArray(msg)) return '';
  const out = [];
  for (const seg of msg) {
    if (seg.type === 'text') out.push(seg.data?.text ?? '');
    else if (seg.type === 'at') out.push(`@${seg.data?.qq ?? ''}`);
    else if (seg.type === 'face') out.push('[表情]');
    else if (seg.type === 'image') out.push('[图片]');
    else if (seg.type === 'reply') { /* 引用单独走 parseReply */ }
    else out.push(`[${seg.type}]`);
  }
  return out.join('').trim();
}

// 收集 OneBot 消息里的图片段 url（只取 http/https；QQ 多媒体链接有效期短，须即时下载）
// 与 plainText() 的 [图片] 占位符按段序一一对应（无 url 的 image 段两边都跳过）
export function collectImages(event) {
  const msg = event?.message;
  if (!Array.isArray(msg)) return [];
  const out = [];
  for (const seg of msg) {
    if (seg.type === 'image') {
      const url = seg.data?.url;
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) out.push(url);
    }
  }
  return out;
}

// 从图片 url 猜扩展名（QQ 多媒体 url 一般无扩展名，默认 .jpg）
export function guessImageExt(url) {
  const m = /\.(jpe?g|png|gif|webp|bmp)(?:\?|#|$)/i.exec(url ?? '');
  const ext = m ? m[1].toLowerCase() : 'jpg';
  return '.' + (ext === 'jpeg' ? 'jpg' : ext);
}

// —— 视频/链接分享卡片（鱼看卡片 v1）：json 小程序卡片 → 标题/简介/链接/封面 ——
// QQ 里各 App 分享（B 站/抖音/微博/网易云等）都是 json 卡片，字段名各家不同：
// 容错遍历提取（不硬编码单一站点），标题/简介截断防超长；卡片内容按不可信数据处理
const CARD_IMG_HINT = /(hdslb|gtimg|qpic|douyinpic|byteimg|ks-cdn|126\.net|xhscdn|alicdn|img\.bilibili)/i;
const CARD_KEY_TITLE = /^(title|preview)$/i;
const CARD_KEY_DESC = /^(desc|subtitle|summary)$/i;

function pickCardFields(obj, depth, out) {
  if (depth > 6 || !obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      if (/^https?:\/\//i.test(v)) {
        out.urls.push(v);
        if (/\.(jpe?g|png|webp|gif)(?:[?#]|$)/i.test(v) || CARD_IMG_HINT.test(v)) out.covers.push(v);
      } else if (v.trim()) {
        if (CARD_KEY_TITLE.test(k)) out.titles.push(v.trim());
        else if (CARD_KEY_DESC.test(k)) out.descs.push(v.trim());
      }
    } else if (v && typeof v === 'object') {
      pickCardFields(v, depth + 1, out);
    }
  }
}

// 每个 json 段产出一条 {title, desc, url, cover}；提取不到任何字段则 null（降级占位用）
export function extractAppCards(event) {
  const msg = event?.message;
  if (!Array.isArray(msg)) return [];
  const out = [];
  for (const seg of msg) {
    if (seg.type !== 'json') continue;
    let card = null;
    try { card = JSON.parse(seg.data?.data ?? '{}'); } catch { /* 坏 json */ }
    const fields = { titles: [], descs: [], urls: [], covers: [] };
    if (card && typeof card === 'object') pickCardFields(card, 0, fields);
    const title = (fields.titles[0] ?? fields.descs[0] ?? '').slice(0, 120);
    const desc = (fields.descs.find((d) => d !== fields.titles[0]) ?? '').slice(0, 200);
    const url = fields.urls.find((u) => /b23\.tv|bilibili/i.test(u)) ?? fields.urls[0] ?? null;
    const cover = fields.covers[0] ?? null;
    if (title || desc || url || cover) out.push({ title, desc, url, cover });
    else { log('inbound', `card unparsed, raw=${String(seg.data?.data ?? '').slice(0, 400)}`); out.push(null); }
  }
  return out;
}

// 属性值转义：防群友在引用文本里塞 `" mentioned="true` 伪造属性（规格 §4.3 ⑥）
export function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function loadConfig() {
  const cfg = JSON.parse(readFileSync(join(ROOT_DIR, 'config.json'), 'utf8'));
  // fail-closed 从启动就钉死：白名单为空时绝不允许放行
  if (cfg.allow?.allowAllWhenEmpty !== false) {
    throw new Error('allow.allowAllWhenEmpty 必须为 false（fail-closed），拒绝启动');
  }
  return cfg;
}
