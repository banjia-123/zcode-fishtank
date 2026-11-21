@echo off
rem fish-adapter 启动脚本（Node 22，绝对路径避免 PATH 问题）
"C:\Program Files\nodejs\node.exe" "%~dp0adapter.mjs"
pause
