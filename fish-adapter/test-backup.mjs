// 备份脚本协议测试（2026-11-28）：--run 打包/排除/幂等/轮转 + --status 契约
// ——backup.mjs 是最后防线，坏在静默处比没有更糟（以为有备份其实空的）。
// fixture：FISH_ADAPTER_ROOT 指向 mkdtemp（backup.mjs 从 ROOT_DIR 推 fishpond 兄弟目录），
// FISH_BACKUP_DEST 指向另一 mkdtemp；子进程跑真脚本，断言快照内容/manifest/轮转。
// 跑法：node test-backup.mjs，退出码 0 = 全过
import './test-setup.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let pass = 0, fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = fileURLToPath(pathToFileURL(join(HERE, 'backup.mjs')));

const ws = mkdtempSync(join(tmpdir(), 'fish-bk-ws-')); // 伪工作区：ws/fish-adapter（ROOT）+ ws/fishpond
const dest = mkdtempSync(join(tmpdir(), 'fish-bk-dest-'));
const ROOT = join(ws, 'fish-adapter');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
mkdirSync(join(ws, 'fishpond', 'memory'), { recursive: true });
mkdirSync(join(ws, 'fishpond', 'diary'), { recursive: true });
mkdirSync(join(ws, 'fishpond', 'logs'), { recursive: true });
mkdirSync(join(ws, 'fishpond', 'emojis'), { recursive: true });
mkdirSync(join(ws, 'fishpond', 'attachments'), { recursive: true }); // 排除对象

const w = (rel, body = 'x') => { const p = join(ws, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body, 'utf8'); };
w('fishpond/memory/core.md', '记忆内容');
w('fishpond/memory/.learner-cursor', '2484');
w('fishpond/memory/vocab.json', '{"entries":[]}');
w('fishpond/persona.md', '# 人格');
w('fishpond/diary/2026-11-28.md', '# 日记');
w('fishpond/logs/chat.jsonl', '聊天史'.repeat(100));
w('fishpond/logs/speak.jsonl', '{"emoji":"a.png"}');
w('fishpond/emojis/a.png', 'pngdata');
w('fishpond/attachments/junk.png', 'cache'); // 排除对象
w('fish-adapter/logs/wake.jsonl', '账本');
w('fish-adapter/logs/adapter.log', '大日志'); // 排除对象
w('fish-adapter/config.json', '{"token":"secret"}'); // 排除对象（密钥裁决）
w('fish-adapter/backups/config-1.json', '{"token":"secret"}'); // 排除对象（密钥副本）

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
  encoding: 'utf8', timeout: 60_000,
  env: { ...process.env, FISH_ADAPTER_ROOT: ROOT, FISH_BACKUP_DEST: dest },
});
const jsonOf = (stdout) => { try { return JSON.parse(stdout.trim().split('\n').at(-1)); } catch { return null; } };

try {
  // B1 --run --json：打包齐全 + manifest 统计
  const r1 = run(['--run', '--json']);
  const j1 = jsonOf(r1.stdout);
  const snap = j1?.snapshot;
  ok(r1.status === 0 && j1?.ok === true && !!snap, 'B1 --run 退出 0 且返回快照路径', r1.stdout.slice(0, 120));
  ok(existsSync(join(snap, 'fishpond/memory/core.md')) && existsSync(join(snap, 'fishpond/logs/chat.jsonl'))
    && existsSync(join(snap, 'fishpond/emojis/a.png')) && existsSync(join(snap, 'fishpond/persona.md'))
    && existsSync(join(snap, 'fishpond/diary/2026-11-28.md')) && existsSync(join(snap, 'fish-adapter/logs/wake.jsonl')),
    'B1b 白名单文件全部入库（memory/聊天史/表情/persona/日记/账本）');
  const man = JSON.parse(readFileSync(join(snap, 'manifest.json'), 'utf8'));
  ok(man.count === j1.files && man.totalBytes === j1.totalBytes && man.totalBytes > 0, 'B1c manifest 与返回统计一致', JSON.stringify({ c: man.count, t: man.totalBytes }));

  // B2 排除：缓存/密钥类一个都不许进快照
  ok(!existsSync(join(snap, 'fishpond/attachments/junk.png')), 'B2a attachments（短缓存）不入库');
  ok(!existsSync(join(snap, 'fish-adapter/config.json')) && !existsSync(join(snap, 'fish-adapter/backups')), 'B2b config.json 与 backups/（密钥）不入库——用户裁决');
  ok(!existsSync(join(snap, 'fish-adapter/logs/adapter.log')), 'B2c adapter.log（可丢大日志）不入库');

  // B3 同日幂等：改源再跑，当日快照内容更新（先删后建）
  w('fishpond/memory/core.md', '记忆内容v2');
  const r3 = run(['--run', '--json']);
  const j3 = jsonOf(r3.stdout);
  ok(r3.status === 0 && j3.snapshot === snap && readFileSync(join(snap, 'fishpond/memory/core.md'), 'utf8') === '记忆内容v2', 'B3 同日重跑覆盖当日快照（幂等）');

  // B4 轮转：15 份旧快照 + 当日 → 保留 14，最旧被删
  for (let d = 1; d <= 15; d++) mkdirSync(join(dest, `backup-2026-01-${String(d).padStart(2, '0')}`), { recursive: true });
  const r4 = run(['--run', '--json']);
  const j4 = jsonOf(r4.stdout);
  const left = j4.kept;
  const oldestGone = !existsSync(join(dest, 'backup-2026-01-01'));
  ok(r4.status === 0 && left === 14 && oldestGone, 'B4 轮转保留 14 份删最旧', `kept=${left}`);

  // B5 --status --json：清单结构
  const r5 = run(['--status', '--json']);
  const j5 = jsonOf(r5.stdout);
  ok(r5.status === 0 && j5?.ok === true && j5.dest === dest && Array.isArray(j5.snapshots) && j5.snapshots.length === 14
    && j5.snapshots.every((x) => /^backup-\d{4}-\d{2}-\d{2}$/.test(x.snapshot) && typeof x.bytes === 'number'),
    'B5 --status：快照清单结构（dest/keep/snapshots）', r5.stdout.slice(0, 120));
} finally {
  try { rmSync(ws, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  try { rmSync(dest, { recursive: true, force: true }); } catch { /* 临时目录 */ }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
