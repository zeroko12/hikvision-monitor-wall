# 海康威视监控墙 (Hikvision Monitor Wall)

一个开箱即用的**局域网海康威视/NVR 监控墙**：自动扫描局域网设备，把摄像机、录像机（含多通道 NVR）汇总成一面实时监控墙，浏览器直接看，支持抓拍与云台 PTZ 控制。

- **自动发现**：扫描配置网段，自动识别 IPC / NVR，NVR 通道自动展开，无需手动添加设备
- **实时画面**：ffmpeg 拉 RTSP 转 H.264 + HLS，浏览器 hls.js 播放（Chrome/Edge/Safari）
- **低占用转码**：子码流默认走 Intel QSV 硬编 + 360p/10fps，40 路整墙仅占 ~3% CPU（12 核）；主码流软编保画质，点开单路看细节
- **抓拍 & PTZ**：ISAPI 单帧抓拍；自动检测云台能力，支持方向/变焦控制
- **7×24 常驻**：waitress 多线程生产服务器，崩溃自动重启（Windows 批处理守护）

## 环境要求

| 依赖 | 说明 |
|---|---|
| Python | 3.8+ |
| ffmpeg | 需在 PATH 中（`ffmpeg`、`ffprobe`），Windows 推荐 [gyan.dev 完整版](https://www.gyan.dev/ffmpeg/builds/) |
| 浏览器 | Chrome / Edge / Safari（**不支持** 内置 WebView 播放视频） |

硬件可选：Intel 核显（QSV 硬编，默认启用）、或 NVIDIA/AMD 独显（改 ffmpeg 参数为 nvenc/amf 亦可）。

## 安装

```bash
# 1. 安装 Python 依赖
pip install -r requirements.txt

# 2. 确认 ffmpeg 可用
ffmpeg -version
```

## 配置

所有配置通过**环境变量**提供，不修改代码、不提交凭据：

| 变量 | 默认 | 说明 |
|---|---|---|
| `HK_USER` | `admin` | 摄像头/NVR 登录账号 |
| `HK_PWD` | *(空)* | 摄像头/NVR 登录密码 |
| `HK_SUBNET` | `192.168.8` | 扫描网段（前 3 段，自动扫 .1-254） |
| `HK_RTSP_PORT` | `554` | RTSP 端口 |
| `HK_HTTP_PORT` | `80` | HTTP/ISAPI 端口 |
| `HK_SDK_PORT` | `8000` | 设备 SDK 端口 |
| `HK_SERVER_PORT` | `5000` | 监控墙 HTTP 服务端口 |
| `HK_SERVER_THREADS` | `8` | waitress 线程数 |

PowerShell 示例：

```powershell
$env:HK_USER="admin"
$env:HK_PWD="你的密码"
$env:HK_SUBNET="192.168.8"
python server.py
```

Linux/macOS 示例：

```bash
HK_USER=admin HK_PWD=你的密码 HK_SUBNET=192.168.8 python server.py
```

## 运行

### Windows

```bat
start.bat    :: 启动(自动开浏览器 + 崩溃自动重启)
stop.bat     :: 停止(会连同 ffmpeg 转码进程一起结束)
```

若 `python` 不在 PATH 或指向了错误的解释器，在项目目录创建 `python_env.bat`（已被 .gitignore 忽略）：

```bat
set PY="C:\你的\python.exe"
```

### 其他平台

```bash
python server.py
```

打开 `http://127.0.0.1:5000`（局域网内其他设备访问 `http://本机IP:5000`）。

### 首次使用：生成设备清单

程序会自动扫描并生成 `devices.json`（已被 .gitignore 忽略）。两种方式：

1. 页面右上角点 **刷新设备**（后台扫描，稍等几秒到几十秒）
2. 或命令行手动生成：

```bash
python build_inventory.py
```

## 外网访问（可选）

监控墙本身只监听局域网。如需外网访问，推荐复用已有的 **Cloudflare Tunnel**（NAS/任意常开设备上跑 `cloudflared`）：

1. Zero Trust → Networks → Tunnels → 在现有隧道添加一条 Public Hostname
2. `子域名` 自选，Service = `HTTP` → `本机IP:5000`
3. 在 **Access → Applications** 为该主机名加一条登录策略（如 邮箱验证码），避免监控墙裸奔公网

## 常见问题

- **画面显示"无法播放：请用Chrome/Edge打开"**：当前浏览器/内置 WebView 不支持视频解码，请改用桌面版 Chrome / Edge / Safari。
- **IDM 弹出大量下载框**：下载工具接管了 `.ts/.m3u8` 请求。在 IDM 选项中关闭"高级浏览器集成"，或对该站点添加不下载规则。
- **QSV 硬编不可用**：确认 CPU 为 Intel 且驱动正常；如需软编，把 `server.py` 中子码流的 `h264_qsv` 参数换成 `libx264 -preset veryfast -tune zerolatency -crf 26`。
- **端口被占用**：启动时提示"端口已被占用"说明已有实例在运行，先停止再启动。
- **重启后 ffmpeg 进程堆积**：服务启动时会自动清理遗留的孤儿转码进程。

## 目录结构

```
hkivisionTest/
├── server.py            # 监控墙后端 (Flask + waitress)
├── hkilib.py            # 海康设备库: 扫描/RTSP探测/ISAPI/PTZ
├── build_inventory.py   # 设备清单生成器(自动扫描)
├── config.py            # 配置中心(环境变量)
├── static/              # 前端页面
├── devices.example.json # 设备清单格式示例
├── start.bat / stop.bat # Windows 启停
└── requirements.txt
```

## License

MIT
