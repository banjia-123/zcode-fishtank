# 鱼下线：关闭 watchdog、NapCat、适配器与它的 app-server 子进程（彻底下班），不动主号 QQ
# 目录约定：本脚本在 <包根>/napcat/ 下（与 unpacked 同级）
# 参数：-NoPause 结尾不等回车（控制台 spawn 用）；-Actor cli|console 写进操作流水 ops.jsonl
param([switch]$NoPause, [string]$Actor = 'cli')
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$PKG = Split-Path -Parent $PSScriptRoot
Write-Host ''
Write-Host '[下线] 正在关闭 watchdog 与 NapCat（按 unpacked 特征精确匹配，不会碰主号 QQ）...'
Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and ([string]$_.CommandLine) -match 'watchdog'
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
    Write-Host ("  已关 watchdog PID " + $_.ProcessId)
}
Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('node.exe','QQ.exe') -and ((([string]$_.CommandLine) + ' ' + ([string]$_.ExecutablePath)) -match 'unpacked')
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
    Write-Host ("  已关 NapCat PID " + $_.ProcessId + " (" + $_.Name + ")")
}
Write-Host '[下线] 正在关闭适配器（先父后子，防 app-server 被重新拉起）...'
Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and ([string]$_.CommandLine) -match 'adapter\.mjs'  # adapter.mjs：相对/绝对命令行都命中（fish-adapter 匹配会漏 restart-adapter 启动的实例，踩过的坑）
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
    Write-Host ("  已关适配器 PID " + $_.ProcessId)
}
Write-Host '[下线] 正在清理 app-server 子进程（zcode-cli）...'
$cli = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and ([string]$_.CommandLine) -match 'zcode\.cjs' -and ([string]$_.CommandLine) -match 'app-server'
}
if ($cli) {
    $cli | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force
        Write-Host ("  已关 app-server PID " + $_.ProcessId)
    }
} else {
    Write-Host '  无 app-server 进程（patrol 未启用或已退出）'
}
# 等适配器端口释放（最多 5s；契约：停完必须验端口，不留半死状态）
$portFree = $false
$deadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $deadline -and -not $portFree) {
    $listen = Get-NetTCPConnection -LocalPort 3200 -State Listen -ErrorAction SilentlyContinue
    if (-not $listen) { $portFree = $true } else { Start-Sleep -Milliseconds 300 }
}

# 操作流水（ops.jsonl 由脚本自己写，控制台只读）——必须在关控制台之前落账：
# 2026-11-23 20:37 事故：脚本从控制台 spawn，跑到"杀控制台"一步时连带中断，
# 流水没写、端口没验、页面还报"下线失败"。顺序改为：实质工作 → 记账 → 最后才碰控制台。
$opsPath = Join-Path $PKG 'fish-adapter\state\ops.jsonl'
try {
    New-Item -ItemType Directory -Force -Path (Split-Path $opsPath) | Out-Null
    $op = [ordered]@{ ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); actor = $Actor; action = 'offline'; ok = $portFree; ms = [int]$sw.ElapsedMilliseconds; stage = 'stopped'; err = $null; detail = @{ portFree = $portFree } }
    [System.IO.File]::AppendAllText($opsPath, ($op | ConvertTo-Json -Compress -Depth 4) + "`n", (New-Object System.Text.UTF8Encoding($false)))
} catch { }

# 关控制台放最后（弑父步骤殿后）：此刻鱼相关进程已全停、流水已落盘，
# 即使脚本在此被连带终止也无实质损失；控制台侧已改为 detach 发起（见 server.mjs）。
Write-Host '[下线] 正在关闭控制台（127.0.0.1:3201）...'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    ([string]$_.CommandLine) -match 'console\\server\.mjs'
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
    Write-Host ("  已关控制台 PID " + $_.ProcessId)
}

Write-Host ''
Write-Host '[下线] 鱼已彻底下班：NapCat / watchdog / 适配器 / app-server 全部停止。'
if ($portFree) { Write-Host '[下线] 端口 3200 已释放。✓ 鱼已下线' }
else { Write-Host '[下线][警告] 端口 3200 仍被占用——可能有漏网进程，用 netstat -ano | findstr :3200 查。' }
if (-not $NoPause) {
    Write-Host '按回车关闭本窗口...'
    Read-Host
} elseif (-not $portFree) {
    exit 1
}
