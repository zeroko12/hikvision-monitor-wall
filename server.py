# -*- coding: utf-8 -*-
"""
海康威视监控墙 (Hikvision Monitor Wall)
- 自动扫描局域网设备，NVR 通道自动展开，生成设备清单 devices.json
- HLS 推流：ffmpeg 拉 RTSP -> 转码 H.264 -> HLS 分片，浏览器 hls.js 播放
  （子码流默认 Intel QSV 硬编 + 360p/10fps 降载，主码流软编保画质）
- ISAPI 控制：抓拍、PTZ 云台（自动检测）、设备刷新
- 生产运行：waitress 多线程常驻，适合 7x24
配置: 环境变量 HK_USER / HK_PWD / HK_SUBNET / HK_SERVER_PORT ... 见 config.py
启动: python server.py   (默认 http://127.0.0.1:5000)
"""
import json
import re
import subprocess
import threading
import time
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, Response
import requests
from requests.auth import HTTPDigestAuth

import hkilib as hk
from config import SERVER_PORT, SERVER_THREADS

BASE = Path(__file__).parent
HLS_DIR = BASE / "hls"
SNAP_DIR = BASE / "snapshots"
LOG_DIR = BASE / "logs"
DEVICES_FILE = BASE / "devices.json"
HLS_DIR.mkdir(exist_ok=True)
SNAP_DIR.mkdir(exist_ok=True)
LOG_DIR.mkdir(exist_ok=True)

app = Flask(__name__, static_folder="static", static_url_path="/static")


@app.after_request
def _no_cache_frontend(resp):
    """前端资源禁用缓存: 升级代码后用户浏览器立即拿到新版本"""
    if resp.mimetype in ("text/html", "application/javascript", "text/css"):
        resp.headers["Cache-Control"] = "no-store"
    return resp

_scanning = False
_scan_lock = threading.Lock()


def load_devices():
    try:
        return json.loads(DEVICES_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"generated_at": "", "count": 0, "devices": []}


def get_device(ip, ch):
    data = load_devices()
    for d in data["devices"]:
        if d["ip"] == ip and d["ch"] == ch:
            return d
    return None


class StreamManager:
    """管理每个(ip,ch,quality)的 ffmpeg HLS 转码进程

    - 启动限流: 同一时刻最多 _MAX_STARTING 个进程处于启动中,
      避免页面首次加载时几十路同时冲击设备(导致RTSP会话占满/临时封锁)
    - 空闲回收: last_hit 超过 IDLE_TIMEOUT 秒无请求 -> janitor 自动停流,
      浏览器离开视口后资源自动释放
    """
    IDLE_TIMEOUT = 120         # 秒, 超过无任何取流请求则回收(前端滚动离开15秒后才释放, 此处兜底)
    START_TIMEOUT = 10         # 秒, ffmpeg 启动到产出 index.m3u8 的等待上限
    HEALTH_SEGMENTS = 2        # 启动后需在 HEALTH_TIMEOUT 内产出的最少分片数
    HEALTH_TIMEOUT = 12        # 秒, 达不到则判启动失败并回收
    MAX_STARTING = 6           # 同时处于启动中的 ffmpeg 上限

    def __init__(self):
        self.procs = {}
        self.lock = threading.Lock()
        self._starting = 0
        self._start_lock = threading.Lock()

    def _key(self, ip, ch, quality):
        return f"{ip}_{ch}_{quality}"

    def touch(self, ip, ch, quality):
        """取流请求(playlist/segment)时刷新活跃时间"""
        key = self._key(ip, ch, quality)
        with self.lock:
            p = self.procs.get(key)
            if p and p["proc"].poll() is None:
                p["last_hit"] = time.time()

    def start(self, ip, ch, quality):
        key = self._key(ip, ch, quality)
        with self.lock:
            proc = self.procs.get(key)
            if proc and proc["proc"].poll() is None:
                proc["last_hit"] = time.time()
                return True
            dev = get_device(ip, ch)
            if not dev or dev.get("status") != "online":
                return False
            info = dev.get(quality) or {}
            v = info.get("video") or {}
            fps = int(v.get("fps") or 15)
            chan = f"{ch}01" if quality == "main" else f"{ch}02"
            outdir = HLS_DIR / key
            outdir.mkdir(exist_ok=True)
            for f in outdir.glob("*"):
                try:
                    f.unlink()
                except Exception:
                    pass
            url = hk.get_rtsp_url(ip, chan)
            logf = open(LOG_DIR / f"{key}.log", "w", encoding="utf-8", errors="replace")
            # 输入低延迟: 减少缓冲/探测, 加快起播并降低端到端延迟
            cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error",
                   "-fflags", "nobuffer", "-flags", "low_delay",
                   "-analyzeduration", "0", "-probesize", "32k",
                   "-rtsp_transport", "tcp", "-timeout", "8000000", "-i", url]
            if quality == "main":
                # 主码流: 软编保画质(单路点看用)
                cmd += ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
                        "-crf", "26", "-g", str(fps), "-sc_threshold", "0",
                        "-c:a", "aac", "-b:a", "24k", "-ac", "1", "-ar", "22050"]
            else:
                # 子码流: QSV 硬编 + 降分辨率360p + 限帧10fps, 大幅降低CPU/功耗
                cmd += ["-c:v", "h264_qsv", "-preset", "veryfast", "-look_ahead", "0",
                        "-b:v", "500k", "-maxrate", "700k", "-bufsize", "1000k",
                        "-r", "10", "-vf", "scale=-2:360", "-an",
                        "-g", "10", "-sc_threshold", "0"]
            # 1s 分片 + 滑窗 6 片(约6秒) + temp_file(写完再改名, 避免半写文件被读到)
            cmd += ["-f", "hls", "-hls_time", "1", "-hls_list_size", "6",
                    "-hls_flags", "delete_segments+temp_file",
                    "-hls_segment_filename", str(outdir / "seg_%05d.ts"),
                    str(outdir / "index.m3u8")]
            # 启动限流: 限制同时"正在拉起"的进程数(仅覆盖 Popen 阶段),
            # 避免页面首次加载时几十路同时冲击设备(导致RTSP会话占满/临时封锁)
            with self._start_lock:
                while self._starting >= self.MAX_STARTING:
                    self._start_lock.release()
                    time.sleep(0.3)
                    self._start_lock.acquire()
                self._starting += 1
            try:
                proc = subprocess.Popen(
                    cmd, stdout=subprocess.DEVNULL, stderr=logf,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except Exception:
                with self._start_lock:
                    self._starting -= 1
                logf.close()
                return False
            with self._start_lock:
                self._starting -= 1
            self.procs[key] = {"proc": proc, "ip": ip, "ch": ch,
                               "quality": quality, "started": time.time(),
                               "last_hit": time.time()}
            return True

    def stop(self, ip, ch, quality=None):
        keys = [self._key(ip, ch, quality)] if quality else \
            [k for k, v in self.procs.items() if v["ip"] == ip and v["ch"] == ch]
        for k in keys:
            p = self.procs.pop(k, None)
            if p:
                try:
                    p["proc"].terminate()
                    p["proc"].wait(timeout=3)
                except Exception:
                    try:
                        p["proc"].kill()
                    except Exception:
                        pass

    def release(self, ip, ch, quality="sub"):
        """浏览器离开视口/关闭弹窗时释放指定质量的转码进程"""
        self.stop(ip, ch, quality)

    def purge_dead(self):
        for k in list(self.procs):
            p = self.procs[k]
            if p["proc"].poll() is not None:
                self.procs.pop(k, None)

    def idle_reclaim(self, now):
        """回收超过 IDLE_TIMEOUT 无取流请求的进程"""
        for k in list(self.procs):
            p = self.procs[k]
            if now - p["last_hit"] > self.IDLE_TIMEOUT:
                self.procs.pop(k, None)
                try:
                    p["proc"].terminate()
                    p["proc"].wait(timeout=3)
                except Exception:
                    try:
                        p["proc"].kill()
                    except Exception:
                        pass


sm = StreamManager()


def janitor():
    """定期清理过期HLS分片 + 回收空闲转码进程(浏览器离开视口后自动停流)"""
    while True:
        try:
            now = time.time()
            sm.idle_reclaim(now)
            for d in HLS_DIR.iterdir():
                if not d.is_dir():
                    continue
                for f in d.glob("seg_*.ts"):
                    try:
                        if now - f.stat().st_mtime > 60:
                            f.unlink()
                    except Exception:
                        pass
        except Exception:
            pass
        time.sleep(15)


threading.Thread(target=janitor, daemon=True).start()


def do_refresh():
    """后台重建设备清单"""
    global _scanning
    try:
        import build_inventory
        build_inventory.build()
    finally:
        _scanning = False


# ---------- 页面与静态资源 ----------
@app.get("/")
def index():
    return send_from_directory(BASE / "static", "index.html")


# ---------- 设备 API ----------
@app.get("/api/devices")
def api_devices():
    sm.purge_dead()
    data = load_devices()
    live = {k: (v["proc"].poll() is None) for k, v in sm.procs.items()}
    data["streams"] = live
    return jsonify(data)


@app.post("/api/devices/refresh")
def api_refresh():
    global _scanning
    with _scan_lock:
        if _scanning:
            return jsonify({"ok": False, "msg": "正在扫描中，请稍候"})
        _scanning = True
    threading.Thread(target=do_refresh, daemon=True).start()
    return jsonify({"ok": True})


@app.get("/api/status")
def api_status():
    return jsonify({"scanning": _scanning})


# ---------- HLS 推流 ----------
# 注意：为规避 IDM 等下载工具按 .ts/.m3u8 扩展名拦截，
# 播放列表与分片统一使用无扩展名 URL（/live、/seg/N），
# 并在服务端重写播放列表中的分片地址。
@app.get("/stream/<ip>/<int:ch>/<quality>/live")
def stream_playlist(ip, ch, quality):
    if quality not in ("main", "sub"):
        return jsonify({"error": "bad quality"}), 400
    key = f"{ip}_{ch}_{quality}"
    outdir = HLS_DIR / key
    if not sm.start(ip, ch, quality):
        return jsonify({"error": "无法启动流(设备离线或凭据失败)"}), 502
    sm.touch(ip, ch, quality)
    deadline = time.time() + sm.START_TIMEOUT
    while time.time() < deadline:
        if (outdir / "index.m3u8").exists():
            break
        proc = sm.procs.get(key)
        if not proc or proc["proc"].poll() is not None:
            sm.stop(ip, ch, quality)
            return jsonify({"error": "ffmpeg退出(见logs目录日志)"}), 502
        time.sleep(0.3)
    if not (outdir / "index.m3u8").exists():
        sm.stop(ip, ch, quality)
        return jsonify({"error": "流启动超时"}), 504
    # 健康检查: 启动后需在 HEALTH_TIMEOUT 内产出分片, 否则判失败(设备推流异常), 避免前端无限黑屏
    started = (sm.procs.get(key) or {}).get("started", time.time())
    while time.time() - started < sm.HEALTH_TIMEOUT:
        if len(list(outdir.glob("seg_*.ts"))) >= sm.HEALTH_SEGMENTS:
            break
        time.sleep(0.3)
    else:
        sm.stop(ip, ch, quality)
        return jsonify({"error": "流启动失败(设备未推流)"}), 502
    playlist = outdir / "index.m3u8"
    content = None
    for _ in range(20):
        try:
            content = playlist.read_text(encoding="utf-8", errors="replace")
            break
        except PermissionError:
            time.sleep(0.1)  # ffmpeg正在重写播放列表,等待锁释放
    if content is None:
        return jsonify({"error": "播放列表忙,请稍候重试"}), 503
    content = re.sub(r"seg_(\d+)\.ts", r"seg/\1", content)
    resp = Response(content, mimetype="application/vnd.apple.mpegurl")
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["Content-Disposition"] = "inline"
    return resp


@app.get("/stream/<ip>/<int:ch>/<quality>/seg/<int:num>")
def stream_segment(ip, ch, quality, num):
    if quality not in ("main", "sub"):
        return jsonify({"error": "bad quality"}), 400
    sm.touch(ip, ch, quality)
    key = f"{ip}_{ch}_{quality}"
    fname = f"seg_{num:05d}.ts"
    try:
        return send_from_directory(HLS_DIR / key, fname, mimetype="video/mp2t",
                                   conditional=True)
    except Exception:
        return jsonify({"error": "segment not found"}), 404


@app.post("/api/stream/release/<ip>/<int:ch>")
@app.post("/api/stream/release/<ip>/<int:ch>/<quality>")
def api_stream_release(ip, ch, quality="sub"):
    """浏览器离开视口/关闭弹窗时释放转码进程, 节省CPU与设备会话"""
    if quality not in ("main", "sub"):
        return jsonify({"error": "bad quality"}), 400
    sm.release(ip, ch, quality)
    return jsonify({"ok": True})


@app.get("/stream/<ip>/<int:ch>/<quality>/<path:filename>")
def stream_file(ip, ch, quality, filename):
    """兼容旧式带扩展名访问（浏览器脚本不再使用）"""
    if quality not in ("main", "sub"):
        return jsonify({"error": "bad quality"}), 400
    key = f"{ip}_{ch}_{quality}"
    outdir = HLS_DIR / key
    if filename == "index.m3u8":
        if not sm.start(ip, ch, quality):
            return jsonify({"error": "无法启动流(设备离线或凭据失败)"}), 502
        deadline = time.time() + 15
        while time.time() < deadline:
            if (outdir / "index.m3u8").exists():
                break
            time.sleep(0.3)
        if not (outdir / "index.m3u8").exists():
            sm.stop(ip, ch, quality)
            return jsonify({"error": "流启动超时"}), 504
        return send_from_directory(outdir, filename,
                                   mimetype="application/vnd.apple.mpegurl")
    if filename.endswith(".ts"):
        try:
            return send_from_directory(outdir, filename, mimetype="video/mp2t")
        except Exception:
            return jsonify({"error": "segment not found"}), 404
    return jsonify({"error": "not found"}), 404


# ---------- 抓拍 ----------
@app.get("/api/snapshot/<ip>/<int:ch>")
def api_snapshot(ip, ch):
    dev = get_device(ip, ch)
    if not dev or dev.get("status") != "online":
        return jsonify({"error": "设备不在线"}), 404
    chan = f"{ch}01"
    img = hk.snapshot_isapi(ip, chan) or hk.snapshot_ffmpeg(ip, chan)
    if not img:
        return jsonify({"error": "抓拍失败"}), 502
    return Response(img, mimetype="image/jpeg",
                    headers={"Cache-Control": "no-store"})


# ---------- PTZ 云台 ----------
_PAN_TILT = {
    "up": (0, 0.5), "down": (0, -0.5), "left": (-0.5, 0),
    "right": (0.5, 0), "up-left": (-0.5, 0.5), "up-right": (0.5, 0.5),
    "down-left": (-0.5, -0.5), "down-right": (0.5, -0.5),
    "zoomin": (0, 0, 0.5), "zoomout": (0, 0, -0.5),
}
_STOP = {"stop": (0, 0, 0), "zoomstop": (0, 0, 0)}


@app.post("/api/ptz/<ip>/<int:ch>/<cmd>")
def api_ptz(ip, ch, cmd):
    dev = get_device(ip, ch)
    if not dev or dev.get("status") != "online":
        return jsonify({"error": "设备不在线"}), 404
    if cmd in _STOP:
        pan, tilt, zoom = _STOP[cmd]
        url = f"http://{ip}/ISAPI/PTZCtrl/channels/{ch}/stop"
        body = ""
    elif cmd in _PAN_TILT:
        pan, tilt, zoom = _PAN_TILT[cmd]
        url = f"http://{ip}/ISAPI/PTZCtrl/channels/{ch}/continuous"
        body = (f"<PTZData><pan>{pan}</pan><tilt>{tilt}</tilt>"
                f"<zoom>{zoom}</zoom></PTZData>")
    else:
        return jsonify({"error": "未知指令"}), 400
    try:
        r = requests.put(url, data=body, auth=HTTPDigestAuth(hk.USER, hk.PWD),
                         headers={"Content-Type": "application/xml"}, timeout=8)
        if r.status_code in (200, 201, 202):
            return jsonify({"ok": True})
        return jsonify({"ok": False, "http": r.status_code}), 502
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


if __name__ == "__main__":
    print(f"监控墙服务已启动: http://127.0.0.1:{SERVER_PORT}")
    # 端口预检: 已有服务在跑则退出(避免双开)
    import socket
    _probe = socket.socket()
    try:
        _probe.bind(("0.0.0.0", SERVER_PORT))
        _probe.close()
    except OSError:
        print(f"端口{SERVER_PORT}已被占用，可能服务已在运行。请先停止再启动。")
        raise SystemExit(1)
    # 清理上一次遗留的孤儿 ffmpeg 转码进程(服务崩溃重启时避免进程堆积)
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\" | Where-Object { $_.CommandLine -match 'rtsp://' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
            capture_output=True, timeout=20)
    except Exception:
        pass
    try:
        # 生产服务器 waitress: 多线程常驻, 适合7x24运行
        from waitress import serve
        serve(app, host="0.0.0.0", port=SERVER_PORT, threads=SERVER_THREADS)
    except ImportError:
        app.run(host="0.0.0.0", port=SERVER_PORT, threaded=True)
