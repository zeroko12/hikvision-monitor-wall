@echo off
setlocal
cd /d "%~dp0"
title 海康威视监控墙服务
rem 解释器选择: 若项目目录存在 python_env.bat(内容如 set PY="D:\miniconda\python.exe")则使用之, 否则用 PATH 中的 python
if exist "%~dp0python_env.bat" call "%~dp0python_env.bat"
if not defined PY set PY=python
echo 正在启动海康威视监控墙服务...
echo 本机: http://127.0.0.1:5000
echo 局域网: 浏览器打开 http://本机IP:5000  (手机/Mac 用 Chrome/Edge/Safari)
echo 提示: 请使用 Chrome / Edge / Safari 打开
echo 关闭本窗口 = 停止服务
echo.
start "" http://127.0.0.1:5000
:loop
%PY% server.py
echo.
echo [服务异常退出，3秒后自动重启；按 Ctrl+C 或关闭本窗口可停止]
timeout /t 3 /nobreak >nul
goto loop
