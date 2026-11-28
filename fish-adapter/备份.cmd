@echo off
rem Fishpond daily backup launcher (schtasks target + manual double-click)
rem Content must stay pure ASCII (no-BOM PowerShell/cmd codepage trap).
cd /d "%~dp0"
if not exist logs mkdir logs
node backup.mjs --run >> logs\backup.log 2>&1
