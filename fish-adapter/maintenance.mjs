// 鱼缸维护脚本：清理 automation 轮询与 patrol 唤醒产生的旧会话条目与 run 历史
// 用法：node maintenance.mjs                    （预览，不改任何数据）
//       node maintenance.mjs --apply            （执行清理）
//       node maintenance.mjs --db "路径" --apply （ZCode 数据目录非默认位置时指定）
//       node maintenance.mjs --ws "路径" --apply （只清理该路径开头工作区的条目）
//       node maintenance.mjs --prune-after 30 --apply （本次用 30 分钟窗口；默认读 config.maintenance.pruneAfterMin）
// 清理策略：
//   1. tasks 表软删（deleted=1）超过 40 分钟的鱼缸会话条目（S3.4：会话寿命分钟级，
//      1 小时→40 分钟；patrol 的 wake 会话不是 automation，按 fishpond 工作区识别）；
//      排除最近 10 分钟有活动（updated_at）的会话——正在用的（比如人工开着鱼缸查）不动；
//      软删前逐条归档到 logs/sessions.jsonl（task_id/title/前 200 字，出问题还能查当天鱼看到了什么）
//   2. automation_runs 表删除 7 天前的 run 记录
// 安全：UPDATE 与预览使用同一份过滤（含白名单保护），逐条执行，绝不整表 UPDATE
import { DatabaseSync } from 'node:sqlite';
import { logOp } from './lib/ops-log.mjs';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const APPLY = process.argv.includes('--apply');
const T0 = Date.now();

// —— 工作区过滤：--ws 参数（可选，前缀匹配 workspace_path）——
const wsArgIdx = process.argv.indexOf('--ws');
const WS = wsArgIdx > -1 ? process.argv[wsArgIdx + 1] : null;

// —— 数据库定位：--db 参数 > 默认 dataBaseDir 探测 > 报错 ——
const dbArgIdx = process.argv.indexOf('--db');
const DB = dbArgIdx > -1 ? process.argv[dbArgIdx + 1]
  : join(homedir(), '.zcode', 'v2', 'tasks-index.sqlite');
if (!existsSync(DB)) {
  console.error(`[maintenance] 找不到数据库: ${DB}`);
  console.error('ZCode 数据目录非默认位置时，用 --db "…/tasks-index.sqlite" 显式指定');
  process.exit(1);
}

// —— 保护名单：包根推导（fish-adapter 的上级），兼容 guard/ 与 _guard/ 两种目录名 ——
// 名单内的会话永不清理（与 guard 白名单同源）
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let protectedSessions = [];
for (const dir of ['guard', '_guard']) {
  const f = join(PKG_ROOT, dir, 'allow-sessions.json');
  if (existsSync(f)) {
    try {
      const g = JSON.parse(readFileSync(f, 'utf8'));
      if (Array.isArray(g.sessions)) protectedSessions = g.sessions;
      break;
    } catch { /* 名单损坏 = 无保护，继续 */ }
  }
}

const db = new DatabaseSync(DB);
const MIN = 60_000, DAY = 24 * 60 * MIN;
// —— 窗口参数化（控制台可调）：命令行 --prune-after <分钟> > config.maintenance.pruneAfterMin > 默认 40 ——
const CFG_PATH = join(dirname(fileURLToPath(import.meta.url)), 'config.json');
let maintenanceCfg = {};
try { maintenanceCfg = JSON.parse(readFileSync(CFG_PATH, 'utf8')).maintenance ?? {}; } catch { /* config 缺失/损坏走默认值 */ }
const argMinutes = (name) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !Number.isNaN(Number(process.argv[i + 1])) ? Number(process.argv[i + 1]) : null;
};
const PRUNE_AFTER = Math.max(1, argMinutes('prune-after') ?? Number(maintenanceCfg.pruneAfterMin) ?? 40) * MIN;
const ACTIVE_GRACE = Math.max(1, argMinutes('active-grace') ?? Number(maintenanceCfg.activeGraceMin) ?? 10) * MIN;
const now = Date.now();

// —— 1. 旧鱼缸会话条目（软删 + 删前归档）——
// 识别三类：automation 会话（cron 标记）、标题带"自动化任务"的、fishpond 工作区的（patrol wake 会话——
// 不是 automation，标题是 prompt 首行，只能靠工作区路径识别）
const staleTasks = db.prepare(
  `SELECT task_id, title, created_at, updated_at FROM tasks
   WHERE deleted=0 AND created_at < ?
     AND (cron_automation_id IS NOT NULL OR title LIKE '%自动化任务%' OR workspace_path LIKE '%fishpond%')
     AND (updated_at IS NULL OR updated_at < ?)
     ${WS ? 'AND workspace_path LIKE ?' : ''}
   ORDER BY created_at DESC`
).all(now - PRUNE_AFTER, now - ACTIVE_GRACE, ...(WS ? [WS + '%'] : [])).filter((t) => !protectedSessions.includes(t.task_id));
console.log(`[tasks] 将软删 ${staleTasks.length} 条旧鱼缸会话条目（超 ${PRUNE_AFTER / MIN} 分钟且 ${ACTIVE_GRACE / MIN} 分钟内无活动；保护名单 ${protectedSessions.length} 条${WS ? `；仅 ${WS} 开头的工作区` : ''}）`);
for (const t of staleTasks.slice(0, 3)) console.log(`  示例: ${new Date(t.created_at).toISOString()} ${String(t.title ?? '').slice(0, 40)}`);

// —— 2. 旧 run 记录（硬删）——
const runCols = db.prepare('PRAGMA table_info(automation_runs)').all().map((c) => c.name);
const timeCol = runCols.includes('created_at') ? 'created_at' : (runCols.includes('scheduled_at') ? 'scheduled_at' : null);
let staleRuns = 0;
if (timeCol) {
  staleRuns = db.prepare(`SELECT COUNT(*) n FROM automation_runs WHERE ${timeCol} < ?`).get(now - 7 * DAY).n;
}
console.log(`[automation_runs] 将删除 ${staleRuns} 条 7 天前的 run 记录（列: ${timeCol ?? '无时间列，跳过'}）`);

if (!APPLY) {
  console.log('\n（预览模式，加 --apply 执行）');
  process.exit(0);
}

// —— 执行 ——
// UPDATE 与预览使用同一份过滤（含白名单保护）——逐条执行，绝不整表 UPDATE
// S3.4：软删前逐条归档（logs/sessions.jsonl：task_id/title 前 200 字/创建时间）——
// 只删不归档 = 出问题时无从查"那天鱼看到了什么"；归档失败不阻断删除（日志目录满等罕见场景）
const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'logs');
function archiveSession(t) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, 'sessions.jsonl'), JSON.stringify({
      ts: new Date().toISOString(),
      task_id: t.task_id,
      title: String(t.title ?? '').slice(0, 200),
      created_at: t.created_at,
    }) + '\n', 'utf8');
  } catch { /* 归档失败不阻断 */ }
}
const t1 = db.prepare("UPDATE tasks SET deleted=1, updated_at=? WHERE task_id=? AND deleted=0");
for (const t of staleTasks) {
  archiveSession(t);
  const r = t1.run(now, t.task_id);
  console.log(`  软删 ${t.task_id} (${r.changes})`);
}
console.log(`[tasks] 软删 ${staleTasks.length} 条（已归档 → logs/sessions.jsonl）`);

let t2 = { changes: 0 };
if (timeCol) {
  t2 = db.prepare(`DELETE FROM automation_runs WHERE ${timeCol} < ?`).run(now - 7 * DAY);
  console.log(`[automation_runs] 删除 ${t2.changes} 条`);
}
logOp('prune', true, { ms: Date.now() - T0, detail: { tasks: staleTasks.length, runs: staleRuns } });
console.log('完成');
