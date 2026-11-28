#!/usr/bin/env node
// 名册审校（非交互，控制台 spawn 专用）——roster.json 的人工确认闸门
// 与 vocab-review / memory-review 对齐的控制台契约：
//   --list --json（纯读）→ {ok, candidates:[], confirmed:{count, items}}
//   --apply --json-file <path> → items:[{id:"<uid>", action:"confirm|reject|remove"}]
//     confirm = candidate → confirmed（转正，下一轮唤醒即注入）/ reject = 删候选 / remove = 下架已转正
//     reject 与 remove 不可互串（防误把已转正条目当候选删掉）；id=uid（名单唯一键，learner 只追加不在册 uid）
// 交互模式不做：控制台审阅页是主入口，紧急情况手改 roster.json 亦可（mtime 缓存即时生效）
// 无名额红线：注入侧按群 8 人截断（wake/prompt.mjs renderRoster），confirmed 总量不设上限
// 安全：与 vocab/memory 同一把审校锁；首次写盘前自动备份 .bak；写盘前 JSON 自校验；坏文件拒审 fail-closed
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logOp } from './lib/ops-log.mjs';
import { acquireLock, releaseLock } from './lib/review-lock.mjs';
import { outJson, parseApplyPayload } from './lib/review-common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = resolve(HERE, '../fishpond/memory/roster.json');
const T0 = Date.now();

const args = process.argv.slice(2);
let FILE = DEFAULT_FILE;
const fi = args.indexOf('--file');
if (fi >= 0 && args[fi + 1]) FILE = resolve(args[fi + 1]);

const loadRoster = () => {
  const d = JSON.parse(readFileSync(FILE, 'utf8'));
  if (!Array.isArray(d.entries)) throw new Error('entries 不是数组');
  for (const e of d.entries) {
    if (typeof e.uid !== 'string' || typeof e.status !== 'string') throw new Error('存在字段异常的条目（uid/status 缺失）');
  }
  return d;
};

const brief = (e) => ({
  id: e.uid, nick: e.nick ?? null, activity: e.activity ?? null, note: e.note ?? null,
  status: e.status, source: e.source ?? null, firstSeen: e.firstSeen ?? null,
});
const byFirstSeen = (a, b) => String(a.firstSeen ?? '').localeCompare(String(b.firstSeen ?? ''));

if (args.includes('--list')) {
  // 纯读：绝不写盘、不备份、不上锁。文件缺失 = 名册还没建，空表不是错误
  let data = { entries: [] };
  try { data = loadRoster(); } catch (e) {
    if (e.code !== 'ENOENT') outJson(1, { ok: false, error: `roster.json 读取/校验失败：${e.message}` });
  }
  const conf = data.entries.filter((e) => e.status === 'confirmed').sort(byFirstSeen);
  outJson(0, {
    ok: true,
    candidates: data.entries.filter((e) => e.status !== 'confirmed').sort(byFirstSeen).map(brief),
    confirmed: { count: conf.length, items: conf.map(brief) },
  });
}

if (args.includes('--apply')) {
  let payload;
  try {
    payload = parseApplyPayload(args, ['confirm', 'reject', 'remove']);
  } catch (e) {
    console.error(`[参数] --apply 需要 --json-file <路径>，items:[{"id":"<uid>","action":"confirm|reject|remove"}]。${e.message}`);
    process.exit(2);
  }
  const lockErr = acquireLock();
  if (lockErr) { console.error(`[锁] ${lockErr}`); process.exit(2); }
  let data;
  try { data = loadRoster(); } catch (e) {
    releaseLock();
    logOp('review.roster', false, { err: e.message, ms: Date.now() - T0 });
    outJson(1, { ok: false, error: `roster.json 读取/校验失败：${e.message}` });
  }
  const results = [];
  const seen = new Set();
  let dirty = false;
  for (const it of payload.items) {
    const e = data.entries.find((x) => x.uid === it.id);
    if (seen.has(it.id) || !e) { results.push({ id: it.id, ok: false, error: 'id not found' }); continue; }
    seen.add(it.id);
    if (it.action === 'confirm') {
      if (e.status === 'confirmed') { results.push({ id: it.id, ok: true, effect: 'noop' }); continue; } // 幂等
      e.status = 'confirmed';
      dirty = true;
      results.push({ id: it.id, ok: true, effect: 'confirmed' });
    } else if (it.action === 'reject') {
      if (e.status === 'confirmed') { results.push({ id: it.id, ok: false, error: '这是已转正条目，下架请用 remove' }); continue; }
      data.entries.splice(data.entries.indexOf(e), 1);
      dirty = true;
      results.push({ id: it.id, ok: true, effect: 'removed' });
    } else { // remove
      if (e.status !== 'confirmed') { results.push({ id: it.id, ok: false, error: '这是候选条目，驳回请用 reject' }); continue; }
      data.entries.splice(data.entries.indexOf(e), 1);
      dirty = true;
      results.push({ id: it.id, ok: true, effect: 'removed' });
    }
  }
  let backup = null;
  if (dirty) {
    try {
      copyFileSync(FILE, FILE + '.bak');
      const body = data.entries.map((e) => '  ' + JSON.stringify(e)).join(',\n');
      const out = `{\n${data.version != null ? ` "version": ${data.version},\n` : ''} "entries": [\n${body}\n ]\n}`; // 保留文件里可能存在的其他顶层字段
      JSON.parse(out); // 自校验：写出去的必须仍是合法 JSON
      writeFileSync(FILE, out, 'utf8');
      backup = FILE + '.bak';
    } catch (e) {
      releaseLock();
      logOp('review.roster', false, { stage: 'write', err: e.message, ms: Date.now() - T0 });
      outJson(1, { ok: false, error: `写盘失败：${e.message}` });
    }
  }
  releaseLock();
  logOp('review.roster', true, {
    ms: Date.now() - T0,
    detail: { applied: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, backup },
  });
  outJson(0, { ok: true, results, backup });
}

// 两个模式都没给 → 用法提示（exit 2，控制台会当脚本失败显示 stderr）
console.error('[用法] roster-review.mjs --list --json | --apply --json-file <path>（items:[{id, action: confirm|reject|remove}]）');
process.exit(2);
