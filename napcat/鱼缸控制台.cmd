@echo off
rem 鱼缸控制台：确保在跑（幂等，已在跑就直接过）+ 打开浏览器
rem 相对定位：本 cmd 在 napcat/ 下，console 在包根下
node "%~dp0..\console\start-console.mjs" --json >nul 2>&1
start "" http://127.0.0.1:3201
