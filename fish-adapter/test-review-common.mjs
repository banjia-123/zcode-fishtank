// D6 测试补盲：lib/review-common.mjs 单测（D5 收敛出的共享库——B4/C4 两轮 bug 的老家，值测试守着）
// parseApplyPayload 同进程直测；createLineQueue / outJson 涉及 process.stdin 与 process.exit，
// 用子进程隔离测（stdin 管道喂行 + 断言退出码/stdout）。
// 跑法：node test-review-common.mjs，退出码 0 = 全过
import './test-setup.mjs';
import { parseApplyPayload, outJson, createLineQueue } from './lib/review-common.mjs';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let pass = 0, fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}
const throws = (fn, re, name) => {
  try { fn(); ok(false, name, '未抛错'); }
  catch (e) { ok(re.test(String(e.message)), name, String(e.message).slice(0, 60)); }
};

const MOD = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'lib', 'review-common.mjs')).href;

// —— R1-R6 parseApplyPayload（--apply 的参数契约：控制台 spawn 的机器接口）——
{
  const r1 = parseApplyPayload(['--json', '{"items":[{"id":"a","action":"approve"}]}'], ['approve', 'reject']);
  ok(Array.isArray(r1.items) && r1.items[0].id === 'a' && r1.items[0].action === 'approve', 'R1 --json 内联合法 payload');

  const fx = mkdtempSync(join(tmpdir(), 'fish-rc-'));
  try {
    const f = join(fx, 'payload.json');
    writeFileSync(f, '{"items":[{"id":"from-file","action":"reject"}]}', 'utf8');
    // --json-file 与 --json 同时给：文件优先
    const r2 = parseApplyPayload(['--json-file', f, '--json', '{"items":[]}'], ['approve', 'reject']);
    ok(r2.items[0].id === 'from-file', 'R2 --json-file 优先于 --json');
  } finally { try { rmSync(fx, { recursive: true, force: true }); } catch { /* 临时目录 */ } }

  throws(() => parseApplyPayload(['--json', '{"items":"x"}'], ['approve']), /items 不是数组/, 'R3 items 非数组抛错');
  throws(() => parseApplyPayload(['--json', '{"items":[{"id":"a","action":"nope"}]}'], ['approve']), /条目字段非法/, 'R4 action 白名单外抛错');
  throws(() => parseApplyPayload(['--json', '{"items":[{"id":123,"action":"approve"}]}'], ['approve']), /条目字段非法/, 'R5 id 非字符串抛错');
  throws(() => parseApplyPayload([], ['approve']), /items/, 'R6 无参数抛错');
}

// —— R7 outJson 子进程：直写 stdout fd + 同步 exit（退出码透传）——
{
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { outJson } from '${MOD}'; outJson(3, { ok: true });`], { encoding: 'utf8', timeout: 15_000 });
  ok(r.status === 3, 'R7a outJson 退出码透传（exit 3）', `status=${r.status}`);
  ok(r.stdout.trim() === '{"ok":true}', 'R7b stdout 出 JSON 一行', JSON.stringify(r.stdout));
}

// —— R8-R10 createLineQueue 子进程：行入队顺序 / EOF 失败 / eofErr 引用一致 ——
{
  const script = `import { createLineQueue } from '${MOD}';
const q = createLineQueue();
const a = await q.ask();
const b = await q.ask();
console.log('L1:' + a);
console.log('L2:' + b);
try { await q.ask(); } catch (e) { console.log('EOF:' + (e === q.eofErr())); console.log('REF:' + (q.eofErr() === q.eofErr())); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { input: 'line1\nline2\n', encoding: 'utf8', timeout: 15_000 });
  const lines = r.stdout.trim().split('\n');
  ok(lines[0] === 'L1:line1' && lines[1] === 'L2:line2', 'R8 行按序出队（粘贴多行不丢）', r.stdout.slice(0, 80));
  ok(lines[2] === 'EOF:true', 'R9 stdin 结束时挂起的 ask 抛 EOF 错误（已审数据可安全落盘收尾）', r.stdout.slice(0, 120));
  ok(lines[3] === 'REF:true', 'R10 eofErr() 引用稳定（主循环 e === eofErr() 判据可靠）', r.stdout.slice(0, 160));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
