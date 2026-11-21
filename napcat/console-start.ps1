# Detached console launcher: server survives this script and any cmd exiting.
# ASCII only; Chinese paths resolved via Join-Path (PS internal Unicode).
$pkg = Split-Path -Parent $PSScriptRoot  # napcat -> pkg root
$consoleDir = Join-Path $pkg 'console'
$server = Join-Path $consoleDir 'server.mjs'
Start-Process -WindowStyle Hidden -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList ('"' + $server + '"') -WorkingDirectory $consoleDir
