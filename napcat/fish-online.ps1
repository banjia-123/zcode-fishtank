# 鱼上线：拉起 NapCat（快速登录）+ watchdog + 适配器（若未运行）
# 目录约定：本脚本在 <包根>/napcat/ 下（与 unpacked 同级），凭据读 ../fish-adapter/config.json
# 参数：-NoPause 结尾不等回车（控制台 spawn 用）；-Actor cli|console 写进操作流水 ops.jsonl
param([switch]$NoPause, [string]$Actor = 'cli')
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$HERE = $PSScriptRoot
$PKG = Split-Path -Parent $HERE
$cfgPath = Join-Path $PKG 'fish-adapter\config.json'
$fishQQ = ''
try {
    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $fishQQ = [string]$cfg.onebot.selfId
} catch { Write-Host '[上线] 读取 config.json 失败，NapCat 将不带 -q 启动（需扫码）' }

Write-Host ''
Write-Host '[上线] 拉起 NapCat（快速登录）...'
$bat = Join-Path $HERE 'unpacked\napcat.bat'
if ($fishQQ) {
    Start-Process -FilePath $bat -WorkingDirectory (Join-Path $HERE 'unpacked') -ArgumentList '-q', $fishQQ
} else {
    Start-Process -FilePath $bat -WorkingDirectory (Join-Path $HERE 'unpacked')
}
Write-Host '[上线] 拉起 watchdog（最小化窗口，别关它）...'
Start-Process -WindowStyle Minimized -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList ('"' + (Join-Path $HERE 'watchdog.mjs') + '"')
Write-Host '[上线] 检查适配器...'
$adapter = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { ([string]$_.CommandLine) -match 'fish-adapter' }
if ($adapter) {
    Write-Host ('  适配器已在运行 PID ' + ($adapter.ProcessId -join ','))
} else {
    Start-Process -WindowStyle Hidden -WorkingDirectory (Join-Path $PKG 'fish-adapter') -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList ('"' + (Join-Path $PKG 'fish-adapter\adapter.mjs') + '"')
    Write-Host '  适配器已拉起（隐藏窗口）'
}
# 等适配器就绪（最多 20s）——用 TCP 连接探测：端口被监听即 boot 完成。
# 不用 Invoke-WebRequest（实测会踩系统代理/初始化坑，10 秒全失败误报 health_check）
$port = 3200
try { if ($cfg -and $cfg.listen.port) { $port = [int]$cfg.listen.port } } catch { }
$healthOk = $false
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline -and -not $healthOk) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $port)
        $c.Close()
        $healthOk = $true
    } catch { }
    if (-not $healthOk) { Start-Sleep -Milliseconds 400 }
}

# 操作流水（ops.jsonl 由脚本自己写，控制台只读）
$opsPath = Join-Path $PKG 'fish-adapter\state\ops.jsonl'
$stageFinal = 'ready'
if (-not $healthOk) { $stageFinal = 'health_check' }
try {
    New-Item -ItemType Directory -Force -Path (Split-Path $opsPath) | Out-Null
    $op = [ordered]@{ ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); actor = $Actor; action = 'online'; ok = $healthOk; ms = [int]$sw.ElapsedMilliseconds; stage = $stageFinal; err = $null; detail = @{} }
    [System.IO.File]::AppendAllText($opsPath, ($op | ConvertTo-Json -Compress -Depth 4) + "`n", (New-Object System.Text.UTF8Encoding($false)))
} catch { }

Write-Host ''
if ($healthOk) {
    Write-Host '[上线] 全家桶已拉起：NapCat ✓  watchdog ✓  适配器 ✓（端口就绪）'
    Write-Host '[上线] 鱼正在上线：NapCat 快速登录 + WS 重连，约 60~90 秒——控制台会自动确认「鱼已上线」。'
    # 顺带拉起控制台（幂等：已在跑则直接过；隐藏窗口常驻）
    Write-Host '[上线] 拉起控制台（127.0.0.1:3201）...'
    Start-Process -WindowStyle Hidden -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList ('"' + (Join-Path $PKG 'console\start-console.mjs') + '"') -WorkingDirectory (Join-Path $PKG 'console')
} else {
    Write-Host '[上线][警告] 适配器 20s 内未就绪——看 fish-adapter\logs\adapter.log 排查。'
}
Write-Host '验证: 用你的 accessToken 请求 http://127.0.0.1:3000/get_login_info'
if (-not $NoPause) {
    Write-Host '按回车关闭本窗口...'
    Read-Host
} elseif (-not $healthOk) {
    exit 1
}
