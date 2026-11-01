# 鱼上线：拉起 NapCat（快速登录）+ watchdog + 适配器（若未运行）
# 目录约定：本脚本在 <包根>/napcat/ 下（与 unpacked 同级），凭据读 ../fish-adapter/config.json
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
Write-Host ''
Write-Host '[上线] 约 60-90 秒后鱼上线（快速登录 + WS 重连）。'
Write-Host '验证: 用你的 accessToken 请求 http://127.0.0.1:3000/get_login_info'
Write-Host '按回车关闭本窗口...'
Read-Host
