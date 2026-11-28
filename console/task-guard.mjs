// 任务护栏（2026-11-28）：学习/日记任务的 prompt 真源，与"任务书外写入"的事后检查。
//
// 起因：学习任务跑完把今天上午删掉的 memory/style.json 又写了回来。追下去发现两件事——
//   ① 生产实际执行的 prompt 不是任务书（.learner-prompt.md），而是 tasks-manual.json 里一份归档快照；
//      任务书只做回落。两处各改各的，悄悄漂移：快照停在旧版（还要求写 style.json、没有名册步骤、
//      没有读取红线），任务书上的修复一条没进生产。
//   ② 现有 fish-guard hook 只限制"路径在 fishpond 内"——鱼能写 memory/ 下任何文件，包括 core.md。
// 现在只认任务书一处（读不到就报错，不回落过时快照），并在任务结束后对比前后快照。
//
// 事后检查的处置是克制的：
//   · 凭空出现的任务书外文件 → 挪到隔离区（可恢复，保留相对路径）
//   · 已有文件被改动/被删 → 只报告，不动。原因：分不清是任务改的还是人在任务运行期间走审阅页改的
//     （审阅会写 core.md），自动还原可能覆盖掉刚批准的记忆。事前拦截交给 fish-guard hook。
// 纯逻辑 + 注入路径，可单测（test-task-guard.mjs）。
import { readFileSync, statSync, readdirSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

// —— prompt 提取：任务书是"文档 + ```text 围栏里的 prompt"，只把围栏正文发给模型 ——
// 围栏外的说明（维护记录、设计要点）是给维护者看的，发出去是噪音。没有围栏就整发（兼容纯 prompt 文件）
export function extractTaskPrompt(text) {
  const s = String(text ?? '');
  // 结尾换行设为可选：空围栏（```text 紧接 ```）也要识别成空 prompt，否则围栏标记本身会被当成 prompt 发出去
  const m = s.match(/```text[^\n]*\r?\n([\s\S]*?)\r?\n?```/);
  return (m ? m[1] : s).trim();
}

// —— 监视范围与可写白名单（相对 fishpond，正斜杠）——
// 两个任务盯同一片范围（记忆目录 + 日记目录 + 表情索引）：任一任务动了另一任务的产物也要能报出来。
// 日志/附件/信箱不扫——适配器每秒在写，和任务无关
// writable = 任务书列明允许该任务写的
// ignored = 任务期间允许变化、但不该算到任务头上的——审校/系统的备份产物（人审在任务运行中也会产生）
const WATCH = { dirs: ['memory', 'diary'], files: ['emojis/index.json'] };
const SYSTEM_BACKUPS = [(rel) => /^memory\/[^/]+\.(bak|prev)$/.test(rel)];
const eq = (s) => (rel) => rel === s;
const isDayDiary = (rel) => /^diary\/\d{4}-\d{2}-\d{2}\.md$/.test(rel);
export const TASK_WRITE_SCOPE = {
  learn: {
    ...WATCH,
    writable: [eq('memory/vocab.json'), eq('memory/candidates.md'), eq('memory/roster.json'), eq('memory/.learner-cursor'), eq('emojis/index.json')],
    ignored: SYSTEM_BACKUPS,
  },
  diary: {
    ...WATCH,
    writable: [isDayDiary, eq('memory/.diary-cursor')],
    ignored: SYSTEM_BACKUPS,
  },
};

const toParts = (rel) => rel.split('/');
const stOf = (abs) => { const st = statSync(abs, { bigint: true }); return { mtimeNs: st.mtimeNs, size: st.size }; };

// 监视范围内的文件快照：rel → { mtimeNs, size }（bigint 纳秒——毫秒精度在同毫秒两次写入时会撞车）
export function snapshotWatch(fishpond, kind) {
  const scope = TASK_WRITE_SCOPE[kind];
  const out = new Map();
  const walk = (absDir, relDir) => {
    let ents = [];
    try { ents = readdirSync(absDir, { withFileTypes: true }); } catch { return; } // 目录不存在 = 空
    for (const e of ents) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(absDir, e.name), rel);
      else if (e.isFile()) { try { out.set(rel, stOf(join(absDir, e.name))); } catch { /* 读完就消失的临时文件：忽略 */ } }
    }
  };
  for (const d of scope.dirs) walk(join(fishpond, ...toParts(d)), d);
  for (const f of scope.files) { try { out.set(f, stOf(join(fishpond, ...toParts(f)))); } catch { /* 不存在 */ } }
  return out;
}

// 前后快照对比，只报"任务书外"的变化（可写的与免检的不算）
export function diffWatch(before, after, kind) {
  const scope = TASK_WRITE_SCOPE[kind];
  const counted = (rel) => !scope.writable.some((f) => f(rel)) && !scope.ignored.some((f) => f(rel));
  const added = [], modified = [];
  for (const [rel, st] of after) {
    if (!counted(rel)) continue;
    const prev = before.get(rel);
    if (!prev) added.push(rel);
    else if (prev.mtimeNs !== st.mtimeNs || prev.size !== st.size) modified.push(rel);
  }
  const removed = [...before.keys()].filter((rel) => counted(rel) && !after.has(rel));
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort() };
}

// 把凭空出现的文件挪进隔离区（同卷 rename；保留相对路径，想还原搬回去即可）
export function quarantineAdded(fishpond, quarantineRoot, kind, added, now = new Date()) {
  const dir = join(quarantineRoot, `${now.toISOString().replace(/[:.]/g, '-')}-${kind}`);
  const quarantined = [], failed = [];
  for (const rel of added) {
    const dst = join(dir, ...toParts(rel));
    try { mkdirSync(dirname(dst), { recursive: true }); renameSync(join(fishpond, ...toParts(rel)), dst); quarantined.push(rel); }
    catch (e) { failed.push({ rel, error: String(e?.message ?? e) }); }
  }
  return { dir, quarantined, failed };
}

// 一步到位：任务后快照 → 对比 → 隔离新增。干净的运行返回 null
export function checkTaskStray({ fishpond, kind, before, quarantineRoot, now = new Date() }) {
  if (!before) return null;
  const d = diffWatch(before, snapshotWatch(fishpond, kind), kind);
  const q = d.added.length ? quarantineAdded(fishpond, quarantineRoot, kind, d.added, now) : null;
  const failed = q?.failed ?? [];
  if (!d.added.length && !d.modified.length && !d.removed.length) return null;
  return {
    added: d.added,
    modified: d.modified,
    removed: d.removed,
    quarantineDir: q ? q.dir : null,
    quarantineFailed: failed,
  };
}

// 读取任务书并提取 prompt。抛错/返回空串由调用方按 fail-closed 处理（不回落过时快照）
export function loadTaskPrompt(path) {
  return extractTaskPrompt(readFileSync(path, 'utf8'));
}
