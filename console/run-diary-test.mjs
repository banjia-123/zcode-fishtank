// 触发日记任务并轮询至完成
const BASE = 'http://127.0.0.1:3201';
const H = { 'Content-Type': 'application/json', 'X-Fish-Console': '1' };
const j = (r) => r.json();

const run = await j(await fetch(BASE + '/api/tasks/run', { method: 'POST', headers: H, body: JSON.stringify({ kind: 'diary', confirm: 'RUN' }) }));
console.log('[run]', JSON.stringify(run.data));

for (let i = 1; i <= 40; i++) {
  await new Promise((r) => setTimeout(r, 15_000));
  const s = await j(await fetch(BASE + '/api/tasks/status'));
  const r2 = s.data.tasks.runs.diary;
  console.log(`[${i * 15}s]`, JSON.stringify(r2));
  if (r2.status !== 'running') break;
}
const fs = await import('node:fs');
const diaryDir = 'D:/zcode工作区/fishpond/diary';
try {
  const files = fs.readdirSync(diaryDir).filter((f) => f.endsWith('.md')).sort();
  console.log('[diary 目录]', files.join(', ') || '(空)');
} catch { console.log('[diary 目录] 不存在'); }
process.exit(0);
