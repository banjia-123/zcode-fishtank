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
