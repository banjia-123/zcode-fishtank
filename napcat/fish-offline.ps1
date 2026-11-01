# 鱼下线：关闭 watchdog 与 NapCat（鱼离线），不动主号 QQ、不动适配器
# 目录约定：本脚本在 <包根>/napcat/ 下（与 unpacked 同级）
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
Write-Host ''
Write-Host '[下线] 鱼已离线。适配器保留运行（无连接自动重试），下次上线自动恢复。'
Write-Host '按回车关闭本窗口...'
Read-Host
