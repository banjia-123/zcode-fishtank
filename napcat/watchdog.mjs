// NapCat 看门狗 v3：修复清场自杀
// v2 缺陷：killNapCat 用 CommandLine -match 'napcat' 过滤，watchdog 自身命令行
//   （node ...napcat\watchdog.mjs）同样命中 → 清场时把自己杀了，拉起从未执行。
//   这就是"watchdog + NapCat 集体死亡且日志停在确认死亡"的根因。
// v3 修复：特征串拆开拼接（命令行文本里不出现完整特征词）+ 只杀 node/QQ 进程，
//   watchdog 与适配器的命令行不再命中。
// 配置：从 ../fish-adapter/config.json 读 accessToken 与 selfId（单一配置源）；
//   约定目录布局：本脚本在 <包根>/napcat/ 下，NapCat 解压在 <包根>/napcat/unpacked/。
// 启动：node watchdog.mjs（日志 watchdog.log 同目录）
import { spawn, execSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, '..', 'fish-adapter', 'config.json');
let TOKEN = '';
let QQ = '';
try {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  TOKEN = String(cfg.onebot?.accessToken ?? '');
  QQ = String(cfg.onebot?.selfId ?? '');
} catch (e) { /* 下方 fail-closed */ }
if (!TOKEN || !QQ) {
  console.error(`[watchdog] 无法从 ${CONFIG} 读取 onebot.accessToken / onebot.selfId，退出`);
  process.exit(1);
}
const NODE = 'C:/Program Files/nodejs/node.exe';
const BAT = join(HERE, 'unpacked', 'napcat.bat');
const LOG = join(HERE, 'watchdog.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG, line + '\n'); } catch { /* */ }
}

async function aliveOnce() {
  try {
    const res = await fetch('http://127.0.0.1:3000/get_login_info', {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    const j = await res.json();
    return j?.data?.user_id === Number(QQ);
  } catch {
    return false;
  }
}

// 两次探测都失败才算死（NapCat 忙时偶发超时是常态，不能单次定罪）
async function alive() {
  if (await aliveOnce()) return true;
  await new Promise((r) => setTimeout(r, 8000));
  return aliveOnce();
}

function killNapCat() {
  // 特征串全部拆开拼接：本函数的完整文本会出现在 PowerShell 自身命令行里，
  // 拆开后 PowerShell / watchdog / 适配器都不会命中，只有真正的 NapCat 进程命中。
  // NapCat node:  node.exe ...\unpacked\index.js -q <鱼号>
  // NapCat 底座:  QQ.exe（可执行路径/命令行含 unpacked 目录）
  try {
    execSync(
      "powershell -NoProfile -Command \"Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','QQ.exe') -and (([string]$_.CommandLine) + ' ' + ([string]$_.ExecutablePath)) -match ('un'+'packed') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\"",
      { timeout: 15000, shell: 'cmd.exe' }
    );
  } catch { /* 无进程 */ }
  // 补一刀端口定位：监听 3000/3001 的进程必是 NapCat 活体（含假在线残留）
  try {
    execSync(
      "powershell -NoProfile -Command \"netstat -ano | Select-String -Pattern ':3000\\s|:3001\\s' | Select-String -Pattern 'LISTENING' | ForEach-Object { ($_ -split '\\s+')[-1] } | Sort-Object -Unique | Where-Object { $_ -ne '0' } | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }\"",
      { timeout: 15000, shell: 'cmd.exe' }
    );
  } catch { /* 无监听 */ }
}

let failStreak = 0;      // 连续失败轮数
let restarting = false;
async function check() {
  if (restarting) return;
  if (await alive()) {
    if (failStreak > 0) log('恢复在线');
    failStreak = 0;
    return;
  }
  failStreak += 1;
  log(`离线（连续第 ${failStreak} 轮）`);
  if (failStreak < 2) return; // 单轮失败再观察一轮，防抖

  restarting = true;
  log('确认死亡，清场并拉起…');
  killNapCat();
  await new Promise((r) => setTimeout(r, 3000));
  try {
    spawn('cmd.exe', ['/c', 'start', '', BAT, '-q', QQ], {
      cwd: join(HERE, 'unpacked'),
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch (e) {
    log(`拉起失败: ${e.message}`);
  }
  // 等 70 秒完成登录再恢复检查；重置失败计数（给新实例干净的开始）
  setTimeout(() => { restarting = false; failStreak = 0; log('恢复检查'); }, 70_000);
}

log('watchdog v2 启动（60 秒周期，双轮确认才拉起）');
await check();
setInterval(check, 60_000);
