// PreToolUse 守卫（正式版，P0.5-1）—— fail-closed：鱼会话任何异常一律 deny
// ① 白名单：施工/运维会话（_guard/allow-sessions.json）全放行，守卫只保护鱼
// ② 危险工具（Bash/代理/联网）：鱼一律 deny
// ③ 文件类工具只查路径字段（防验证桩时代的全文匹配误伤），fishpond 外 deny
// ④ realpathSync 解 .. 与符号链接，防逃逸（规格 §6.3）
import { readFileSync, realpathSync, appendFileSync } from 'node:fs';
import { relative, isAbsolute, resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 包根推导（发布包与本机同构）：本脚本在 <包根>/guard/ 下，鱼缸在 <包根>/fishpond/
// 注意：此处不能 realpath（fishpond 可能尚未创建，guard 也要能跑）
const GUARD_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(GUARD_DIR);
let ROOT = join(PKG_ROOT, 'fishpond');
try { ROOT = realpathSync(ROOT); } catch { /* 鱼缸未建 = 一切写入都不在其内 = 全 deny，符合 fail-closed */ }
const FIRE_LOG = join(GUARD_DIR, 'hook-fire.log');

function fireLog(obj) {
  try {
    appendFileSync(FIRE_LOG, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...obj }) + '\n');
  } catch { /* 日志失败不阻断判定 */ }
}

function allow() { process.exit(0); }
function deny(reason) {
  fireLog({ phase: 'deny', reason, sessionId: String(ev.session_id ?? ev.sessionId ?? '') });
  process.stdout.write(JSON.stringify({
    permissionDecision: 'deny',
    reason,
  }));
  process.exit(2);
}

// stdin 解析失败 → 无法判断会话身份 → fail-closed
let ev;
try {
  ev = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch (e) {
  deny(`guard: stdin 解析失败: ${e.message}`);
}

// ① 白名单：读到名单失败视为空（鱼会话照钉；施工会话重读即可）
let sessions = [];
try {
  const cfg = JSON.parse(readFileSync(`${GUARD_DIR}/allow-sessions.json`, 'utf8'));
  if (Array.isArray(cfg.sessions)) sessions = cfg.sessions;
} catch { /* 名单缺失 = 空 */ }
const sid = String(ev.session_id ?? ev.sessionId ?? '');
if (sid && sessions.includes(sid)) {
  fireLog({ phase: 'allow', by: 'whitelist', sessionId: sid });
  allow();
}

// 以下为鱼会话的钉死逻辑
try {
  const tool = String(ev.tool_name ?? ev.toolName ?? '');
  const input = ev.tool_input ?? ev.toolInput ?? {};

// ② 鱼会话工具白名单：只许文件读写类，其余一律 deny（fail-closed 收窄工具面）
  if (!/^(Read|Glob|Grep|Write|Edit|ApplyPatch)$/i.test(tool)) {
    deny(`鱼不可使用 ${tool}`);
  }

  // ③ 文件路径越界（覆盖 Read/Glob/Grep/Write/Edit/ApplyPatch，只查路径字段）
  const paths = collectPaths(input);
  for (const p of paths) {
    if (!isInsideFishpond(p)) deny(`路径越界: ${p}`);
  }

  allow();
} catch (e) {
  deny(`guard 异常: ${e.message}`);
}

function collectPaths(input) {
  const out = [];
  for (const k of ['file_path', 'path', 'notebook_path']) {
    if (typeof input[k] === 'string') out.push(input[k]);
  }
  if (Array.isArray(input.paths)) out.push(...input.paths.filter((x) => typeof x === 'string'));
  return out;
}

function isInsideFishpond(p) {
  if (!p) return true;
  const abs = isAbsolute(p) ? resolve(p) : resolve(ROOT, p);
  // 前缀必须是 ROOT（大小写不敏感比较），否则根本不在鱼缸下
  const segs = abs.split(/[\\/]+/).filter(Boolean);
  const rootSegs = ROOT.split(/[\\/]+/).filter(Boolean);
  if (segs.length < rootSegs.length) return false;
  for (let i = 0; i < rootSegs.length; i++) {
    if (String(segs[i]).toLowerCase() !== rootSegs[i].toLowerCase()) return false;
  }
  // 逐段下钻：每个已存在的段 realpath 后必须在 ROOT 内（防 symlink 逃逸）；
  // 第一个不存在的段 = 新建文件的末端，剩余段受已验证前缀约束（resolve 已消解 ..）
  let verified = ROOT;
  for (let i = rootSegs.length; i < segs.length; i++) {
    const cur = verified + '\\' + segs[i];
    let real = null;
    try {
      real = realpathSync(cur);
    } catch {
      return true; // 此段起不存在 → 均为新建，前缀已验证在 ROOT 内
    }
    const rel = relative(ROOT, real);
    if (!(rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))) return false;
    verified = real;
  }
  return true;
}
