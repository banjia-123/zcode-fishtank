// 触发学习任务并轮询至完成（读积压、游标前移、vocab 更新验证）
const BASE = 'http://127.0.0.1:3201';
const H = { 'Content-Type': 'application/json', 'X-Fish-Console': '1' };
const fs = await import('node:fs');
const j = (r) => r.json();

const before = {
  cursor: fs.readFileSync('D:/zcode工作区/fishpond/memory/.learner-cursor', 'utf8').trim(),
  vocabMtime: fs.statSync('D:/zcode工作区/fishpond/memory/vocab.json').mtime.toISOString().slice(0, 16),
};
console.log('[before] cursor =', before.cursor, '| vocab mtime =', before.vocabMtime);

const run = await j(await fetch(BASE + '/api/tasks/run', { method: 'POST', headers: H, body: JSON.stringify({ kind: 'learn', confirm: 'RUN' }) }));
console.log('[run]', JSON.stringify(run.data));

for (let i = 1; i <= 40; i++) {
  await new Promise((r) => setTimeout(r, 20_000));
  const s = await j(await fetch(BASE + '/api/tasks/status'));
  const r2 = s.data.tasks.runs.learn;
  const bk = s.data.tasks.backlog;
  console.log(`[${i * 20}s]`, r2.status, Math.round((r2.elapsedMs ?? 0) / 1000) + 's', r2.error ?? '', '| 积压:', bk?.unlearned);
  if (r2.status !== 'running') {
    console.log('[outTail]', (r2.outTail ?? '').slice(-400));
    const afterCursor = fs.readFileSync('D:/zcode工作区/fishpond/memory/.learner-cursor', 'utf8').trim();
    const afterMtime = fs.statSync('D:/zcode工作区/fishpond/memory/vocab.json').mtime.toISOString().slice(0, 16);
    console.log('[结果] cursor', before.cursor, '→', afterCursor, '| vocab mtime', before.vocabMtime, '→', afterMtime);
    break;
  }
}
process.exit(0);
