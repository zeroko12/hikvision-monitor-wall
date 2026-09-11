# -*- coding: utf-8 -*-
"""海康威视/OEM 设备探测库：子网扫描、RTSP探测、ISAPI信息查询、PTZ能力检测"""
import concurrent.futures
import re
import socket
import subprocess
import time

import requests
from requests.auth import HTTPDigestAuth

from config import USER, PWD, RTSP_PORT, HTTP_PORT, SDK_PORT, SUBNET


def scan_subnet(subnet=SUBNET, ports=(HTTP_PORT, RTSP_PORT, SDK_PORT), timeout=0.4):
    """并发扫描子网(默认配置的网段)，返回 {ip: [开放端口...]}"""
    targets = [(f"{subnet}.{i}", p) for i in range(1, 255) for p in ports]

    def check(t):
        ip, port = t
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        try:
            if s.connect_ex((ip, port)) == 0:
                return ip, port
        except Exception:
            pass
        finally:
            s.close()
        return None

    by_ip = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=300) as ex:
        for r in ex.map(check, targets):
            if r:
                by_ip.setdefault(r[0], []).append(r[1])
    return {ip: sorted(ports) for ip, ports in by_ip.items()}


def get_rtsp_url(ip, channel="101", user=USER, pwd=PWD, port=RTSP_PORT):
    return f"rtsp://{user}:{pwd}@{ip}:{port}/Streaming/Channels/{channel}"


def probe_rtsp(ip, channel="101", user=USER, pwd=PWD, timeout_s=10):
    """用 ffprobe 探测一路流，返回 {video, audio} 或 None"""
    url = get_rtsp_url(ip, channel, user, pwd)
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-rtsp_transport", "tcp",
             "-timeout", str(int(timeout_s * 1e6)),
             "-show_entries", "stream=codec_name,codec_type,width,height,avg_frame_rate",
             "-of", "csv=p=0", url],
            capture_output=True, text=True, timeout=timeout_s + 5,
        )
        out = (r.stdout or "").strip()
        if not out:
            return None
        video, audio = None, False
        for line in out.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 2:
                continue
            if parts[1] == "video":
                s = {"codec": parts[0]}
                if len(parts) > 2 and parts[2]:
                    s["width"] = int(parts[2])
                if len(parts) > 3 and parts[3]:
                    s["height"] = int(parts[3])
                if len(parts) > 4 and parts[4] and parts[4] != "0/0":
                    try:
                        n, d = parts[4].split("/")
                        if int(d):
                            s["fps"] = round(int(n) / int(d), 2)
                    except Exception:
                        pass
                video = s
            elif parts[1] == "audio":
                audio = True
        return {"video": video, "audio": audio} if video else None
    except subprocess.TimeoutExpired:
        return None
    except Exception:
        return None


def get_device_info(ip, user=USER, pwd=PWD, timeout=8):
    """ISAPI 查询设备型号信息，失败返回 None"""
    try:
        r = requests.get(f"http://{ip}/ISAPI/System/deviceInfo",
                         auth=HTTPDigestAuth(user, pwd), timeout=timeout)
        if r.status_code != 200:
            return None

        def g(tag):
            m = re.search(f"<{tag}>(.*?)</{tag}>", r.text)
            return m.group(1).strip() if m else None

        return {"model": g("model"), "serial": g("serialNumber"),
                "name": g("deviceName"), "firmware": g("firmwareVersion")}
    except Exception:
        return None


def ptz_supported(ip, user=USER, pwd=PWD, timeout=8):
    """检测是否支持云台(PTZ)控制；HTTP 200 表示支持"""
    try:
        r = requests.get(f"http://{ip}/ISAPI/PTZCtrl/channels",
                         auth=HTTPDigestAuth(user, pwd), timeout=timeout)
        return r.status_code == 200
    except Exception:
        return False


def get_device_type(ip, user=USER, pwd=PWD, timeout=8):
    """返回设备类型: IPCamera / Recorder / None"""
    info = get_device_info(ip, user, pwd, timeout)
    if not info:
        return None
    try:
        r = requests.get(f"http://{ip}/ISAPI/System/deviceInfo",
                         auth=HTTPDigestAuth(user, pwd), timeout=timeout)
        m = re.search(r"<deviceType>(.*?)</deviceType>", r.text)
        return m.group(1).strip() if m else None
    except Exception:
        return None


def get_nvr_channels(ip, user=USER, pwd=PWD, timeout=10):
    """枚举 NVR 录像机的输入通道，返回 [{ch,name,camera_ip,model}]"""
    try:
        r = requests.get(f"http://{ip}/ISAPI/ContentMgmt/InputProxy/channels",
                         auth=HTTPDigestAuth(user, pwd), timeout=timeout)
        if r.status_code != 200:
            return []
    except Exception:
        return []
    out = []
    for blk in re.findall(r"<InputProxyChannel[^>]*>.*?</InputProxyChannel>",
                          r.text, re.S):
        ch = re.search(r"<id>(\d+)</id>", blk)
        if not ch:
            continue
        name = re.search(r"<name>([^<]*)</name>", blk)
        ipm = re.search(r"<ipAddress>([^<]*)</ipAddress>", blk)
        model = re.search(r"<model>([^<]*)</model>", blk)
        out.append({"ch": int(ch.group(1)),
                    "name": (name.group(1) if name else "").strip(),
                    "camera_ip": ipm.group(1) if ipm else "",
                    "model": (model.group(1) if model else "").strip()})
    return out


def snapshot_isapi(ip, channel="101", user=USER, pwd=PWD, timeout=10):
    """通过 ISAPI 抓拍一帧 JPEG，成功返回 bytes，失败返回 None"""
    try:
        r = requests.get(f"http://{ip}/ISAPI/Streaming/channels/{channel}/picture",
                         auth=HTTPDigestAuth(user, pwd), timeout=timeout)
        if r.status_code == 200 and r.content[:2] == b"\xff\xd8":
            return r.content
    except Exception:
        pass
    return None


def snapshot_ffmpeg(ip, channel="101", user=USER, pwd=PWD, timeout=15):
    """ffmpeg 兜底抓帧（ISAPI 失败时使用）"""
    try:
        url = get_rtsp_url(ip, channel, user, pwd)
        r = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-rtsp_transport", "tcp",
             "-timeout", "8000000", "-i", url,
             "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
            capture_output=True, timeout=timeout,
        )
        if r.returncode == 0 and r.stdout[:2] == b"\xff\xd8":
            return r.stdout
    except Exception:
        pass
    return None
