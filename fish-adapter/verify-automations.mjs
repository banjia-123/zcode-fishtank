import { DatabaseSync } from 'node:sqlite';

const DB = process.argv[2] || '<zcode数据目录>/v2/tasks-index.sqlite';
const db = new DatabaseSync(DB, { readOnly: true });

const cols = db.prepare('PRAGMA table_info(automations)').all().map(c => c.name);
console.log('[COLS] ' + cols.join(','));

const rows = db.prepare('SELECT * FROM automations').all();
console.log('[COUNT] ' + rows.length);

// 每个任务按标题分类后，检测 prompt 里的版本标志词
const CHECKS = [
  { tag: 'INBOX', match: t => t.includes('信箱'), marks: ['.index.json', '完全同名', '对得上哪张', '[视频卡片', '前 20'] },
  { tag: 'LEARN', match: t => t.includes('学习'), marks: ['.learner-cursor', 'emojis', 'candidate'] },
  { tag: 'CLEAN', match: t => t.includes('清理'), marks: ['maintenance.mjs', '--apply'] },
  { tag: 'DIARY', match: t => t.includes('日记'), marks: ['.diary-cursor', 'chat.jsonl'] },
];

for (const r of rows) {
  console.log('---AUTO---');
  const title = String(r.title || '');
  const chk = CHECKS.find(x => x.match(title));
  for (const c of cols) {
    let v = r[c];
    if (v === null || v === undefined) { console.log(c + '='); continue; }
    v = String(v);
    if (c.toLowerCase().includes('prompt')) {
      console.log(c + '.len=' + v.length);
      if (chk) for (const m of chk.marks) console.log('  MARK[' + chk.tag + '] ' + JSON.stringify(m) + ' -> ' + (v.includes(m) ? 'OK' : '**MISS**'));
      if (chk && chk.tag === 'CLEAN') console.log('  FULLPROMPT:\n' + v); // 清理任务短，全文看 --db 指向
    } else {
      console.log(c + '=' + v.slice(0, 200));
    }
  }
}

try {
  const rcols = db.prepare('PRAGMA table_info(automation_runs)').all().map(c => c.name);
  const runs = db.prepare('SELECT * FROM automation_runs ORDER BY rowid DESC LIMIT 8').all();
  console.log('---RUNS(recent ' + runs.length + ') cols: ' + rcols.join(','));
  for (const run of runs) {
    const o = {};
    for (const c of rcols) { const v = run[c]; if (v !== null && v !== undefined) o[c] = String(v).slice(0, 80); }
    console.log(JSON.stringify(o));
  }
} catch (e) { console.log('RUNS_ERR ' + e.message); }
