// 重启 fish-adapter：杀旧进程（命令行含 adapter.mjs）→ 重新拉起 → 等 /health 就绪
// 用法：node restart-adapter.mjs [--json]
//   --json：结果走 stdout JSON（控制台 spawn 用），stage 枚举 stop_old / spawn / health_check / ready
// 注意：匹配条件是 adapter.mjs——cwd 不在命令行里，别用 'fish-adapter' 匹配（踩过的坑）
import { execFileSync, spawn } from 'node:child_process';
import { get } from 'node:http';
import { readFileSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { logOp } from './lib/ops-log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const JSON_MODE = process.argv.includes('--json');
const ACTOR = process.argv.includes('--actor-console') ? 'console' : 'cli';
const T0 = Date.now();

let PORT = 3200;
try {
  const p = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8')).listen?.port;
  if (p) PORT = Number(p);
} catch { /* config 读不了用默认端口 */ }

const emit = (payload, msg) => {
  if (JSON_MODE) process.stdout.write(JSON.stringify({ ...payload, ...(msg ? { msg } : {}) }) + '\n');
  else console.log(msg ?? JSON.stringify(payload));
};
const die = (stage, error) => {
  logOp('restart', false, { actor: ACTOR, stage, err: error, ms: Date.now() - T0 });
  if (JSON_MODE) {
    // writeSync 直写 stdout fd 后同步 exit（回调式 exit 有窗口，die 后控制流会继续跑）
    try { writeSync(1, JSON.stringify({ ok: false, stage, error, ms: Date.now() - T0 }) + '\n'); } catch { }
  } else {
    console.log(`[重启失败] 停在 ${stage}：${error}`);
  }
  process.exit(1);
};

// ① 杀旧（失败即停：杀不死旧的就拉新，会双实例抢 3200 端口）
const psScript = [
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"",
  "Where-Object { ([string]$_.CommandLine) -match 'adapter\\.mjs' -and ([string]$_.CommandLine) -notmatch 'restart' }",
  "ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('stopped old adapter PID ' + $_.ProcessId) }",
].join(' | ');
try {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', psScript], { encoding: 'utf8' }).trim();
  if (!JSON_MODE) console.log(out || '(没有在跑的旧适配器)');
} catch (e) {
  die('stop_old', e.message.split('\n')[0]);
}

await new Promise((r) => setTimeout(r, 1000));

// ② 拉新（detached + ignore + unref：父进程退出不连带杀掉适配器）
let child;
try {
  child = spawn('C:\\Program Files\\nodejs\\node.exe', ['adapter.mjs'], {
    cwd: HERE,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
} catch (e) {
  die('spawn', e.message);
}

// ③ 等 /health（最多 10s；spawn 成功不等于 boot 成功——config 错/Fail-closed 拦截都会起不来）
const waitHealth = (port, timeoutMs) => new Promise((resolve) => {
  const t0 = Date.now();
  const retry = () => (Date.now() - t0 > timeoutMs ? resolve(false) : setTimeout(tryOnce, 300));
  const tryOnce = () => {
    const req = get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => (res.statusCode === 200 && s.trim() === 'ok' ? resolve(true) : retry()));
    });
    req.on('error', retry);
    req.on('timeout', () => { req.destroy(); retry(); });
  };
  tryOnce();
});
if (!(await waitHealth(PORT, 10_000))) die('health_check', `/health 10s 内未就绪（看 logs/adapter.log 排查 boot 失败原因）`);

emit({ ok: true, pid: child.pid, stage: 'ready', ms: Date.now() - T0 },
  `fish-adapter 已重启 pid=${child.pid}（${Date.now() - T0}ms 就绪，boot 日志见 logs/adapter.log）`);
logOp('restart', true, { actor: ACTOR, ms: Date.now() - T0, detail: { pid: child.pid } });
