// fish-guard.mjs（PreToolUse 守卫）测试：子进程真跑脚本、stdin 喂 hook 事件，断言退出码与判定。
// 这是 fail-closed 的守卫——写错一个字鱼的工具就全废，所以回归用例（越界/工具面/坏输入）与
// 新增的受保护文件用例一起锁。根目录/日志/白名单三个路径用环境变量注入到 mkdtemp，不碰生产。
// 跑法：node test-fish-guard.mjs，退出码 0 = 全过
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'fish-guard.mjs');

const root = mkdtempSync(join(tmpdir(), 'fish-guard-'));
const POND = join(root, 'fishpond');
const LOG = join(root, 'fire.log');
const ALLOW = join(root, 'allow.json');
const w = (rel, body = 'x') => { const p = join(POND, ...rel.split('/')); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body, 'utf8'); };
mkdirSync(POND, { recursive: true });
w('persona.md', '# 人格');
w('memory/core.md', '# 记忆');
w('memory/vocab.json', '{}');
w('memory/candidates.md', '# 候选');
w('.learner-prompt.md', '任务书');
writeFileSync(ALLOW, JSON.stringify({ sessions: ['sess_worker'] }), 'utf8');

// 跑一次守卫：ev = hook 事件对象（或原始字符串）；返回退出码与判定
function guard(ev, { pond = POND } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: typeof ev === 'string' ? ev : JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess_fish', ...ev }),
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, FISH_GUARD_ROOT: pond, FISH_GUARD_LOG: LOG, FISH_GUARD_ALLOW: ALLOW },
  });
  let out = {};
  try { out = JSON.parse(r.stdout.trim() || '{}'); } catch { /* 非 JSON：决策留空，用例自会失败 */ }
  return { code: r.status, decision: out.permissionDecision ?? (r.status === 0 ? 'allow' : '?'), reason: String(out.reason ?? ''), stderr: r.stderr };
}
const T = (tool, file) => ({ tool_name: tool, tool_input: file == null ? {} : { file_path: file } });

try {
  // —— 回归：原有行为逐条锁住 ——
  ok(guard(T('Read', 'memory/vocab.json')).code === 0, 'FG1 鱼读普通文件 → 放行');
  ok(guard(T('Write', 'memory/vocab.json')).code === 0, 'FG2 鱼写普通文件 → 放行');
  { const r = guard(T('Read', join(POND, '..', 'outside.txt'))); ok(r.code === 2 && /路径越界/.test(r.reason), 'FG3 鱼缸外绝对路径 → 拒绝', r.reason); }
  { const r = guard(T('Read', 'memory/../../../outside.txt')); ok(r.code === 2 && /路径越界/.test(r.reason), 'FG4 用 .. 逃出鱼缸 → 拒绝', r.reason); }
  { const r = guard(T('Bash', undefined)); ok(r.code === 2 && /鱼不可使用 Bash/.test(r.reason), 'FG5 非文件类工具 → 拒绝', r.reason); }
  ok(guard(T('Glob', undefined)).code === 0, 'FG6 不带路径的 Glob → 放行');
  { const r = guard('not json at all'); ok(r.code === 2 && /stdin 解析失败/.test(r.reason), 'FG7 stdin 坏输入 → 拒绝（fail-closed）', r.reason); }
  { const r = guard({ ...T('Write', 'memory/core.md'), session_id: 'sess_worker' }); ok(r.code === 0, 'FG8 白名单施工会话 → 全放行（受保护文件也放行）', r.reason); }
  { const r = guard(T('Write', 'memory/vocab.json'), { pond: join(root, 'no-such-pond') }); ok(r.code === 2 && /不存在或不可达/.test(r.reason), 'FG9 鱼缸目录不存在 → 一律拒绝（此前相对路径会被放行）', r.reason); }
  { const r = guard(T('Write', join(POND, 'memory', 'brand-new.md'))); ok(r.code === 0, 'FG9b 鱼缸内新建文件 → 放行', r.reason); }

  // —— 新增：受保护文件不可写 ——
  for (const [f, why] of [
    ['memory/core.md', '长期记忆只走人工审校'],
    ['persona.md', '人格卡是主人写的'],
    ['memory/core.md.bak', '审校备份'],
    ['memory/candidates.md.prev', '审校备份'],
    ['memory/remove-queue.json', '下架队列'],
    ['.learner-prompt.md', '任务指令'],
    ['.diary-prompt.md', '任务指令'],
    ['.zcode/config.json', 'hooks 配置'],
    ['.zcode/hooks/x.mjs', 'hooks 配置'],
  ]) {
    const r = guard(T('Write', f));
    ok(r.code === 2 && r.decision === 'deny' && r.reason.includes(why) && r.reason.includes(f), `FG10 写 ${f} → 拒绝（${why}）`, r.reason);
  }
  for (const tool of ['Edit', 'ApplyPatch']) {
    const r = guard(T(tool, 'memory/core.md'));
    ok(r.code === 2 && /受保护文件不可写/.test(r.reason), `FG11 ${tool} 写 core.md 同样拒绝`, r.reason);
  }
  { const r = guard(T('Write', join(POND, 'memory', 'core.md'))); ok(r.code === 2 && /受保护文件不可写/.test(r.reason), 'FG12 绝对路径写 core.md → 拒绝', r.reason); }
  { const r = guard(T('Write', 'memory/sub/../core.md')); ok(r.code === 2 && /受保护文件不可写/.test(r.reason), 'FG13 路径里藏 ..（解析后是 core.md）→ 拒绝', r.reason); }
  { const r = guard(T('Write', 'memory/new-thing.bak')); ok(r.code === 2 && /审校备份/.test(r.reason), 'FG14 新建一个 .bak 也不行（规则对不存在的文件同样生效）', r.reason); }
  { const r = guard(T('Write', 'memory/CORE.md')); ok(r.code === 2, 'FG15 换大小写（CORE.md）→ 拒绝', r.reason); }
  { const r = guard(T('Read', 'memory/core.md')); ok(r.code === 0, 'FG16 读 core.md 不受限（只拦写）', r.reason); }
  ok(guard(T('Write', 'memory/candidates.md')).code === 0, 'FG17 写 candidates.md（学习任务的合法写入）→ 放行');
  ok(guard(T('Write', 'diary/2026-11-28.md')).code === 0, 'FG18 写日记 → 放行');
  ok(guard(T('Write', 'memory/style.json')).code === 0, 'FG19 写不受保护的杂文件（style.json）→ hook 放行，交给事后检查隔离');

  // —— 守卫自身没被写坏：任何普通调用的拒绝原因都不该是"guard 异常" ——
  for (const ev of [T('Read', 'memory/vocab.json'), T('Write', 'memory/candidates.md'), T('Write', 'memory/core.md'), T('Read', 'memory/core.md'), T('Glob', undefined)]) {
    const r = guard(ev);
    ok(!/guard 异常/.test(r.reason) && r.decision !== '?', `FG20 守卫内部无异常（${ev.tool_name} ${ev.tool_input.file_path ?? ''}）`, r.reason + r.stderr.slice(0, 120));
  }
  ok(readFileSync(LOG, 'utf8').includes('受保护文件不可写'), 'FG21 拒绝记录写进注入的日志文件（没写进仓库目录）');
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录 */ }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
