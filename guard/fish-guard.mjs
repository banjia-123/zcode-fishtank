// PreToolUse 守卫（正式版，P0.5-1）—— fail-closed：鱼会话任何异常一律 deny
// ① 白名单：施工/运维会话（_guard/allow-sessions.json）全放行，守卫只保护鱼
// ② 危险工具（Bash/代理/联网）：鱼一律 deny
// ③ 文件类工具只查路径字段（防验证桩时代的全文匹配误伤），fishpond 外 deny
// ④ realpathSync 解 .. 与符号链接，防逃逸（规格 §6.3）
// ⑤ 受保护文件不可写（2026-11-28）：core.md / persona.md / 任务书 / 审校备份 / hooks 配置——只许人工与
//    审校脚本改；鱼能写它们等于能给自己改记忆、改任务指令、关守卫
// ⑤ 受保护文件（2026-11-28）：fishpond 内有几种文件只许人工/审校脚本改——鱼能写它们等于能给自己
//    改记忆（core.md）、改任务指令（任务书）、关守卫（hooks 配置）。写类工具命中一律 deny，读不受限
import { readFileSync, realpathSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { relative, isAbsolute, resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 包根推导（发布包与本机同构）：本脚本在 <包根>/guard/ 下，鱼缸在 <包根>/fishpond/
// 注意：此处不能 realpath（fishpond 可能尚未创建，guard 也要能跑）
// FISH_GUARD_ROOT / FISH_GUARD_LOG / FISH_GUARD_ALLOW：测试注入（test-fish-guard.mjs 用 mkdtemp 隔离）；
// 生产不设，按布局推导
const GUARD_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(GUARD_DIR);
let ROOT = process.env.FISH_GUARD_ROOT || join(PKG_ROOT, 'fishpond');
let pondOk = true;
try { ROOT = realpathSync(ROOT); } catch { pondOk = false; /* 鱼缸未建/不可达：下方一律 deny */ }
const FIRE_LOG = process.env.FISH_GUARD_LOG || join(GUARD_DIR, 'hook-fire.log');

const FIRE_LOG_MAX = 2 * 1024 * 1024; // 轮转阈值 2MB：一天几百行 ≈ 100KB，约 3 周一转；只留一代 .1（留痕够回查近期）
function fireLog(obj) {
  try {
    // 轮转（2026-11-28 挂账销账）：append 前 statSync，超限把当前文件改名 .1（顶掉旧一代）再写新文件。
    // hook 进程本就短命，每次多一次 statSync 可忽略；文件还不存在 = 无需轮转
    try { if (statSync(FIRE_LOG).size > FIRE_LOG_MAX) renameSync(FIRE_LOG, FIRE_LOG + '.1'); } catch { /* 无文件 = 无需轮转 */ }
    appendFileSync(FIRE_LOG, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...obj }) + '\n');
  } catch { /* 日志失败不阻断判定 */ }
}

// 放行也留痕（2026-11-28）：此前只在拒绝时记录，于是"守卫到底有没有在任务会话里被调用过"无从查证——
// 一道证明不了自己在工作的防线等于没有。每次工具调用一行（tool + 鱼缸内相对路径 + 会话 ID）；
// 任务的工具调用量很小（每次几十行），日志增长可忽略；超 2MB 自动轮转留一代（fireLog 处）
function allow(note) {
  if (note) fireLog({ phase: 'allow', ...note });
  process.exit(0);
}
function deny(reason) {
  // ev 可能未定义（stdin 解析失败路径先于赋值就调 deny）——可选链防 deny 自身崩溃：
  // 崩了虽大概率仍非零退出，但 permissionDecision 协议和 fireLog 审计会一起丢
  fireLog({ phase: 'deny', reason, sessionId: String(ev?.session_id ?? ev?.sessionId ?? '') });
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
  const cfg = JSON.parse(readFileSync(process.env.FISH_GUARD_ALLOW || `${GUARD_DIR}/allow-sessions.json`, 'utf8'));
  if (Array.isArray(cfg.sessions)) sessions = cfg.sessions;
} catch { /* 名单缺失 = 空 */ }
const sid = String(ev.session_id ?? ev.sessionId ?? '');
if (sid && sessions.includes(sid)) {
  fireLog({ phase: 'allow', by: 'whitelist', sessionId: sid });
  allow();
}

// 写类工具（⑤ 受保护文件检查只管它们）。注意：必须声明在下方顶层判定代码之前——
// 放在文件末尾会让判定代码踩到暂时性死区，catch 后变成"所有调用一律拒绝"
const WRITE_TOOLS = /^(Write|Edit|ApplyPatch)$/i;
// 相对鱼缸根的受保护文件（正斜杠）：只许人工/审校脚本改
const PROTECTED_WRITE = [
  { re: /^persona\.md$/i, why: '人格卡是主人写的' },
  { re: /^memory\/core\.md$/i, why: '长期记忆只走人工审校' },
  { re: /^memory\/[^/]+\.(bak|prev)$/i, why: '审校备份' },
  { re: /^memory\/remove-queue\.json$/i, why: '下架队列' },
  { re: /^(\.learner-prompt|\.diary-prompt)\.md$/i, why: '任务指令' },
  { re: /^\.zcode(\/|$)/i, why: 'hooks 配置' },
];

// 以下为鱼会话的钉死逻辑
try {
  // 鱼缸目录不存在/不可达：一律拒绝。原先注释写着"全 deny"，实际相对路径会被放行（逐段 realpath 遇到
  // 不存在的段即视为新建）——2026-11-28 对齐注释与文件头的 fail-closed 声明
  if (!pondOk) deny('鱼缸目录不存在或不可达');
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

  // ⑤ 受保护文件不可写（只管写类工具；路径此时已确认在鱼缸内）
  if (WRITE_TOOLS.test(tool)) {
    for (const p of paths) {
      const rel = relInsideFishpond(p);
      const hit = rel && PROTECTED_WRITE.find((x) => x.re.test(rel));
      if (hit) deny(`受保护文件不可写（${hit.why}）: ${rel}`);
    }
  }

  // 全部检查通过：留痕后放行。记鱼缸内的相对路径（不记绝对路径），截断防单行过长
  allow({ by: 'checks', tool, files: paths.map((p) => relInsideFishpond(p)).filter(Boolean).map((r) => r.slice(0, 120)), sessionId: sid });
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
  return relInsideFishpond(p) !== null;
}

// 相对鱼缸根的规范路径（正斜杠）；越界返回 null，空路径返回空串。
// 前缀必须是 ROOT（大小写不敏感比较），否则根本不在鱼缸下。
// 逐段下钻：每个已存在的段 realpath 后必须在 ROOT 内（防 symlink 逃逸）；
// 第一个不存在的段起保持 resolve 的结果（= 新建文件的末端，前缀已验证在 ROOT 内；resolve 已消解 ..）
function relInsideFishpond(p) {
  if (!p) return '';
  const abs = isAbsolute(p) ? resolve(p) : resolve(ROOT, p);
  const segs = abs.split(/[\\/]+/).filter(Boolean);
  const rootSegs = ROOT.split(/[\\/]+/).filter(Boolean);
  if (segs.length < rootSegs.length) return null;
  for (let i = 0; i < rootSegs.length; i++) {
    if (String(segs[i]).toLowerCase() !== rootSegs[i].toLowerCase()) return null;
  }
  let verified = ROOT;
  let i = rootSegs.length;
  for (; i < segs.length; i++) {
    const cur = verified + '\\' + segs[i];
    let real = null;
    try {
      real = realpathSync(cur);
    } catch {
      break; // 此段起不存在 → 均为新建，前缀已验证在 ROOT 内
    }
    const rel = relative(ROOT, real);
    if (!(rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))) return null;
    verified = real;
  }
  const done = relative(ROOT, verified).split(/[\\/]+/).filter(Boolean);
  return [...done, ...segs.slice(i)].join('/');
}
