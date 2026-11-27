#!/usr/bin/env node
// 鱼缸行话审校（交互）——vocab.json 的人工确认闸门
// 用法：双击 审词库.cmd，或 node vocab-review.mjs [--file <vocab.json 路径>]
//       非交互（控制台 spawn 用）：--list --json（纯读列候选+已上线）/ --apply --json '{"items":[{"id":"<词>","action":"approve|reject|retire"}]}'
//       （cmd 手测 --json 的引号会被 shell 吃掉时用 --json-file <路径> 代替）
// 模式：[1] 审候选词（转正/驳回）　[2] 复审已上线词（下架过气词腾名额）
// 规则：转正 = status→confirmed + 例句砍到 1~2 条；驳回/下架 = 整条删除（备份留底）；
//       confirmed 名额 ≤20（信箱任务书只取前 20 条 confirmed，超员尾部读不到）
// 安全：启动即校验 JSON（坏文件拒审，fail-closed）；首次写盘前自动备份 .bak；
//       每条决定即时落盘，中途断电/退出已审的不丢；写盘前 JSON 自校验
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdout, exit } from 'node:process';
import { logOp } from './lib/ops-log.mjs';
import { acquireLock, releaseLock } from './lib/review-lock.mjs';
import { outJson, parseApplyPayload, createLineQueue } from './lib/review-common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = resolve(HERE, '../fishpond/memory/vocab.json');
const MAX_CONFIRMED = 20;
const T0 = Date.now();

const args = process.argv.slice(2);
let FILE = DEFAULT_FILE;
const fi = args.indexOf('--file');
if (fi >= 0 && args[fi + 1]) FILE = resolve(args[fi + 1]);

// ── 非交互模式（控制台 spawn）：--list 纯读 / --apply 批量裁决，与下方交互流程互斥 ──
if (args.includes('--list') || args.includes('--apply')) {
  // outJson / parseApplyPayload / 行队列：lib/review-common（与 memory-review 共享，D5 收敛）
  const loadVocab = () => {
    const d = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!Array.isArray(d.entries)) throw new Error('entries 不是数组');
    for (const e of d.entries) {
      if (typeof e.word !== 'string' || typeof e.status !== 'string') throw new Error('存在字段异常的词条（word/status 缺失）');
    }
    return d;
  };

  if (args.includes('--list')) {
    // 纯读：绝不写盘、不备份、不上锁。文件缺失 = 词库还没建，空表不是错误
    let data = { version: 1, entries: [] };
    try { data = loadVocab(); } catch (e) {
      if (e.code !== 'ENOENT') outJson(1, { ok: false, error: `vocab.json 读取/校验失败：${e.message}` });
    }
    const hot = (a, b) => (b.seenCount ?? 0) - (a.seenCount ?? 0) || String(a.firstSeen ?? '').localeCompare(String(b.firstSeen ?? ''));
    const brief = (e) => ({
      id: e.word, meaning: e.meaning ?? null, usage: e.usage ?? null,
      examples: Array.isArray(e.examples) ? e.examples : [],
      status: e.status, seenCount: e.seenCount ?? 0, firstSeen: e.firstSeen ?? null, source: e.source ?? null,
    });
    const conf = data.entries.filter((e) => e.status === 'confirmed').sort(hot);
    outJson(0, {
      ok: true,
      candidates: data.entries.filter((e) => e.status !== 'confirmed').sort(hot).map(brief),
      confirmed: { count: conf.length, max: MAX_CONFIRMED, items: conf.map(brief) },
    });
  }

  // --apply：approve=转正（例句砍到 2 条）/ reject=驳回候选 / retire=下架已上线词
  //   reject 与 retire 不可互串（防误把已上线词当候选删掉）；id=word；批内可部分失败
  let payload;
  try {
    payload = parseApplyPayload(args, ['approve', 'reject', 'retire']);
  } catch (e) {
    console.error(`[参数] --apply 需要 --json '{"items":[{"id":"<词>","action":"approve|reject|retire"}]}'（或 --json-file 路径）。${e.message}`);
    exit(2);
  }
  const lockErr = acquireLock();
  if (lockErr) { console.error(`[锁] ${lockErr}`); exit(2); }
  // C4：锁内读最新数据——原先锁前读，两个并发 --apply 都拿同一份旧数据先后持锁写盘，
  // 先到者的裁决被后到者的旧数据整体覆盖（双方 results 还各自报 ok）
  let data;
  try { data = loadVocab(); } catch (e) {
    releaseLock();
    logOp('review.vocab', false, { err: e.message, ms: Date.now() - T0 });
    outJson(1, { ok: false, error: `vocab.json 读取/校验失败：${e.message}` });
  }
  const results = [];
  const seen = new Set();
  let dirty = false;
  const confirmedCount = () => data.entries.filter((x) => x.status === 'confirmed').length;
  for (const it of payload.items) {
    const e = data.entries.find((x) => x.word === it.id);
    if (seen.has(it.id) || !e) { results.push({ id: it.id, ok: false, error: 'id not found' }); continue; }
    seen.add(it.id);
    if (it.action === 'approve') {
      if (e.status === 'confirmed') { results.push({ id: it.id, ok: true, effect: 'noop' }); continue; } // 幂等：重复批已上线词
      if (confirmedCount() + 1 > MAX_CONFIRMED) {
        results.push({ id: it.id, ok: false, error: `quota-full：confirmed ${confirmedCount()}/${MAX_CONFIRMED}，先 retire 腾名额再转正` }); continue;
      }
      e.status = 'confirmed';
      e.examples = (Array.isArray(e.examples) ? e.examples : []).slice(0, 2);
      dirty = true;
      results.push({ id: it.id, ok: true, effect: 'confirmed' });
    } else if (it.action === 'reject') {
      if (e.status === 'confirmed') { results.push({ id: it.id, ok: false, error: '这是已上线词，下架请用 retire' }); continue; }
      data.entries.splice(data.entries.indexOf(e), 1);
      dirty = true;
      results.push({ id: it.id, ok: true, effect: 'removed' });
    } else { // retire
      if (e.status !== 'confirmed') { results.push({ id: it.id, ok: false, error: '这是候选词，驳回请用 reject' }); continue; }
      data.entries.splice(data.entries.indexOf(e), 1);
      dirty = true;
      results.push({ id: it.id, ok: true, effect: 'retired' });
    }
  }
  let backup = null;
  if (dirty) {
    try {
      copyFileSync(FILE, FILE + '.bak');
      const body = data.entries.map((e) => '  ' + JSON.stringify(e)).join(',\n');
      const out = `{\n "version": ${data.version ?? 1},\n "entries": [\n${body}\n ]\n}`;
      JSON.parse(out); // 自校验：写出去的必须仍是合法 JSON（与交互模式 persist 同款）
      writeFileSync(FILE, out, 'utf8');
      backup = FILE + '.bak';
    } catch (e) {
      releaseLock();
      logOp('review.vocab', false, { stage: 'write', err: e.message, ms: Date.now() - T0 });
      outJson(1, { ok: false, error: `写盘失败：${e.message}` });
    }
  }
  releaseLock();
  logOp('review.vocab', true, {
    ms: Date.now() - T0,
    detail: { applied: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, backup },
  });
  outJson(0, { ok: true, results, backup });
}

// ── 读取 + fail-closed 校验 ─────────────────────────────
let data;
try {
  const raw = readFileSync(FILE, 'utf8');
  data = JSON.parse(raw);
  if (!Array.isArray(data.entries)) throw new Error('entries 不是数组');
  for (const e of data.entries) {
    if (typeof e.word !== 'string' || typeof e.status !== 'string') {
      throw new Error(`存在字段异常的词条（word/status 缺失）`);
    }
  }
} catch (e) {
  console.error(`[中止] vocab.json 读取/校验失败：${e.message}`);
  console.error('       文件可能被改坏——先修复 JSON 再来审，本脚本未做任何修改。');
  logOp('review.vocab', false, { err: e.message, ms: Date.now() - T0 });
  exit(1);
}

const byHot = (a, b) => (b.seenCount ?? 0) - (a.seenCount ?? 0) || String(a.firstSeen ?? '').localeCompare(String(b.firstSeen ?? ''));
const candidates = data.entries.filter((e) => e.status !== 'confirmed').sort(byHot);
const confirmedList = data.entries.filter((e) => e.status === 'confirmed').sort(byHot);
const baseConfirmed = confirmedList.length;

console.log('=== 鱼缸行话审校 ===');
console.log(`库文件：${FILE}`);
console.log(`confirmed ${baseConfirmed}/${MAX_CONFIRMED} · 候选 ${candidates.length} 条（按热度排序）`);
if (!candidates.length && !confirmedList.length) {
  console.log('\n词库还是空的——等学习任务攒出候选再来。收工 🐟');
  exit(0);
}

// 自维护行队列（lib/review-common，与 memory-review 共享）：粘贴多行不丢行、
// EOF 时挂起的 ask 立即失败（已审数据均已落盘）；eofErrOf() 供主循环区分输入中断与写盘失败
const { rl, ask, eofErr: eofErrOf } = createLineQueue();
let confirmed = 0, rejected = 0, skipped = 0, retired = 0, kept = 0, saved = false;

const persist = () => {
  if (!saved) { copyFileSync(FILE, FILE + '.bak'); saved = true; } // 首次写盘前备份
  const body = data.entries.map((e) => '  ' + JSON.stringify(e)).join(',\n');
  const out = `{\n "version": ${data.version ?? 1},\n "entries": [\n${body}\n ]\n}`;
  JSON.parse(out); // 自校验：写出去的必须仍是合法 JSON
  writeFileSync(FILE, out, 'utf8');
};

const printWord = (e) => {
  console.log(`── ${e.word} ${'─'.repeat(Math.max(4, 44 - e.word.length * 2))}`);
  console.log(`含义：${e.meaning ?? '(无)'}`);
  console.log(`用法：${e.usage ?? '(无)'}`);
  const exs = Array.isArray(e.examples) ? e.examples : [];
  exs.forEach((x, k) => console.log(`${k === 0 ? '例句' : '    '}：· ${x}`));
  console.log(`热度：出现 ${e.seenCount ?? '?'} 次 · 首见 ${e.firstSeen ?? '?'} · 来源群 ${e.source ?? '?'}`);
};

// ── 主菜单：审候选 / 复审已上线 ──────────────────────────
let mode;
if (!candidates.length) {
  mode = '2';
  console.log('\n（没有待审候选，直接进入复审已上线词模式）');
} else {
  mode = null;
  try {
    while (mode === null) {
      stdout.write('\n[1]审候选词 [2]复审已上线词（下架过气词腾名额） [q]退出 > ');
      const ans = (await ask('')).trim().toLowerCase();
      if (ans === '1' || ans === '2') mode = ans;
      else if (ans === 'q') { console.log('收工 🐟'); exit(0); }
      else console.log('  请输入 1 / 2 / q');
    }
  } catch (e) { // EOF 修复：主菜单原在 try 块外，管道 stdin 一断就顶层未捕获崩溃（退出码 1）
    console.log(`\n（输入中断：${e.message}）`);
    logOp('review.vocab', true, { ms: Date.now() - T0, detail: { mode: 'interactive', interrupted: true } });
    exit(0);
  }
}

try {
  if (mode === '1') {
    // ── 模式 1：候选词转正/驳回 ──
    for (let idx = 0; idx < candidates.length; idx++) {
      const e = candidates[idx];
      console.log(`\n[${idx + 1}/${candidates.length}]`);
      printWord(e);
      const exs = Array.isArray(e.examples) ? e.examples : [];
      if (exs.length > 2) console.log(`      （共 ${exs.length} 条例句，转正默认只留前 2 条）`);

      let ans;
      while (true) {
        stdout.write('[1]转正留2例 [2]转正留1例 [3]驳回 [回车]跳过 [q]保存退出 > ');
        ans = (await ask('')).trim().toLowerCase();
        if (ans === '' || ans === '1' || ans === '2' || ans === '3' || ans === 'q') break;
        console.log('  没看懂这个选项——请输入 1/2/3、直接回车，或 q');
      }

      if (ans === 'q') { console.log('\n（已审的都已落盘，剩下的下次再审）'); break; }
      if (ans === '') { skipped++; console.log('  → 跳过\n'); continue; }

      if (ans === '1' || ans === '2') {
        const after = baseConfirmed + confirmed + 1;
        if (after > MAX_CONFIRMED) {
          console.log(`  [警告] 转正后 confirmed = ${after} > ${MAX_CONFIRMED}，信箱任务书只认前 ${MAX_CONFIRMED} 条，这条鱼读不到。`);
          console.log('  提示：可以先去复审模式（重开脚本选 2）下架过气词腾名额。');
          stdout.write('  仍要转正输 y；其他回车放弃 > ');
          const ok = (await ask('')).trim().toLowerCase();
          if (ok !== 'y') { skipped++; console.log('  → 放弃，跳过\n'); continue; }
        }
        e.status = 'confirmed';
        e.examples = exs.slice(0, ans === '1' ? 2 : 1);
        persist();
        confirmed++;
        console.log(`  → 转正 ✓ 例句留 ${e.examples.length} 条（已落盘）\n`);
      } else {
        const p = data.entries.indexOf(e);
        if (p >= 0) data.entries.splice(p, 1);
        persist();
        rejected++;
        console.log('  → 驳回删除 ✓（已落盘）\n');
      }
    }
  } else {
    // ── 模式 2：复审已上线词（下架过气词） ──
    console.log(`\n── 复审已上线词（${confirmedList.length} 条，按热度排序）──`);
    console.log('下架 = 从词库删除（.bak 留底），给新词腾名额。\n');
    for (let idx = 0; idx < confirmedList.length; idx++) {
      const e = confirmedList[idx];
      console.log(`[${idx + 1}/${confirmedList.length}]`);
      printWord(e);

      let ans;
      while (true) {
        stdout.write('[回车]保留 [2]下架 [q]保存退出 > ');
        ans = (await ask('')).trim().toLowerCase();
        if (ans === '' || ans === '2' || ans === 'q') break;
        console.log('  没看懂——直接回车保留、2 下架、q 退出');
      }

      if (ans === 'q') { console.log('\n（已决定的都已落盘，剩下的下次再看）'); break; }
      if (ans === '') { kept++; console.log('  → 保留\n'); continue; }

      const p = data.entries.indexOf(e);
      if (p >= 0) data.entries.splice(p, 1);
      persist();
      retired++;
      const cNow = data.entries.filter((x) => x.status === 'confirmed').length;
      console.log(`  → 下架删除 ✓（confirmed ${cNow}/${MAX_CONFIRMED}，已落盘）\n`);
    }
  }
} catch (e) {
  if (e === eofErrOf()) {
    console.log(`\n（输入中断：${e.message}——已决定 ${confirmed + rejected + retired} 条均已落盘，未丢）`);
  } else {
    // 落盘失败（磁盘满/权限）冒泡到这里的，原先被误报成"输入中断且均已落盘"——
    // 撒谎的收尾统计比崩溃更糟：如实报错退出，已标记"已落盘"的最后一条可能未写入
    console.error(`\n[落盘失败] ${e.message}——上面标记"已落盘"的最后一条可能未写入，请重跑核对`);
    exit(1);
  }
} finally {
  rl.close();
}

// ── 收尾统计 ────────────────────────────────────────────
console.log('──────');
console.log(mode === '2'
  ? `本次：下架 ${retired} · 保留 ${kept}`
  : `本次：转正 ${confirmed} · 驳回 ${rejected} · 跳过 ${skipped}`);
const cNow = data.entries.filter((x) => x.status === 'confirmed').length;
console.log(`库内：confirmed ${cNow}/${MAX_CONFIRMED} · 候选剩 ${data.entries.length - cNow} 条`);
if (cNow > MAX_CONFIRMED) console.log(`[注意] confirmed 超过 ${MAX_CONFIRMED}，尾部条目鱼读不到——重开脚本选 2 下架旧词腾名额。`);
logOp('review.vocab', true, { ms: Date.now() - T0, detail: { mode: 'interactive', confirmed, rejected, skipped, retired, kept } });
console.log(cNow > 0 ? '鱼下一轮聊天就会带上新词。收工 🐟' : '收工 🐟');
