// 鱼缸维护脚本：清理 automation 轮询产生的旧会话条目与 run 历史
// 用法：node maintenance.mjs                    （预览，不改任何数据）
//       node maintenance.mjs --apply            （执行清理）
//       node maintenance.mjs --db "路径" --apply （ZCode 数据目录非默认位置时指定）
//       node maintenance.mjs --ws "路径" --apply （只清理该路径开头工作区的条目）
// 清理策略：
//   1. tasks 表软删（deleted=1）cron_automation_id 非空、超过 1 小时的旧会话条目
//      （保留最近 1 小时的——活跃 run 正在用的不动；软删可恢复）
//   2. automation_runs 表删除 7 天前的 run 记录
// 安全：UPDATE 与预览使用同一份过滤（含白名单保护），逐条执行，绝不整表 UPDATE
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const APPLY = process.argv.includes('--apply');

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
const HOUR = 3600_000, DAY = 24 * HOUR;
const now = Date.now();

// —— 1. 旧 automation 会话条目（软删）——
// 实际数据里 automation 会话多数不带 cron 标记，标题直接是任务 prompt（含"自动化任务"），一并识别
const staleTasks = db.prepare(
  `SELECT task_id, title, created_at FROM tasks
   WHERE deleted=0 AND created_at < ?
     AND (cron_automation_id IS NOT NULL OR title LIKE '%自动化任务%')
     ${WS ? 'AND workspace_path LIKE ?' : ''}
   ORDER BY created_at DESC`
).all(now - HOUR, ...(WS ? [WS + '%'] : [])).filter((t) => !protectedSessions.includes(t.task_id));
console.log(`[tasks] 将软删 ${staleTasks.length} 条旧 automation 会话条目（保留最近 1 小时；保护名单 ${protectedSessions.length} 条${WS ? `；仅 ${WS} 开头的工作区` : ''}）`);
for (const t of staleTasks.slice(0, 3)) console.log(`  示例: ${new Date(t.created_at).toISOString()} ${t.task_id}`);

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
const t1 = db.prepare("UPDATE tasks SET deleted=1, updated_at=? WHERE task_id=? AND deleted=0");
for (const t of staleTasks) {
  const r = t1.run(now, t.task_id);
  console.log(`  软删 ${t.task_id} (${r.changes})`);
}
console.log(`[tasks] 软删 ${staleTasks.length} 条`);

let t2 = { changes: 0 };
if (timeCol) {
  t2 = db.prepare(`DELETE FROM automation_runs WHERE ${timeCol} < ?`).run(now - 7 * DAY);
  console.log(`[automation_runs] 删除 ${t2.changes} 条`);
}
console.log('完成');
