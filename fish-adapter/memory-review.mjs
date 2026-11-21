#!/usr/bin/env node
// 鱼缸记忆审校（交互）——candidates.md → core.md 的人工筛选闸门（动作 2）
// 用法：双击 审记忆.cmd，或 node memory-review.mjs [--candidates <路径>] [--core <路径>]
//       非交互（控制台 spawn 用）：--list --json（纯读列候选）/ --apply --json '{"items":[{"id":"<内容hash>","action":"approve|reject"}]}'
//       id = 候选行 sha1 前 12 位（与行位置解耦：apply 后行号会漂移，行号 id 在重复提交/重试场景会错位误审）
//       （cmd 手测 --json 的引号会被 shell 吃掉时用 --json-file <路径> 代替）
// 规则：迁入 = 条目原样追加进 core.md 并从 candidates.md 移除（想润色措辞事后再编辑 core.md）；
//       删除 = 两边都不要；跳过 = 留观，下次再审
// 红线：core.md 总行数 ≤60（信箱任务书只读前 60 行，超了鱼读不到尾部）
// 安全：首次写盘自动备份 .bak；每条决定即时落盘，中断不丢已审的
import { readFileSync, writeFileSync, copyFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { stdin, stdout, exit } from 'node:process';
import { logOp } from './lib/ops-log.mjs';
import { acquireLock, releaseLock } from './lib/review-lock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_MAX_LINES = 60;
const T0 = Date.now();

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : dflt;
};
const CAND = opt('--candidates', resolve(HERE, '../fishpond/memory/candidates.md'));
const CORE = opt('--core', resolve(HERE, '../fishpond/memory/core.md'));

const isEntry = (l) => typeof l === 'string' && l.startsWith('- [');
// id = 行内容 hash：apply 重写文件后行号会漂移，重复提交同 id 第二次自然 not found（幂等），绝不错位
const rowId = (l) => createHash('sha1').update(l).digest('hex').slice(0, 12);
const usedLinesOf = (lines) => {
  const a = [...lines];
  while (a.length && a[a.length - 1].trim() === '') a.pop();
  return a.length;
};

// ── 非交互模式（控制台 spawn）：--list 纯读 / --apply 批量裁决，与下方交互流程互斥 ──
if (args.includes('--list') || args.includes('--apply')) {
  const outJson = (code, obj) => {
    // writeSync 直写 stdout fd，完成后才 exit——同步终止控制流（回调式 exit 有窗口，--list 会掉进 --apply 分支）
    try { writeSync(1, JSON.stringify(obj) + '\n'); } catch { /* stdout 已关闭等罕见场景 */ }
    process.exit(code);
  };

  if (args.includes('--list')) {
    // 纯读：绝不写盘、不备份、不上锁。candidates.md 缺失 = 还没有候选，不是错误
    let lines = [];
    try { lines = readFileSync(CAND, 'utf8').split(/\r?\n/); } catch { /* ENOENT：候选文件还没生成 */ }
    let core = null;
    try {
      const cl = readFileSync(CORE, 'utf8').split(/\r?\n/);
      core = { entries: cl.filter(isEntry).length, lines: usedLinesOf(cl), maxLines: CORE_MAX_LINES };
    } catch { /* core.md 缺失：控制台显示"尚未启用" */ }
    const items = [];
    lines.forEach((l, i) => {
      if (isEntry(l)) {
        const m = l.match(/^- \[([^\]]+)\]\s*(.*)$/);
        items.push({ id: rowId(l), date: m ? m[1] : '?', text: m ? m[2] : l.slice(2) });
      }
    });
    outJson(0, { ok: true, items, core });
  }

  // --apply：批内 id 可部分失败（不整批回滚），写盘前 .bak 备份，全程持 review.lock
  // 动作：approve=迁入 core.md / reject=删候选 / remove-core=从 core.md 删已生效行（G5b 删除提案闭环）
  let payload = null;
  const ji = args.indexOf('--json'), jf = args.indexOf('--json-file');
  try {
    const raw = jf >= 0 && args[jf + 1] ? readFileSync(resolve(args[jf + 1]), 'utf8')
      : ji >= 0 && args[ji + 1] ? args[ji + 1] : null;
    payload = JSON.parse(raw);
    if (!payload || !Array.isArray(payload.items)) throw new Error('items 不是数组');
    for (const it of payload.items) {
      if (!it || typeof it.id !== 'string' || !['approve', 'reject', 'remove-core'].includes(it.action)) {
        throw new Error(`条目字段非法：${JSON.stringify(it ?? null).slice(0, 80)}`);
      }
    }
  } catch (e) {
    console.error(`[参数] --apply 需要 --json '{"items":[{"id":"<行号>","action":"approve|reject"}]}'（或 --json-file 路径）。${e.message}`);
    exit(2);
  }
  let candL, coreL;
  try {
    candL = readFileSync(CAND, 'utf8').split(/\r?\n/);
    coreL = readFileSync(CORE, 'utf8').split(/\r?\n/);
  } catch (e) {
    logOp('review.memory', false, { err: e.message, ms: Date.now() - T0 });
    outJson(1, { ok: false, error: `文件读取失败：${e.message}` });
  }
  const lockErr = acquireLock();
  if (lockErr) { console.error(`[锁] ${lockErr}`); exit(2); }
  const addCoreTo = (lines, line) => {
    const lastIdx = lines.map(isEntry).lastIndexOf(true);
    if (lastIdx >= 0) lines.splice(lastIdx + 1, 0, line);
    else {
      const ph = lines.indexOf('（暂无）');
      if (ph >= 0) lines[ph] = line;
      else {
        while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
        lines.push('', line);
      }
    }
  };
  const results = [];
  const seen = new Set();
  let candDirty = false, coreDirty = false;
  for (const it of payload.items) {
    // remove-core：从 core.md 删已生效行（G5b 删除提案闭环——id 与普通候选同款行 hash，与位置解耦）
    if (it.action === 'remove-core') {
      if (seen.has(it.id)) { results.push({ id: it.id, ok: false, error: 'duplicate id in batch' }); continue; }
      seen.add(it.id);
      const li = coreL.findIndex((l) => isEntry(l) && rowId(l) === it.id);
      if (li < 0) {
        results.push({ id: it.id, ok: false, error: 'id not found（core.md 里没有这一行——内容可能已被改动，请重提）' }); continue;
      }
      coreL.splice(li, 1);
      coreDirty = true;
      results.push({ id: it.id, ok: true, effect: 'removed-from-core' });
      continue;
    }
    const li = candL.findIndex((l) => isEntry(l) && rowId(l) === it.id);
    if (li < 0) {
      results.push({ id: it.id, ok: false, error: 'id not found（可能已审过或候选已被更新——重新 --list 后再试）' }); continue;
    }
    if (it.action === 'approve') {
      if (usedLinesOf(coreL) + 1 > CORE_MAX_LINES) {
        results.push({ id: it.id, ok: false, error: `core-full：迁入后超 ${CORE_MAX_LINES} 行红线，先下架旧记忆再批新` }); continue;
      }
      addCoreTo(coreL, candL[li]);
      coreDirty = true;
    }
    candL[li] = null;
    candDirty = true;
    results.push({ id: it.id, ok: true, effect: it.action === 'approve' ? 'inserted' : 'removed' });
  }
  let backup = null;
  if (candDirty || coreDirty) {
    backup = {};
    try {
      if (candDirty) { copyFileSync(CAND, CAND + '.bak'); backup.candidates = CAND + '.bak'; }
      if (coreDirty) { copyFileSync(CORE, CORE + '.bak'); backup.core = CORE + '.bak'; }
      if (coreDirty) writeFileSync(CORE, coreL.join('\n'), 'utf8');
      if (candDirty) writeFileSync(CAND, candL.filter((l) => l !== null).join('\n'), 'utf8');
    } catch (e) {
      releaseLock();
      logOp('review.memory', false, { stage: 'write', err: e.message, ms: Date.now() - T0 });
      outJson(1, { ok: false, error: `写盘失败：${e.message}`, backup });
    }
  }
  releaseLock();
  logOp('review.memory', true, {
    ms: Date.now() - T0,
    detail: { applied: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, backup },
  });
  outJson(0, { ok: true, results, backup });
}

// ── 读取 ────────────────────────────────────────────────
let candLines, coreLines;
try {
  candLines = readFileSync(CAND, 'utf8').split(/\r?\n/);
  coreLines = readFileSync(CORE, 'utf8').split(/\r?\n/);
} catch (e) {
  console.error(`[中止] 文件读取失败：${e.message}`);
  console.error('       请确认 fishpond/memory 下两个文件存在后再来审，本脚本未做任何修改。');
  logOp('review.memory', false, { err: e.message, ms: Date.now() - T0 });
  exit(1);
}
const entries = candLines.map((l, i) => ({ l, i })).filter((x) => isEntry(x.l));
const usedLines = () => {
  const a = [...coreLines];
  while (a.length && a[a.length - 1].trim() === '') a.pop();
  return a.length;
};
const coreCount = () => coreLines.filter(isEntry).length;

console.log('=== 鱼缸记忆审校 ===');
console.log(`候选：${CAND}`);
console.log(`目标：${CORE}`);
if (!entries.length) {
  console.log(`\n没有待审记忆候选（core.md 现 ${coreCount()} 条 / ${usedLines()} 行，红线 ${CORE_MAX_LINES} 行）。收工 🐟`);
  exit(0);
}
console.log(`待审 ${entries.length} 条 · core.md 现 ${coreCount()} 条 / ${usedLines()} 行（红线 ${CORE_MAX_LINES}）\n`);

const rl = createInterface({ input: stdin });
const lineBuf = [], waiters = [];
rl.on('line', (l) => { if (waiters.length) waiters.shift()(l); else lineBuf.push(l); });
let eofErr = null;
const ask = async () => {
  if (eofErr) throw eofErr;
  if (lineBuf.length) return lineBuf.shift();
  return new Promise((res, rej) => {
    waiters.push(res);
    rl.once('close', () => rej(eofErr ?? (eofErr = new Error('输入流已结束（EOF）'))));
  });
};

let candSaved = false, coreSaved = false;
const writeCand = () => {
  if (!candSaved) { copyFileSync(CAND, CAND + '.bak'); candSaved = true; }
  writeFileSync(CAND, candLines.filter((l) => l !== null).join('\n'), 'utf8');
};
const writeCore = () => {
  if (!coreSaved) { copyFileSync(CORE, CORE + '.bak'); coreSaved = true; }
  writeFileSync(CORE, coreLines.join('\n'), 'utf8');
};
const addCore = (line) => {
  const lastIdx = coreLines.map(isEntry).lastIndexOf(true);
  if (lastIdx >= 0) coreLines.splice(lastIdx + 1, 0, line);
  else {
    const ph = coreLines.indexOf('（暂无）');
    if (ph >= 0) coreLines[ph] = line;
    else {
      while (coreLines.length && coreLines[coreLines.length - 1].trim() === '') coreLines.pop();
      coreLines.push('', line);
    }
  }
};

let moved = 0, dropped = 0, kept = 0;

try {
  for (let idx = 0; idx < entries.length; idx++) {
    const { l: line } = entries[idx];
    const m = line.match(/^- \[([^\]]+)\]\s*(.*)$/);
    const date = m ? m[1] : '?';
    const body = m ? m[2] : line.slice(2);
    console.log(`── [${idx + 1}/${entries.length}] ${date} ${'─'.repeat(Math.max(4, 40 - date.length * 2))}`);
    console.log(`内容：${body}`);

    let ans;
    while (true) {
      stdout.write('[1]迁入core.md [2]删除 [回车]跳过 [q]保存退出 > ');
      ans = (await ask()).trim().toLowerCase();
      if (ans === '' || ans === '1' || ans === '2' || ans === 'q') break;
      console.log('  没看懂这个选项——请输入 1/2、直接回车，或 q');
    }

    if (ans === 'q') { console.log('\n（已审的都已落盘，剩下的下次再审）'); break; }
    if (ans === '') { kept++; console.log('  → 跳过（留在候选区）\n'); continue; }

    if (ans === '1') {
      if (usedLines() + 1 > CORE_MAX_LINES) {
        console.log(`  [警告] 迁入后 core.md = ${usedLines() + 1} 行 > ${CORE_MAX_LINES}，信箱任务书只读前 ${CORE_MAX_LINES} 行，鱼读不到这条。`);
        stdout.write('  仍要迁入输 y；其他回车放弃 > ');
        const ok = (await ask()).trim().toLowerCase();
        if (ok !== 'y') { kept++; console.log('  → 放弃，跳过\n'); continue; }
      }
      addCore(line);
      candLines[entries[idx].i] = null;
      writeCore(); writeCand();
      moved++;
      console.log(`  → 迁入 core.md ✓（现 ${coreCount()} 条 / ${usedLines()} 行，已落盘）\n`);
    } else {
      candLines[entries[idx].i] = null;
      writeCand();
      dropped++;
      console.log('  → 删除 ✓（已落盘）\n');
    }
  }
} catch (e) {
  console.log(`\n（输入中断：${e.message}——已审 ${moved + dropped} 条均已落盘，未丢）`);
} finally {
  rl.close();
}

// ── 收尾统计 ────────────────────────────────────────────
console.log('──────');
console.log(`本次：迁入 ${moved} · 删除 ${dropped} · 跳过 ${kept}`);
console.log(`core.md：${coreCount()} 条 / ${usedLines()} 行（红线 ${CORE_MAX_LINES}，超线尾部鱼读不到）`);
console.log(`candidates.md：剩 ${candLines.filter(isEntry).length} 条待审`);
if (moved > 0) console.log('鱼下一轮聊天就会读到新记忆；想润色措辞直接编辑 core.md 即可。');
logOp('review.memory', true, { ms: Date.now() - T0, detail: { mode: 'interactive', moved, dropped, kept } });
console.log('收工 🐟');
