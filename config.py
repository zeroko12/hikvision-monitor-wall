# -*- coding: utf-8 -*-
"""全局配置（不提交任何真实凭据，全部可用环境变量覆盖）。

示例（Windows PowerShell）:
    $env:HK_USER="admin"; $env:HK_PWD="你的密码"; $env:HK_SUBNET="192.168.8"
    python server.py

示例（Linux/macOS）:
    HK_USER=admin HK_PWD=你的密码 HK_SUBNET=192.168.8 python server.py
"""
import os

# ---- 设备访问凭据（摄像头/NVR 的登录账号）----
USER = os.environ.get("HK_USER", "admin")
PWD = os.environ.get("HK_PWD", "")

# ---- 局域网扫描 ----
# 要扫描的网段（前 3 段），程序会扫 .1-254，自动发现设备与 NVR 通道
SUBNET = os.environ.get("HK_SUBNET", "192.168.8")

# 常用端口
RTSP_PORT = int(os.environ.get("HK_RTSP_PORT", 554))
HTTP_PORT = int(os.environ.get("HK_HTTP_PORT", 80))
SDK_PORT = int(os.environ.get("HK_SDK_PORT", 8000))

# ---- 服务运行 ----
# 监控墙 HTTP 服务监听端口
SERVER_PORT = int(os.environ.get("HK_SERVER_PORT", 5000))
# waitress 线程数(一屏16路流 × 每路约2请求/秒 ≈ 32req/s 峰值, 24线程覆盖)
SERVER_THREADS = int(os.environ.get("HK_SERVER_THREADS", 24))
