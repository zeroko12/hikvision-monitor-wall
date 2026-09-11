@echo off
setlocal
cd /d "%~dp0"
title 停止海康威视监控墙服务
echo 正在停止监控墙服务(server.py 及 ffmpeg 转码进程)...
powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -match 'server\.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('Stopped python (PID ' + $_.ProcessId + ')') }; Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\" | Where-Object { $_.CommandLine -match 'rtsp://' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('Stopped ffmpeg (PID ' + $_.ProcessId + ')') }; if (-not (Get-Process -Name python,ffmpeg -ErrorAction SilentlyContinue)) { Write-Host 'No related process' }"
echo 完成。按任意键关闭。
pause >nul
