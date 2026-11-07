#!/usr/bin/env node
// 鱼缸记忆审校（交互）——candidates.md → core.md 的人工筛选闸门（动作 2）
// 用法：双击 审记忆.cmd，或 node memory-review.mjs [--candidates <路径>] [--core <路径>]
// 规则：迁入 = 条目原样追加进 core.md 并从 candidates.md 移除（想润色措辞事后再编辑 core.md）；
//       删除 = 两边都不要；跳过 = 留观，下次再审
// 红线：core.md 总行数 ≤60（信箱任务书只读前 60 行，超了鱼读不到尾部）
// 安全：首次写盘自动备份 .bak；每条决定即时落盘，中断不丢已审的
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { stdin, stdout, exit } from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_MAX_LINES = 60;

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : dflt;
};
const CAND = opt('--candidates', resolve(HERE, '../fishpond/memory/candidates.md'));
const CORE = opt('--core', resolve(HERE, '../fishpond/memory/core.md'));

// ── 读取 ────────────────────────────────────────────────
let candLines, coreLines;
try {
  candLines = readFileSync(CAND, 'utf8').split(/\r?\n/);
  coreLines = readFileSync(CORE, 'utf8').split(/\r?\n/);
} catch (e) {
  console.error(`[中止] 文件读取失败：${e.message}`);
  console.error('       请确认 fishpond/memory 下两个文件存在后再来审，本脚本未做任何修改。');
  exit(1);
}
const isEntry = (l) => typeof l === 'string' && l.startsWith('- [');
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
console.log('收工 🐟');
