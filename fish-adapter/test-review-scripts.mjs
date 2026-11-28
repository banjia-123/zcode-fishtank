// D6 测试补盲：review 脚本协议级测试（vocab-review / memory-review 的 --list / --apply 机器接口）
// ——这是控制台 spawn 的契约面，恰是审计 P1 最密集区（B4 落盘误报 / C4 锁时序都在这里）。
// 子进程跑真脚本 + fixture 文件，断言退出码 / stdout JSON / 写盘效果。
// 跑法：node test-review-scripts.mjs，退出码 0 = 全过
import './test-setup.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let pass = 0, fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const VOCAB_SCRIPT = fileURLToPath(pathToFileURL(join(HERE, 'vocab-review.mjs')));
const MEMORY_SCRIPT = fileURLToPath(pathToFileURL(join(HERE, 'memory-review.mjs')));

const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60_000 });
const jsonOf = (stdout) => { try { return JSON.parse(stdout.trim().split('\n').at(-1)); } catch { return null; } };

const fx = mkdtempSync(join(tmpdir(), 'fish-rv-'));
try {
  // —— vocab fixture ——
  const vFile = join(fx, 'vocab.json');
  writeFileSync(vFile, JSON.stringify({
    version: 1,
    entries: [
      { word: '测试词', meaning: '义', usage: null, examples: [], status: 'candidate', seenCount: 3, firstSeen: '2026-11-01', source: 'g:1' },
      { word: '已上线词', meaning: '义2', usage: null, examples: [], status: 'confirmed', seenCount: 9, firstSeen: '2026-11-01', source: 'g:1' },
    ],
  }, null, 1), 'utf8');

  // V1 --list：纯读，stdout JSON 结构
  const v1 = run(VOCAB_SCRIPT, ['--file', vFile, '--list', '--json']);
  const j1 = jsonOf(v1.stdout);
  ok(v1.status === 0 && j1?.ok === true && j1.candidates.length === 1 && j1.confirmed.count === 1, 'V1 vocab --list：候选/已上线分列', v1.stdout.slice(0, 120));
  ok(readFileSync(vFile, 'utf8').includes('"candidate"'), 'V1b --list 纯读不写盘');

  // V2 --apply approve：写盘生效（candidate → confirmed）+ results 报 ok
  const pf = join(fx, 'p2.json');
  writeFileSync(pf, '{"items":[{"id":"测试词","action":"approve"}]}', 'utf8');
  const v2 = run(VOCAB_SCRIPT, ['--file', vFile, '--apply', '--json-file', pf]);
  const j2 = jsonOf(v2.stdout);
  ok(v2.status === 0 && j2?.ok === true && j2.results?.[0]?.ok === true, 'V2 vocab --apply approve：结果 ok', v2.stdout.slice(0, 140));
  const after2 = JSON.parse(readFileSync(vFile, 'utf8'));
  ok(after2.entries.find((e) => e.word === '测试词')?.status === 'confirmed', 'V2b 落盘生效：status → confirmed');

  // V3 --apply 未知 id：批内部分失败不回滚
  writeFileSync(pf, '{"items":[{"id":"不存在的词","action":"approve"}]}', 'utf8');
  const v3 = run(VOCAB_SCRIPT, ['--file', vFile, '--apply', '--json-file', pf]);
  const j3 = jsonOf(v3.stdout);
  ok(v3.status === 0 && j3?.results?.[0]?.ok === false && /not found/.test(String(j3.results[0].error)), 'V3 未知 id：批内部分失败（不整批回滚）', v3.stdout.slice(0, 140));

  // V4 坏 JSON：exit 2（控制台按退出码判参数错）
  const v4 = run(VOCAB_SCRIPT, ['--file', vFile, '--apply', '--json', '{bad json']);
  ok(v4.status === 2, 'V4 vocab 坏 payload：exit 2', `status=${v4.status} stderr=${(v4.stderr ?? '').slice(0, 60)}`);

  // V5 空批：ok 且不动盘
  writeFileSync(pf, '{"items":[]}', 'utf8');
  const before5 = readFileSync(vFile, 'utf8');
  const v5 = run(VOCAB_SCRIPT, ['--file', vFile, '--apply', '--json-file', pf]);
  ok(v5.status === 0 && jsonOf(v5.stdout)?.ok === true && readFileSync(vFile, 'utf8') === before5, 'V5 空批：ok 且文件不动');

  // —— memory fixture ——
  const cand = join(fx, 'candidates.md');
  const core = join(fx, 'core.md');
  const candLine = '- [2026-11-01] 某条待审记忆候选';
  writeFileSync(cand, candLine + '\n', 'utf8');
  writeFileSync(core, '- [2026-11-01] 已有记忆\n', 'utf8');
  const rowIdOf = (l) => createHash('sha1').update(l).digest('hex').slice(0, 12);

  // M1 --list
  const m1 = run(MEMORY_SCRIPT, ['--candidates', cand, '--core', core, '--list', '--json']);
  const jm1 = jsonOf(m1.stdout);
  ok(m1.status === 0 && jm1?.ok === true && jm1.items.length === 1 && jm1.items[0].id === rowIdOf(candLine), 'M1 memory --list：id=行 hash 前 12 位', m1.stdout.slice(0, 140));

  // M2 --apply reject：候选行从 candidates.md 删除
  writeFileSync(pf, JSON.stringify({ items: [{ id: rowIdOf(candLine), action: 'reject' }] }), 'utf8');
  const m2 = run(MEMORY_SCRIPT, ['--candidates', cand, '--core', core, '--apply', '--json-file', pf]);
  const jm2 = jsonOf(m2.stdout);
  ok(m2.status === 0 && jm2?.ok === true, 'M2 memory --apply reject：ok', m2.stdout.slice(0, 120));
  ok(!readFileSync(cand, 'utf8').includes(candLine), 'M2b 候选行已从 candidates.md 删除');

  // M3 坏 payload：exit 2
  const m3 = run(MEMORY_SCRIPT, ['--candidates', cand, '--core', core, '--apply', '--json', '{bad']);
  ok(m3.status === 2, 'M3 memory 坏 payload：exit 2', `status=${m3.status}`);

  // —— R 组：roster-review（2026-11-28 名册审校，控制台 spawn 契约面）——
  const ROSTER_SCRIPT = fileURLToPath(pathToFileURL(join(HERE, 'roster-review.mjs')));
  const rFile = join(fx, 'roster.json');
  writeFileSync(rFile, JSON.stringify({
    entries: [
      { uid: '10001', nick: '候选君', activity: 'high', note: '教过吾认图', status: 'candidate', source: '777', firstSeen: '2026-11-27' },
      { uid: '10002', nick: '已转正', activity: 'mid', note: '常在', status: 'confirmed', source: '777', firstSeen: '2026-11-27' },
    ],
  }), 'utf8');

  // R1 --list：纯读分列
  const r1 = run(ROSTER_SCRIPT, ['--file', rFile, '--list', '--json']);
  const jr1 = jsonOf(r1.stdout);
  ok(r1.status === 0 && jr1?.ok === true && jr1.candidates.length === 1 && jr1.candidates[0].id === '10001' && jr1.confirmed.count === 1, 'R1 roster --list：候选/已转正分列', r1.stdout.slice(0, 120));
  ok(readFileSync(rFile, 'utf8').includes('"candidate"'), 'R1b --list 纯读不写盘');

  // R2 --apply confirm：candidate → confirmed
  const rp = join(fx, 'r2.json');
  writeFileSync(rp, JSON.stringify({ items: [{ id: '10001', action: 'confirm' }] }), 'utf8');
  const r2 = run(ROSTER_SCRIPT, ['--file', rFile, '--apply', '--json-file', rp]);
  const jr2 = jsonOf(r2.stdout);
  ok(r2.status === 0 && jr2?.ok === true && jr2.results[0]?.ok === true && jr2.results[0]?.effect === 'confirmed', 'R2 confirm：转正生效', r2.stdout.slice(0, 120));
  ok(readFileSync(rFile, 'utf8').includes('"confirmed"') && readFileSync(rFile, 'utf8').includes('候选君'), 'R2b 落盘：status 已改 + 内容保留');
  ok(readFileSync(rFile + '.bak', 'utf8').includes('"candidate"'), 'R2c 首写前 .bak 备份');

  // R3 --apply 动作防串（重置 fixture：candidate 10001/10003 + confirmed 10002）
  writeFileSync(rFile, JSON.stringify({
    entries: [
      { uid: '10001', nick: '候选甲', activity: 'high', note: 'a', status: 'candidate', source: '777', firstSeen: '2026-11-27' },
      { uid: '10003', nick: '候选丙', activity: 'low', note: 'c', status: 'candidate', source: '777', firstSeen: '2026-11-28' },
      { uid: '10002', nick: '已转正', activity: 'mid', note: '常在', status: 'confirmed', source: '777', firstSeen: '2026-11-27' },
    ],
  }), 'utf8');
  const rp3 = join(fx, 'r3.json');
  writeFileSync(rp3, JSON.stringify({ items: [{ id: '10002', action: 'reject' }, { id: '10001', action: 'remove' }] }), 'utf8');
  const r3 = run(ROSTER_SCRIPT, ['--file', rFile, '--apply', '--json-file', rp3]);
  const jr3 = jsonOf(r3.stdout);
  ok(r3.status === 0 && jr3?.ok === true && jr3.results.every((x) => !x.ok) && /下架请用 remove/.test(jr3.results[0].error), 'R3a reject 对 confirmed 拒绝（防串）', r3.stdout.slice(0, 140));
  ok(/驳回请用 reject/.test(jr3.results[1].error), 'R3b remove 对 candidate 拒绝');

  // R4 同 payload 重复 id → "id not found"（seen 语义，沿袭 vocab-review 同款）
  const rp4 = join(fx, 'r4.json');
  writeFileSync(rp4, JSON.stringify({ items: [{ id: '10001', action: 'confirm' }, { id: '10001', action: 'confirm' }] }), 'utf8');
  const r4 = run(ROSTER_SCRIPT, ['--file', rFile, '--apply', '--json-file', rp4]);
  const jr4 = jsonOf(r4.stdout);
  ok(r4.status === 0 && jr4.results[0]?.ok && jr4.results[1]?.error === 'id not found', 'R4 同 payload 重复 id 报 seen 错', r4.stdout.slice(0, 140));
  // R4b 跨 payload 幂等：对已转正条目再 confirm → noop（R3 fixture 里 10001 已被 R4 confirm）
  const rp4b = join(fx, 'r4b.json');
  writeFileSync(rp4b, JSON.stringify({ items: [{ id: '10001', action: 'confirm' }] }), 'utf8');
  const r4b = run(ROSTER_SCRIPT, ['--file', rFile, '--apply', '--json-file', rp4b]);
  const jr4b = jsonOf(r4b.stdout);
  ok(r4b.status === 0 && jr4b.results[0]?.effect === 'noop', 'R4b 跨 payload 重复 confirm 幂等 noop', r4b.stdout.slice(0, 100));
  // R4c remove：下架已转正（删除提案闭环用）——10002 是 confirmed
  const rp4c = join(fx, 'r4c.json');
  writeFileSync(rp4c, JSON.stringify({ items: [{ id: '10002', action: 'remove' }] }), 'utf8');
  const r4c = run(ROSTER_SCRIPT, ['--file', rFile, '--apply', '--json-file', rp4c]);
  const jr4c = jsonOf(r4c.stdout);
  ok(r4c.status === 0 && jr4c.results[0]?.effect === 'removed' && !readFileSync(rFile, 'utf8').includes('已转正'), 'R4c remove：下架删除生效');

  // R5 坏 roster.json：fail-closed exit 1 + 不写盘
  writeFileSync(rFile, '{broken', 'utf8');
  const rp5 = join(fx, 'r5.json');
  writeFileSync(rp5, JSON.stringify({ items: [{ id: '1', action: 'confirm' }] }), 'utf8');
  const r5 = run(ROSTER_SCRIPT, ['--file', rFile, '--apply', '--json-file', rp5]);
  ok(r5.status === 1 && /校验失败/.test(r5.stdout), 'R5 坏文件拒审 fail-closed（outJson→stdout）', `status=${r5.status}`);

  // R6 无模式参数：用法提示 exit 2
  const r6 = run(ROSTER_SCRIPT, ['--file', rFile]);
  ok(r6.status === 2 && /用法/.test(r6.stderr), 'R6 无模式参数 → 用法提示 exit 2', `status=${r6.status}`);

  // R7 数字 uid 手改场景：fail-closed 拒审（loadRoster 校验 uid 必须字符串——坏数据修源，不静默归一）
  writeFileSync(rFile, JSON.stringify({
    entries: [{ uid: 20001, nick: '数字uid群友', activity: 'mid', note: 'x', status: 'candidate', source: '777', firstSeen: '2026-11-28' }],
  }), 'utf8');
  const rp7 = join(fx, 'r7.json');
  writeFileSync(rp7, JSON.stringify({ items: [{ id: '20001', action: 'confirm' }] }), 'utf8');
  const r7r = run(ROSTER_SCRIPT, ['--file', rFile, '--apply', '--json-file', rp7]);
  const jr7 = jsonOf(r7r.stdout);
  ok(r7r.status === 1 && jr7?.ok === false && /字段异常/.test(jr7.error ?? ''), 'R7 数字 uid fail-closed 拒审（uid 必须字符串）', r7r.stdout.slice(0, 120));
} finally {
  try { rmSync(fx, { recursive: true, force: true }); } catch { /* 临时目录 */ }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
