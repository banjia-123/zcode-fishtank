@echo off
rem fish tank console launcher: idempotent start + detached server + open browser
rem ASCII shell only (pitfall 8); real work in console-start.ps1 (detached start,
rem so the server survives this cmd exiting)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0console-start.ps1"
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:3201
