// 重启 fish-adapter：杀旧进程（命令行含 adapter.mjs）→ 重新拉起
// 用法：node restart-adapter.mjs（或双击 重启适配器.cmd）
// 注意：匹配条件是 adapter.mjs——cwd 不在命令行里，别用 'fish-adapter' 匹配（踩过的坑）
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const psScript = [
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"",
  "Where-Object { ([string]$_.CommandLine) -match 'adapter\\.mjs' -and ([string]$_.CommandLine) -notmatch 'restart' }",
  "ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('stopped old adapter PID ' + $_.ProcessId) }",
].join(' | ');
try {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', psScript], { encoding: 'utf8' }).trim();
  console.log(out || '(没有在跑的旧适配器)');
} catch (e) {
  console.log('(杀旧进程步骤：' + e.message.split('\n')[0] + ')');
}

await new Promise((r) => setTimeout(r, 1000));

const child = spawn('C:\\Program Files\\nodejs\\node.exe', ['adapter.mjs'], {
  cwd: dirname(fileURLToPath(import.meta.url)),
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();
console.log('fish-adapter 已重启，pid=' + child.pid + '（boot 日志见 logs/adapter.log）');
