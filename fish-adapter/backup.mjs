#!/usr/bin/env node
// 鱼塘数据备份（2026-11-28）：全量快照 —— 硬盘坏 = 记忆清零的最后防线
// 节奏：人工触发（2026-11-28 用户裁决撤掉每日任务计划）——控制台「立即备份」/ 双击 备份.cmd；
//       控制台状态行显示"距上次备份 N 天"（≥3 天警示色）作为忘记防线。想恢复自动随时 --install
// 用法：
//   node backup.mjs --run [--json] [--dest <dir>]  打包当日快照 + 轮转（--json 供控制台 spawn）
//   node backup.mjs --status [--json]              列出目的地快照清单
//   node backup.mjs --install                      注册系统任务计划（每日 04:30，静默时段内）
// 设计：纯 copyFileSync 递归收集（不依赖 robocopy/zip——robocopy 退出码 1=成功是 Windows 脚本坑）；
//       资产 ~9M 每日全量无压力，不需要增量；白名单式收集（列出什么备什么，天然排除缓存与密钥）。
// 密钥纪律：config.json 与 fish-adapter/backups/（config 的密钥副本）**明确不备**（2026-11-28 用户裁决）——
//       盘坏后重配 token 约 5 分钟，密钥不落第二处。排除清单是裁决记录，不是遗漏。
// 恢复：见 fish-adapter/README「备份与恢复」——游标文件必须与 chat.jsonl 成对恢复（错位=学习进度漂移）。
// 测试：FISH_ADAPTER_ROOT / FISH_BACKUP_DEST 两个环境变量均可注入（test-backup.mjs 用 mkdtemp 隔离）。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT_DIR, log } from './lib/util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = dirname(ROOT_DIR); // 部署布局：fish-adapter 直接在工作区下（adapter.mjs PKG_ROOT 同款推导）
const FISHPOND = join(WORKSPACE, 'fishpond');
const DEST = process.env.FISH_BACKUP_DEST ?? resolve(WORKSPACE, 'fishpond-backup');
const KEEP = 14;
const TASK_NAME = 'zcode-fishtank-backup';
const T0 = Date.now();

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const destIdx = args.indexOf('--dest');
if (destIdx >= 0 && args[destIdx + 1]) { /* --dest 覆盖 DEST（env 优先级低） */ }
const DEST_OVERRIDE = destIdx >= 0 && args[destIdx + 1] ? resolve(args[destIdx + 1]) : null;
const DEST_FINAL = DEST_OVERRIDE ?? DEST;

// ── 收集规则（白名单）：relKey 是快照内相对路径 ──────────────────────────────
// fishpond：记忆/人格/日记/表情/聊天史/便签 —— 鱼的全部资产
// fish-adapter/logs：只收"留痕本体"（rotate.mjs 红线标注），不收可丢失大日志（adapter.log/wake-trace）
const COLLECT = [
  { dir: join(FISHPOND, 'memory'), rel: 'fishpond/memory' },       // core/candidates/vocab/roster/游标/queue/.bak/.prev
  { dir: join(FISHPOND, 'diary'), rel: 'fishpond/diary' },         // 每日日记
  { dir: join(FISHPOND, 'emojis'), rel: 'fishpond/emojis' },       // 表情库 + index.json（体积大头 7.7M）
  { dir: join(FISHPOND, 'logs'), rel: 'fishpond/logs' },           // chat.jsonl 聊天史 / speak.jsonl 冷却+统计源
  { dir: join(FISHPOND, 'state'), rel: 'fishpond/state' },         // peers 便签（首建前不存在，按存在收集）
  { dir: join(FISHPOND, 'automation'), rel: 'fishpond/automation' },
  { files: ['persona.md', '.learner-prompt.md', '.diary-prompt.md'], base: FISHPOND, rel: 'fishpond' },
  { files: ['wake.jsonl', 'audit.log', 'sessions.jsonl', 'diary-deleted.jsonl', 'chat-test.jsonl'], base: join(ROOT_DIR, 'logs'), rel: 'fish-adapter/logs' },
];
// 白名单外一律不收：attachments/.inbox/.outbox/.zcode（短缓存）、adapter.log/wake-trace.jsonl（可丢大日志）、
// config.json 与 fish-adapter/backups/（密钥副本——用户裁决不备，见头注释）

function walkCollect(dir, rel, out) {
  let items;
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; } // 目录不存在=未启用，静默跳过
  for (const it of items) {
    const src = join(dir, it.name);
    const relPath = `${rel}/${it.name}`;
    if (it.isDirectory()) walkCollect(src, relPath, out);
    else out.push({ src, rel: relPath });
  }
}

function collectFiles() {
  const out = [];
  for (const c of COLLECT) {
    if (c.dir) walkCollect(c.dir, c.rel, out);
    else for (const f of c.files) {
      const src = join(c.base, f);
      if (existsSync(src)) out.push({ src, rel: `${c.rel}/${f}` });
    }
  }
  return out;
}

// --list：只列收集清单不写盘（运维自检"到底会备哪些"+ 排除面确认）
function doList() {
  const files = collectFiles();
  const total = files.reduce((a, f) => a + statSync(f.src).size, 0);
  if (asJson) console.log(JSON.stringify({ ok: true, files: files.map((f) => f.rel), totalBytes: total }));
  else console.log(files.map((f) => `${f.rel}  (${statSync(f.src).size}B)`).join('\n') + `\n共 ${files.length} 文件 ${total} 字节`);
}

function snapshotDirOf(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return join(DEST_FINAL, `backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`);
}

function pruneOld() {
  let names;
  try { names = readdirSync(DEST_FINAL).filter((n) => /^backup-\d{4}-\d{2}-\d{2}$/.test(n)).sort(); } catch { return []; }
  const pruned = [];
  while (names.length > KEEP) {
    const oldest = names.shift();
    try { rmSync(join(DEST_FINAL, oldest), { recursive: true, force: true }); pruned.push(oldest); } catch { /* 占用则下轮再删 */ }
  }
  return pruned;
}

function doRun() {
  const files = collectFiles();
  if (!files.length) {
    const msg = `没有可备份的文件（FISHPOND=${FISHPOND} 不存在？）`;
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error('[中止] ' + msg);
    process.exit(1);
  }
  const snapDir = snapshotDirOf();
  rmSync(snapDir, { recursive: true, force: true }); // 同日幂等：先删当日再重建（chat.jsonl 当天有新增）
  mkdirSync(snapDir, { recursive: true });
  const manifest = [];
  let total = 0;
  for (const { src, rel } of files) {
    const dst = join(snapDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    const bytes = statSync(src).size;
    manifest.push({ rel, bytes });
    total += bytes;
  }
  writeFileSync(join(snapDir, 'manifest.json'), JSON.stringify({
    ts: new Date().toISOString(), files: manifest, totalBytes: total, count: manifest.length,
  }, null, 1), 'utf8');
  const pruned = pruneOld();
  const result = {
    ok: true, snapshot: snapDir, files: manifest.length, totalBytes: total,
    pruned, kept: readdirSync(DEST_FINAL).filter((n) => /^backup-/.test(n)).length,
    ms: Date.now() - T0,
  };
  // --json 模式 stdout 必须是纯 JSON（控制台 spawn 契约）——人读日志仅非 json 模式打
  if (!asJson) log('backup', `快照完成：${manifest.length} 文件 ${total} 字节 → ${snapDir}${pruned.length ? `（清理 ${pruned.length} 份旧快照）` : ''}`);
  if (asJson) console.log(JSON.stringify(result));
  else {
    console.log(`✓ 备份完成 → ${snapDir}`);
    console.log(`  ${manifest.length} 个文件 · ${total} 字节 · 保留 ${result.kept} 份`);
    if (pruned.length) console.log(`  已清理旧快照：${pruned.join(', ')}`);
  }
}

function doStatus() {
  let names;
  try { names = readdirSync(DEST_FINAL).filter((n) => /^backup-\d{4}-\d{2}-\d{2}$/.test(n)).sort(); } catch { names = []; }
  const snaps = names.map((n) => {
    const dir = join(DEST_FINAL, n);
    let bytes = 0, count = 0;
    try {
      const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      bytes = m.totalBytes; count = m.count;
    } catch { /* 无 manifest 的旧式目录 */ }
    return { snapshot: n, dir, bytes, count, mtime: statSync(dir).mtime.toISOString() };
  });
  if (asJson) console.log(JSON.stringify({ ok: true, dest: DEST_FINAL, keep: KEEP, snapshots: snaps }));
  else console.log(snaps.length ? snaps.map((s) => `${s.snapshot}  ${s.count} 文件 ${s.bytes}B`).join('\n') : '(还没有快照)');
}

function doUninstall() {
  const r = spawnSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`[失败] schtasks 删除失败（status=${r.status}）：${String(r.stderr || r.stdout).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`✓ 任务计划已删除：${TASK_NAME}——备份改为人工节奏（控制台「立即备份」/ 双击 备份.cmd）`);
}

function doInstall() {
  // 任务计划指向 备份.cmd（%~dp0 自定位中文路径；cmd 内容纯 ASCII——PowerShell 无 BOM 坑同款纪律）
  const cmdFile = join(HERE, '备份.cmd');
  const tr = `"${cmdFile}"`;
  const r = spawnSync('schtasks', ['/Create', '/TN', TASK_NAME, '/SC', 'DAILY', '/ST', '04:30', '/F', '/TR', tr], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`[失败] schtasks 注册失败（status=${r.status}）：${String(r.stderr || r.stdout).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`✓ 任务计划已注册：${TASK_NAME}（每日 04:30 → ${cmdFile}）`);
  console.log('  验证：schtasks /Query /TN ' + TASK_NAME);
}

if (args.includes('--list')) { doList(); process.exit(0); }
if (args.includes('--run')) { doRun(); process.exit(0); }
if (args.includes('--status')) { doStatus(); process.exit(0); }
if (args.includes('--install')) { doInstall(); process.exit(0); }
if (args.includes('--uninstall')) { doUninstall(); process.exit(0); }
console.error('[用法] backup.mjs --run [--json] [--dest <dir>] | --status [--json] | --install | --uninstall');
process.exit(2);
