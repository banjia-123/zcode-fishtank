// 任务护栏测试（2026-11-28）：console/task-guard.mjs——prompt 提取 + 任务书外写入检查
// 覆盖：围栏提取（两份真实任务书模板）/ 快照对比（可写、免检、新增、改动、删除）/ 隔离 / 干净返回 null
// 跑法：node test-task-guard.mjs，退出码 0 = 全过
import { extractTaskPrompt, loadTaskPrompt, snapshotWatch, diffWatch, quarantineAdded, checkTaskStray, prepareTaskRun } from './task-guard.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = dirname(fileURLToPath(import.meta.url));

// ── TG1 prompt 提取 ──
ok(extractTaskPrompt('# 标题\n\n## 任务 prompt\n\n```text\n你是任务。\n步骤：1. x\n```\n\n## 维护记录\n- 噪音') === '你是任务。\n步骤：1. x', 'TG1a 只取 ```text 围栏正文');
ok(extractTaskPrompt('没有围栏的纯 prompt\n第二行') === '没有围栏的纯 prompt\n第二行', 'TG1b 无围栏时整发（兼容纯 prompt 文件）');
ok(extractTaskPrompt('```text\r\n带 CRLF 的正文\r\n```\r\n') === '带 CRLF 的正文', 'TG1c CRLF 围栏也能提取');
ok(extractTaskPrompt('') === '' && extractTaskPrompt(null) === '' && extractTaskPrompt('```text\n```') === '', 'TG1d 空输入/空围栏返回空串（调用方按 fail-closed 报错）');

// 用仓库里两份真实任务书模板验证：提出的是纯 prompt，围栏与说明段不外发。
// 模板只在仓库里（部署布局没有 fishpond-template/）——找不到就跳过这组，不算失败
const TPL_DIR = join(HERE, '..', 'fishpond-template');
if (existsSync(join(TPL_DIR, 'learner-prompt-template.md'))) {
  for (const [name, file] of [['learner', 'learner-prompt-template.md'], ['diary', 'diary-prompt-template.md']]) {
    const p = loadTaskPrompt(join(TPL_DIR, file));
    ok(p.startsWith('你是') && !p.includes('```') && !p.includes('维护记录') && !p.includes('设计要点'), `TG2 ${name} 任务书：提取结果以任务正文开头，不含围栏/说明段`, p.slice(0, 40));
    ok(!/CronCreate/.test(p) && /<fishpond目录>/.test(p), `TG2b ${name} 任务书：不含建任务外壳，占位符保留待渲染`);
  }
  ok(/认人名册维护/.test(loadTaskPrompt(join(TPL_DIR, 'learner-prompt-template.md'))), 'TG2c 学习任务书含名册步骤（生产快照里缺的那一步）');
} else {
  console.log('  − TG2 任务书模板组跳过：本目录没有 fishpond-template/（部署布局），这组只在仓库里跑');
}
try { loadTaskPrompt(join(tmpdir(), 'no-such-task-book.md')); ok(false, 'TG3 任务书读不到应抛错'); } catch { ok(true, 'TG3 任务书读不到抛错（调用方报错，不回落过时快照）'); }

// ── 快照对比 ──
const root = mkdtempSync(join(tmpdir(), 'fish-tg-'));
const pond = join(root, 'fishpond');
const quar = join(root, 'quarantine');
const w = (rel, body = 'x') => { const p = join(pond, ...rel.split('/')); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body, 'utf8'); };
try {
  w('memory/core.md', '# 记忆');
  w('memory/core.md.bak', '旧');
  w('memory/vocab.json', '{"entries":[]}');
  w('memory/.learner-cursor', '10');
  w('memory/roster.json', '{"entries":[]}');
  w('emojis/index.json', '{}');
  w('diary/2026-11-27.md', '# 昨天');
  w('logs/chat.jsonl', '不在监视范围');
  w('persona.md', '# 人格');

  const before = snapshotWatch(pond, 'learn');
  ok(before.has('memory/core.md') && before.has('memory/vocab.json') && before.has('emojis/index.json') && before.has('diary/2026-11-27.md'), 'TG4a 监视范围：记忆目录 + 日记目录（递归）+ 表情索引');
  ok(!before.has('logs/chat.jsonl') && !before.has('persona.md'), 'TG4b 日志/人格卡不在监视范围（日志适配器每秒在写，不能扫）');
  const beforeD = snapshotWatch(pond, 'diary');
  ok(beforeD.has('memory/core.md') && beforeD.has('memory/.learner-cursor') && !beforeD.has('memory/.diary-cursor'), 'TG4c 两个任务盯同一片范围（文件不存在不炸）');

  ok(checkTaskStray({ fishpond: pond, kind: 'learn', before, quarantineRoot: quar }) === null, 'TG5 任务没动任何文件 → 返回 null');

  // 可写文件变了 / 免检文件变了 → 不算
  await sleep(10);
  w('memory/vocab.json', '{"entries":[1]}');
  w('memory/.learner-cursor', '20');
  w('memory/roster.json', '{"entries":[2]}');
  w('memory/core.md.bak', '人审刚更新了备份');
  const d1 = diffWatch(before, snapshotWatch(pond, 'learn'), 'learn');
  ok(d1.added.length === 0 && d1.modified.length === 0 && d1.removed.length === 0, 'TG6 可写文件与免检备份的变化不算越界', JSON.stringify(d1));

  // 凭空出现的文件 → added，并隔离
  w('memory/style.json', '{"avg":13}');
  const r7 = checkTaskStray({ fishpond: pond, kind: 'learn', before, quarantineRoot: quar, now: new Date('2026-11-28T04:00:00.000Z') });
  ok(r7 && r7.added.join() === 'memory/style.json', 'TG7a 任务写出的任务书外文件被报出', JSON.stringify(r7));
  ok(!existsSync(join(pond, 'memory', 'style.json')), 'TG7b 该文件已从鱼缸移走');
  ok(existsSync(join(quar, '2026-11-28T04-00-00-000Z-learn', 'memory', 'style.json')) && readFileSync(join(quar, '2026-11-28T04-00-00-000Z-learn', 'memory', 'style.json'), 'utf8') === '{"avg":13}', 'TG7c 隔离区按时间-任务分目录，保留相对路径与内容');
  ok(r7.quarantineDir && r7.quarantineFailed.length === 0, 'TG7d 隔离无失败');

  // 已有文件被改动 → 只报告，不动
  await sleep(10);
  w('memory/core.md', '# 被任务偷改的记忆');
  const r8 = checkTaskStray({ fishpond: pond, kind: 'learn', before, quarantineRoot: quar });
  ok(r8.modified.join() === 'memory/core.md' && r8.added.length === 0, 'TG8a 受保护文件被改动 → 报告', JSON.stringify(r8));
  ok(readFileSync(join(pond, 'memory', 'core.md'), 'utf8') === '# 被任务偷改的记忆', 'TG8b 被改动的文件原样保留（不自动还原——可能是人在任务期间走审阅页改的）');

  // 被删除 → 报告
  rmSync(join(pond, 'memory', 'core.md'));
  const r9 = checkTaskStray({ fishpond: pond, kind: 'learn', before, quarantineRoot: quar });
  ok(r9.removed.join() === 'memory/core.md' && r9.modified.length === 0, 'TG9 文件被删 → 报告 removed', JSON.stringify(r9));

  // 日记任务：当日日记是可写的；学习任务的游标对它来说是任务书外文件
  const b2 = snapshotWatch(pond, 'diary');
  await sleep(10);
  w('diary/2026-11-28.md', '# 今天');
  w('memory/.learner-cursor', '999');
  const r10 = checkTaskStray({ fishpond: pond, kind: 'diary', before: b2, quarantineRoot: quar });
  ok(r10.modified.join() === 'memory/.learner-cursor', 'TG10 日记任务：当日日记可写，动了学习游标则报告', JSON.stringify(r10));

  ok(checkTaskStray({ fishpond: pond, kind: 'learn', before: null, quarantineRoot: quar }) === null, 'TG11 没有任务前快照（启动失败）→ 不检查、不炸');

  // 隔离失败不炸：目标位置被同名目录占住
  const b3 = snapshotWatch(pond, 'learn');
  w('memory/zz.json', '{}');
  const q3 = quarantineAdded(pond, quar, 'learn', ['memory/zz.json', 'memory/不存在.json'], new Date('2026-11-28T05:00:00.000Z'));
  ok(q3.quarantined.join() === 'memory/zz.json' && q3.failed.length === 1 && q3.failed[0].rel === 'memory/不存在.json', 'TG12 隔离：成功的移走，失败的逐个报告原因', JSON.stringify(q3));

  // ── PT 任务启动准备（prepareTaskRun）：真实执行——顺序错误（暂时性死区）在这里就会炸，而不是等点按钮 ──
  w('.learner-prompt.md', '# 任务书\n\n```text\n你是<鱼名>的学习任务。\n```\n\n## 维护记录\n- 噪音');
  const PT = (over = {}) => prepareTaskRun({ kind: 'learn', taskBookPath: join(pond, '.learner-prompt.md'), fishpond: pond, render: (p) => p.replace('<鱼名>', '伊丽莎白'), ...over });
  const p1 = PT();
  ok(p1.ok === true && p1.prompt === '你是伊丽莎白的学习任务。', 'PT1a 准备成功：prompt 是渲染过的围栏正文', JSON.stringify(p1).slice(0, 120));
  ok(p1.before instanceof Map && p1.before.has('memory/vocab.json'), 'PT1b 返回任务前快照');
  const p2 = PT({ taskBookPath: join(pond, 'no-such-book.md'), taskBookName: '.learner-prompt.md' });
  ok(p2.ok === false && /任务书读取失败（\.learner-prompt\.md）/.test(p2.error), 'PT2 任务书读不到 → 报错带文件名', p2.error);
  const goodBook = '# 任务书\n\n```text\n你是<鱼名>的学习任务。\n```\n\n## 维护记录\n- 噪音';
  w('.learner-prompt.md', '```text\n```');
  const p3 = PT();
  ok(p3.ok === false && /为空或没有/.test(p3.error), 'PT3 空围栏 → 报错', p3.error);
  w('.learner-prompt.md', goodBook); // 后面几条要有有效的任务书，否则都撞在"为空"上测不到目标分支
  const boom = PT({ render: () => { throw new Error('render boom'); } });
  ok(boom.ok === false && boom.error.includes('渲染失败') && boom.error.includes('render boom'), 'PT4 渲染抛错 → 报错带原因', boom.error);
  const blank = PT({ render: () => '   ' });
  ok(blank.ok === false && /渲染后为空/.test(blank.error), 'PT5 渲染后为空 → 报错', blank.error);
  w('.learner-prompt.md', '纯 prompt 无围栏');
  ok(PT().ok === true, 'PT5b 无围栏的纯 prompt 任务书也能准备');

  // runTaskAsync 要启动真实模型会话，测试进不去——织一张专门针对"先赋值、后声明"的网
  //（暂时性死区：语法检查抓不到，2026-11-28 同一天在三个文件里各犯过一次）
  const detectAssignBeforeDecl = (lines) => {
    const out = [];
    lines.forEach((line, i) => {
      const d = line.match(/^\s+(?:let|const)\s+(\w+)\b/);
      if (d && lines.slice(0, i).some((l) => new RegExp(`^\\s*${d[1]}\\s*=[^=]`).test(l))) out.push(d[1]);
    });
    return out;
  };
  ok(detectAssignBeforeDecl(['  before = f();', '  let before = null;']).join() === 'before', 'PT6 检测器自检：带病样例（赋值在前、声明在后）必须被报出');
  ok(detectAssignBeforeDecl(['  let before = null;', '  before = f();', '  let x = 1;', '  if (x == 1) y = 2;', '  const z = a === b;']).length === 0, 'PT6b 检测器自检：正常顺序与 == / === 不误报');
  {
    const src = readFileSync(join(HERE, 'server.mjs'), 'utf8');
    const start = src.indexOf('async function runTaskAsync(');
    const end = start >= 0 ? src.indexOf('\n}\n', start) : -1;
    ok(start >= 0 && end > start, 'PT6c 能定位 runTaskAsync 函数体');
    const offenders = detectAssignBeforeDecl(src.slice(start, end).split('\n'));
    ok(offenders.length === 0, 'PT6d runTaskAsync 内没有"先赋值、后声明"的变量', ` offenders: ${offenders.join(',')}`);
    ok(!/\b(snapshotWatch|loadTaskPrompt)\(/.test(src.slice(start, end)), 'PT6e runTaskAsync 不再自己读任务书/取快照（已收进可测的 prepareTaskRun）');
  }
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录 */ }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
