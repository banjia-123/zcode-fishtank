#!/usr/bin/env node
// 鱼缸行话审校（交互）——vocab.json 的人工确认闸门
// 用法：双击 审词库.cmd，或 node vocab-review.mjs [--file <vocab.json 路径>]
// 规则：转正 = status→confirmed + 例句砍到 1~2 条；驳回 = 整条删除；
//       confirmed 名额 ≤15（信箱任务书只取前 15 条 confirmed，超员尾部读不到）
// 安全：启动即校验 JSON（坏文件拒审，fail-closed）；首次写盘前自动备份 .bak；
//       每条决定即时落盘，中途断电/退出已审的不丢；写盘前 JSON 自校验
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { stdin, stdout, exit } from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = resolve(HERE, '../fishpond/memory/vocab.json');
const MAX_CONFIRMED = 15;

const args = process.argv.slice(2);
let FILE = DEFAULT_FILE;
const fi = args.indexOf('--file');
if (fi >= 0 && args[fi + 1]) FILE = resolve(args[fi + 1]);

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
  exit(1);
}

const candidates = data.entries
  .filter((e) => e.status !== 'confirmed')
  .sort((a, b) => (b.seenCount ?? 0) - (a.seenCount ?? 0) || String(a.firstSeen ?? '').localeCompare(String(b.firstSeen ?? '')));
const baseConfirmed = data.entries.length - candidates.length;

console.log('=== 鱼缸行话审校 ===');
console.log(`库文件：${FILE}`);
if (!candidates.length) {
  console.log(`\n没有待审候选（confirmed ${baseConfirmed}/${MAX_CONFIRMED}）。收工 🐟`);
  exit(0);
}
console.log(`候选 ${candidates.length} 条（按热度排序） · confirmed ${baseConfirmed}/${MAX_CONFIRMED}\n`);

const rl = createInterface({ input: stdin });
let confirmed = 0, rejected = 0, skipped = 0, saved = false;

// 自维护行队列：readline/promises 的 question 在两次提问间隙会丢掉
// 已到达的行（粘贴多行/管道输入必丢），这里 line 一到就入队，ask 出队
// stdin 结束（管道耗尽 / Ctrl+Z）时挂起的 ask 立刻失败 → 已审数据均已落盘
const lineBuf = [];
const waiters = [];
rl.on('line', (l) => { if (waiters.length) waiters.shift()(l); else lineBuf.push(l); });
let eofErr = null;
const ask = async (q) => {
  if (eofErr) throw eofErr;
  if (lineBuf.length) return lineBuf.shift();
  return new Promise((res, rej) => {
    waiters.push(res);
    rl.once('close', () => rej(eofErr ?? (eofErr = new Error('输入流已结束（EOF）'))));
  });
};

const persist = () => {
  if (!saved) { copyFileSync(FILE, FILE + '.bak'); saved = true; } // 首次写盘前备份
  const body = data.entries.map((e) => '  ' + JSON.stringify(e)).join(',\n');
  const out = `{\n "version": ${data.version ?? 1},\n "entries": [\n${body}\n ]\n}`;
  JSON.parse(out); // 自校验：写出去的必须仍是合法 JSON
  writeFileSync(FILE, out, 'utf8');
};

try {
  for (let idx = 0; idx < candidates.length; idx++) {
    const e = candidates[idx];
    console.log(`── [${idx + 1}/${candidates.length}] ${e.word} ${'─'.repeat(Math.max(4, 44 - e.word.length * 2))}`);
    console.log(`含义：${e.meaning ?? '(无)'}`);
    console.log(`用法：${e.usage ?? '(无)'}`);
    const exs = Array.isArray(e.examples) ? e.examples : [];
    exs.forEach((x, k) => console.log(`${k === 0 ? '例句' : '    '}：· ${x}`));
    if (exs.length > 2) console.log(`      （共 ${exs.length} 条例句，转正默认只留前 2 条）`);
    console.log(`热度：出现 ${e.seenCount ?? '?'} 次 · 首见 ${e.firstSeen ?? '?'} · 来源群 ${e.source ?? '?'}`);

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
} catch (e) {
  console.log(`\n（输入中断：${e.message}——已审 ${confirmed + rejected} 条均已落盘，未丢）`);
} finally {
  rl.close();
}

// ── 收尾统计 ────────────────────────────────────────────
console.log('──────');
console.log(`本次：转正 ${confirmed} · 驳回 ${rejected} · 跳过 ${skipped}`);
const cNow = data.entries.filter((x) => x.status === 'confirmed').length;
console.log(`库内：confirmed ${cNow}/${MAX_CONFIRMED} · 候选剩 ${data.entries.length - cNow} 条`);
if (cNow > MAX_CONFIRMED) console.log(`[注意] confirmed 超过 ${MAX_CONFIRMED}，尾部条目鱼读不到——建议驳回旧词腾名额。`);
console.log(cNow > 0 ? '鱼下一轮聊天就会带上新词。收工 🐟' : '收工 🐟');
