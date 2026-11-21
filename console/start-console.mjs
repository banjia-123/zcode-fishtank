#!/usr/bin/env node
// 控制台启动器（项目A 交付物 4）：拉起 server.mjs（detached，关掉本窗口控制台不死）
// 用法：node start-console.mjs [--json]   —— 已在跑则直接报 ready（幂等）
// 探活：GET http://127.0.0.1:3201/api/health（200 即就绪）
import { spawn } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const JSON_MODE = process.argv.includes('--json');
const T0 = Date.now();

const waitReady = (timeoutMs) => new Promise((resolve) => {
  const t0 = Date.now();
  const retry = () => (Date.now() - t0 > timeoutMs ? resolve(false) : setTimeout(tryOnce, 250));
  const tryOnce = () => {
    const req = httpGet('http://127.0.0.1:3201/api/health', { timeout: 1500 }, (res) => {
      res.resume();
      res.on('end', () => (res.statusCode === 200 ? resolve(true) : retry()));
    });
    req.on('error', retry);
    req.on('timeout', () => { req.destroy(); retry(); });
  };
  tryOnce();
});

const out = (code, obj, msg) => {
  if (JSON_MODE) {
    try { writeSync(1, JSON.stringify(obj) + '\n'); } catch { /* stdout 关闭 */ }
  } else if (msg) console.log(msg);
  process.exit(code);
};

// 幂等：已在跑直接成功
if (await waitReady(800)) {
  out(0, { ok: true, stage: 'ready', noop: true, ms: Date.now() - T0 }, '控制台已在运行：http://127.0.0.1:3201');
}

const child = spawn(process.execPath, [join(HERE, 'server.mjs')], {
  cwd: HERE, detached: true, stdio: 'ignore', windowsHide: true,
});
child.unref();

if (!(await waitReady(10_000))) {
  out(1, { ok: false, stage: 'health_check', error: '3201 10s 内未就绪' }, '[启动失败] 控制台 10s 内未就绪（node server.mjs 直接跑看报错）');
}
out(0, { ok: true, pid: child.pid, stage: 'ready', ms: Date.now() - T0 },
  `控制台已就绪 pid=${child.pid}（${Date.now() - T0}ms）→ http://127.0.0.1:3201`);
