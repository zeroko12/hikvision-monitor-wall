# -*- coding: utf-8 -*-
"""生成 devices.json 设备清单：扫描子网 -> 探测RTSP -> NVR通道展开 -> 型号/PTZ"""
import concurrent.futures
import json
import time
from pathlib import Path

import hkilib as hk

BASE = Path(__file__).parent
OUT = BASE / "devices.json"


def probe_one_device(ip):
    """探测一台独立设备；若是NVR则展开其通道，返回 tile 列表"""
    main = hk.probe_rtsp(ip, "101")
    if main is None:
        return [{"id": f"{ip}_1", "ip": ip, "ch": 1, "src": "auth_failed",
                 "name": f"{ip}", "model": "", "camera_ip": "",
                 "status": "auth_failed", "reason": "RTSP认证失败或无响应",
                 "main": None, "sub": None, "ptz": False}]

    info = hk.get_device_info(ip)
    model = (info or {}).get("model") or ""
    dev_type = hk.get_device_type(ip)
    is_nvr = dev_type == "Recorder" or __import__("re").match(r"^(i?DS-)[789]", model)
    if is_nvr:
        return probe_nvr(ip)
    # 普通 IPC
    sub = hk.probe_rtsp(ip, "102")
    ptz = hk.ptz_supported(ip)
    return [{"id": f"{ip}_1", "ip": ip, "ch": 1, "src": "camera",
             "name": f"Camera-{ip.rsplit('.',1)[-1]}",
             "model": model or "未知型号",
             "camera_ip": ip, "status": "online",
             "main": main, "sub": sub, "ptz": ptz}]


def probe_nvr(ip):
    """NVR：枚举通道，逐路探测 RTSP {ch}01"""
    info = hk.get_device_info(ip)
    channels = hk.get_nvr_channels(ip)
    tiles = []
    if not channels:
        # 通道枚举失败时降级为单路
        sub = hk.probe_rtsp(ip, "102")
        return [{"id": f"{ip}_1", "ip": ip, "ch": 1, "src": "nvr",
                 "name": f"NVR-{ip}", "model": (info or {}).get("model") or "",
                 "camera_ip": "", "status": "online",
                 "main": hk.probe_rtsp(ip, "101"), "sub": sub, "ptz": False}]
    for c in channels:
        m = hk.probe_rtsp(ip, f"{c['ch']}01", timeout_s=8)
        if m is None:
            tiles.append({"id": f"{ip}_{c['ch']}", "ip": ip, "ch": c["ch"],
                          "src": "nvr", "name": c["name"] or f"CH{c['ch']}",
                          "model": c["model"], "camera_ip": c["camera_ip"],
                          "status": "offline", "main": None, "sub": None,
                          "ptz": False})
            continue
        sub = hk.probe_rtsp(ip, f"{c['ch']}02", timeout_s=8)
        tiles.append({"id": f"{ip}_{c['ch']}", "ip": ip, "ch": c["ch"],
                      "src": "nvr", "name": c["name"] or f"CH{c['ch']}",
                      "model": c["model"], "camera_ip": c["camera_ip"],
                      "status": "online", "main": m, "sub": sub,
                      "ptz": hk.ptz_supported(ip)})
    return tiles


def build(rtsp_ips=None):
    if rtsp_ips is None:
        scan = hk.scan_subnet()
        rtsp_ips = sorted(
            [ip for ip, ports in scan.items() if hk.RTSP_PORT in ports],
            key=lambda x: int(x.split(".")[-1]),
        )

    all_tiles = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        for tiles in ex.map(probe_one_device, rtsp_ips):
            all_tiles.extend(tiles)

    all_tiles.sort(key=lambda d: (d["ip"], d["ch"]))
    OUT.write_text(json.dumps({"generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                               "count": len(all_tiles),
                               "devices": all_tiles},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    online = sum(1 for d in all_tiles if d["status"] == "online")
    print(f"已写入 {OUT}  (共 {len(all_tiles)} 路画面, 在线 {online} 路)")
    for d in all_tiles:
        m = d.get("main") or {}
        v = m.get("video") or {}
        res = f"{v.get('width')}x{v.get('height')}" if v else "-"
        src = d["src"]
        cam = f" <-{d['camera_ip']}" if src == "nvr" and d["camera_ip"] else ""
        print(f"  {d['ip']:16s} ch{d['ch']:<3d} {d['status']:11s} "
              f"{d.get('model',''):22s} 主:{res:11s} {cam}")
    return all_tiles


if __name__ == "__main__":
    build()
