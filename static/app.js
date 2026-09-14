"use strict";

// ================= 状态与偏好持久化 =================
const PREFS_KEY = "hkwall_prefs_v1";

const state = {
  devices: [],
  mainList: [],          // 主网格设备(未过滤隐藏)
  hls: new Map(),        // tileId -> hls instance
  prefs: loadPrefs(),
  io: null,
  ioFallback: false,
};

const $ = (id) => document.getElementById(id);

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return {
      order: Array.isArray(p.order) ? p.order : [],
      hidden: (p.hidden && typeof p.hidden === "object") ? p.hidden : {},
    };
  } catch (e) {
    return { order: [], hidden: {} };
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
  } catch (e) { /* localStorage 不可用时静默降级 */ }
}

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ================= 设备加载与分组 =================
async function loadDevices() {
  const data = await fetchJSON("/api/devices");
  const list = data.devices || [];
  state.devices = list;
  const directIps = new Set(
    list.filter(d => d.src === "camera" && d.status === "online").map(d => d.ip)
  );
  const main = [], dups = [], failed = [];
  for (const d of list) {
    if (d.status === "auth_failed") { failed.push(d); continue; }
    if (d.src === "nvr" && d.camera_ip && directIps.has(d.camera_ip)) {
      dups.push(d); continue;
    }
    main.push(d);
  }
  state.mainList = main;
  // 应用用户偏好: 排序 + 隐藏
  const order = state.prefs.order;
  if (order.length) {
    const idx = new Map(main.map((d, i) => [tileId(d), i]));
    main.sort((a, b) => {
      const ia = order.indexOf(tileId(a)), ib = order.indexOf(tileId(b));
      if (ia === -1 && ib === -1) return idx.get(tileId(a)) - idx.get(tileId(b));
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }
  const visible = main.filter(d => !state.prefs.hidden[tileId(d)]);
  renderGrid("grid", visible, true);
  renderGrid("grid-duplicate", dups, false);
  renderGrid("grid-failed", failed, false);
  $("duplicate-section").classList.toggle("hidden", dups.length === 0);
  $("failed-section").classList.toggle("hidden", failed.length === 0);
  $("empty").classList.toggle("hidden", visible.length > 0);
  $("stat-total").textContent = list.length;
  $("stat-online").textContent = list.filter(d => d.status === "online").length;
  $("stat-failed").textContent = failed.length;
  const hiddenCount = main.length - visible.length;
  $("stat-hidden").textContent = hiddenCount || "";
  $("stat-hidden").classList.toggle("bad", hiddenCount > 0);
  $("btn-manage").classList.toggle("hidden", main.length === 0);
  $("drag-hint").classList.toggle("hidden", visible.length < 2);
  initObserver();
  if (state.ioFallback) fallbackScan();
}

function tileId(d) { return `${d.ip}_${d.ch}`; }

function makeTile(d, lazy) {
  const t = document.createElement("div");
  t.className = "tile" + (d.status !== "online" ? " no-signal" : "");
  t.dataset.id = tileId(d);
  t.dataset.ip = d.ip;
  t.dataset.ch = d.ch;
  t.dataset.ptz = d.ptz;
  t.dataset.online = d.status === "online" ? "1" : "0";
  t.draggable = true;
  t.innerHTML = `
    <video muted playsinline preload="none"></video>
    <div class="poster hidden">
      <span class="big">${d.status === "auth_failed" ? "🔒" : "📡"}</span>
      <span>${d.status === "auth_failed" ? "凭据失败(需单独密码)" :
              d.status === "offline" ? "无信号" : "加载中…"}</span>
    </div>
    <div class="label">
      <span><b>${d.ip}</b> <span class="model">CH${d.ch} · ${d.model || ""}</span></span>
      <span class="dot ${d.status === "online" ? "live" :
            d.status === "auth_failed" ? "off" : "dead"}"></span>
    </div>`;
  t.addEventListener("click", () => openModal(d));
  if (lazy && d.status === "online") observeTile(t, d);
  return t;
}

function renderGrid(containerId, list, lazy) {
  const grid = $(containerId);
  grid.innerHTML = "";
  for (const d of list) grid.appendChild(makeTile(d, lazy));
}

// ================= 视口优化: 进入视口才取流, 离开即释放 =================
// 注意: 部分内嵌浏览器虽支持 IntersectionObserver 但不触发回调,
// 因此 IO 之外始终叠加"滚动+定时"兜底扫描(幂等, 不会重复启动)
let safetyTimer = null;

function startSafetyScan() {
  if (safetyTimer) return;
  safetyTimer = setInterval(() => {
    if (document.hidden) return;
    fallbackScan();
  }, 2500);
}

function initObserver() {
  if (state.io) return;
  if (!("IntersectionObserver" in window)) {
    state.ioFallback = true;
  } else {
    state.io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const t = en.target;
        if (en.isIntersecting) {
          if (!t._attached && t.dataset.online === "1") attachStream(t);
        } else {
          detachStream(t);
        }
      }
    }, { rootMargin: "300px 0px 300px 0px" });
  }
  window.addEventListener("scroll", scheduleFallback, { passive: true });
  window.addEventListener("resize", scheduleFallback);
  startSafetyScan();
}

function observeTile(tile, dev) {
  tile._dev = dev;
  if (state.io) state.io.observe(tile);
}

// 降级路径: 不支持 IntersectionObserver 时用滚动检测(带离开释放)
let attachTimer = null;

function fallbackScan() {
  const vh = window.innerHeight || document.documentElement.clientHeight;
  for (const t of document.querySelectorAll("#grid .tile")) {
    if (!t._dev) continue;
    const r = t.getBoundingClientRect();
    const vis = r.bottom > -400 && r.top < vh + 400;
    if (vis) { if (!t._attached && t.dataset.online === "1") attachStream(t); }
    else detachStream(t);
  }
}

function scheduleFallback() {
  if (attachTimer) return;
  attachTimer = setTimeout(() => { attachTimer = null; fallbackScan(); }, 150);
}

// 离开视口: 保留热流15秒(滚动返回秒开), 超时未返回才销毁并释放后端转码
function detachStream(tile, immediate) {
  if (!tile._attached) return;
  tile._attached = false;
  tile._retries = 0;
  const id = tile.dataset.id;
  const video = tile.querySelector("video");
  const h = state.hls.get(id);
  clearTimeout(tile._stallTimer);
  clearTimeout(tile._timeout);
  if (h && !h.destroyed && !immediate) {
    try { h.stopLoad(); } catch (e) {}
    try { video.pause(); } catch (e) {}
    tile._releaseTimer = setTimeout(() => {
      const hh = state.hls.get(id);
      if (hh) { try { hh.destroy(); } catch (e) {} state.hls.delete(id); }
      if (video) { video.removeAttribute("src"); video.load(); }
      fetch(`/api/stream/release/${tile.dataset.ip}/${tile.dataset.ch}`, { method: "POST" }).catch(() => {});
    }, 15000);
  } else {
    if (h) { try { h.destroy(); } catch (e) {} state.hls.delete(id); }
    if (video) { video.removeAttribute("src"); video.load(); }
    fetch(`/api/stream/release/${tile.dataset.ip}/${tile.dataset.ch}`, { method: "POST" }).catch(() => {});
  }
}

// hls.js 低延迟/容错配置
const HLS_CFG = {
  liveSyncDurationCount: 2,      // 缓冲约2个分片, 端到端延迟2~3秒
  liveMaxLatencyDurationCount: 8,
  maxLiveSyncPlaybackRate: 1.5,
  startPosition: -2,
  manifestLoadingTimeOut: 6000,
  levelLoadingTimeOut: 6000,
  fragLoadingTimeOut: 8000,
  manifestLoadingMaxRetry: 2,
  levelLoadingMaxRetry: 2,
  fragLoadingMaxRetry: 3,
};

function attachStream(tile) {
  if (tile._attached) return;
  tile._attached = true;
  const dev = tile._dev;
  const video = tile.querySelector("video");
  const poster = tile.querySelector(".poster");
  const id = tile.dataset.id;
  const url = `/stream/${dev.ip}/${dev.ch}/sub/live`;
  const canNative = video.canPlayType("application/vnd.apple.mpegurl");
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  let hls = null;
  const cleanup = () => {
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    state.hls.delete(id);
    clearTimeout(tile._stallTimer);
    clearTimeout(tile._timeout);
  };

  // 卡住检测: 画面停滞超过5秒则强制重建
  let lastTime = -1, stallCount = 0;
  const stallWatch = () => {
    tile._stallTimer = setTimeout(() => {
      if (!tile._attached || !video.currentTime) { stallWatch(); return; }
      // 已attach却暂停/画面停滞(流可能已死) → 计入停滞, 累计2次强制重建
      const stalled = video.paused ||
        (!video.paused && video.readyState >= 2 &&
         Math.abs(video.currentTime - lastTime) < 0.001);
      if (stalled) {
        stallCount++;
        if (stallCount >= 2 && tile._retries < 3) {
          tile._retries++;
          stallCount = 0;
          cleanup();
          setTimeout(() => {
            tile._attached = false;   // 关键: 先释放占用标记, 重连才会真正执行
            if (tile._dev) attachStream(tile);
          }, 1500);
          return;
        }
      } else {
        stallCount = 0;
      }
      lastTime = video.currentTime;
      stallWatch();
    }, 3000);
  };

  // 失败原因提示: 区分"设备拒绝/无响应"与"浏览器不支持"
  const failReason = (data) => {
    const code = data && data.response && data.response.code;
    if (code === 502 || code === 504) return "该路设备拒绝连接(会话满或离线)";
    if (code === 404) return "该路通道不存在";
    return "该路设备无响应";
  };

  const showPoster = (msg) => {
    poster.classList.remove("hidden");
    poster.querySelector("span").textContent = msg;
  };

  // 统一重试入口: 已有画面则直接恢复, 否则按退避重连(最多3次)
  const retryStream = (finalMsg) => {
    const rt = tile._retries || 0;
    if (rt >= 3) { showPoster(finalMsg); return; }
    if (video.videoWidth > 0 || video.readyState >= 2) {
      poster.classList.add("hidden");
      return;
    }
    showPoster("加载中…自动重试");
    cleanup();
    const backoff = [2000, 4000, 8000][Math.min(rt, 2)];
    setTimeout(() => {
      tile._retries = (tile._retries || 0) + 1;
      tile._attached = false;   // 关键: 释放占用标记后才能真正重连
      if (tile._dev) attachStream(tile);
    }, backoff);
  };

  // 加载超时: 12秒无画面则提示并自动重试
  tile._timeout = setTimeout(() => {
    if (video.videoWidth > 0 || video.readyState > 0) {
      poster.classList.add("hidden");
      return;
    }
    retryStream("该路设备无响应，点击重试");
  }, 12000);

  const bindErrors = (h) => {
    h.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        retryStream(failReason(data) + "，点击重试");
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        try { h.recoverMediaError(); } catch (e) { retryStream(failReason(data) + "，点击重试"); }
      } else {
        retryStream(failReason(data) + "，点击重试");
      }
    });
  };

  // ===== 热流恢复: 刚离开视口(15秒内)保留的实例直接续播, 秒开 =====
  const kept = state.hls.get(id);
  if (kept && !kept.destroyed) {
    clearTimeout(tile._releaseTimer);
    tile._releaseTimer = null;
    poster.classList.add("hidden");
    hls = kept;
    try { hls.startLoad(); } catch (e) { failRetry(); return; }
    video.play().catch(() => {});
    lastTime = video.currentTime || 0;
    stallWatch();
    return;
  }

  if (Hls.isSupported() && !(isApple && canNative)) {
    hls = new Hls(HLS_CFG);
    state.hls.set(id, hls);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      poster.classList.add("hidden");
      video.play().catch(() => {});
      lastTime = video.currentTime || 0;
      stallWatch();
    });
    bindErrors(hls);
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (canNative) {
    video.src = url;
    video.load();
    video.addEventListener("loadedmetadata", () => {
      poster.classList.add("hidden");
      video.play().catch(() => {});
      lastTime = video.currentTime || 0;
      stallWatch();
    }, { once: true });
  } else {
    poster.classList.remove("hidden");
    poster.querySelector("span").textContent = "浏览器不支持播放，请用Chrome/Edge";
  }
}

// ================= 拖拽排序(持久化到 localStorage) =================
function enableDrag(grid) {
  grid.addEventListener("dragstart", (e) => {
    const t = e.target.closest(".tile");
    if (!t) return;
    t.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", t.dataset.id); } catch (err) {}
  });
  grid.addEventListener("dragend", () => {
    grid.querySelectorAll(".dragging").forEach(x => x.classList.remove("dragging"));
    persistOrder();
  });
  grid.addEventListener("dragover", (e) => {
    e.preventDefault();
    const dragging = grid.querySelector(".dragging");
    if (!dragging) return;
    const after = dragAfterElement(grid, e.clientY);
    if (after == null) grid.appendChild(dragging);
    else grid.insertBefore(dragging, after);
  });
}

function dragAfterElement(grid, y) {
  const els = [...grid.querySelectorAll(".tile:not(.dragging)")];
  let closest = { offset: -Infinity, el: null };
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const off = y - r.top - r.height / 2;
    if (off < 0 && off > closest.offset) closest = { offset: off, el };
  }
  return closest.el;
}

function persistOrder() {
  state.prefs.order = [...$("grid").querySelectorAll(".tile")].map(t => t.dataset.id);
  savePrefs();
}

// ================= 通道管理(隐藏/显示 + 排序) =================
function initOrderIfNeeded() {
  if (state.prefs.order.length) return;
  state.prefs.order = [...$("grid").querySelectorAll(".tile")].map(t => t.dataset.id);
  savePrefs();
}

function moveInOrder(id, dir) {
  initOrderIfNeeded();
  const o = state.prefs.order;
  const i = o.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= o.length) return;
  [o[i], o[j]] = [o[j], o[i]];
  savePrefs();
  reorderGrid();
  renderManage();
}

function reorderGrid() {
  const grid = $("grid");
  const rank = new Map(state.prefs.order.map((id, idx) => [id, idx]));
  [...grid.querySelectorAll(".tile")]
    .sort((a, b) => (rank.get(a.dataset.id) ?? 1e9) - (rank.get(b.dataset.id) ?? 1e9))
    .forEach(t => grid.appendChild(t));
}

function renderManage() {
  const box = $("mng-list");
  box.innerHTML = "";
  for (const d of state.mainList) {
    const id = tileId(d);
    const row = document.createElement("div");
    row.className = "mng-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !state.prefs.hidden[id];
    cb.onchange = () => {
      if (cb.checked) delete state.prefs.hidden[id];
      else state.prefs.hidden[id] = true;
      savePrefs();
      applyVisibility(id);
    };
    const name = document.createElement("span");
    name.className = "mng-name";
    const st = d.status === "online" ? "" : d.status === "offline" ? " (离线)" : " (凭据失败)";
    name.textContent = `${d.ip} · CH${d.ch} · ${d.model || ""}${st}`;
    const up = document.createElement("button");
    up.className = "mng-mv"; up.textContent = "↑";
    up.title = "上移"; up.onclick = () => moveInOrder(id, -1);
    const down = document.createElement("button");
    down.className = "mng-mv"; down.textContent = "↓";
    down.title = "下移"; down.onclick = () => moveInOrder(id, 1);
    row.appendChild(cb);
    row.appendChild(name);
    row.appendChild(up);
    row.appendChild(down);
    box.appendChild(row);
  }
}

// 只增删被切换的那一块, 不打扰其它在播画面
function applyVisibility(id) {
  const grid = $("grid");
  const hidden = !!state.prefs.hidden[id];
  const tile = grid.querySelector(`.tile[data-id="${CSS.escape(id)}"]`);
  if (hidden && tile) { detachStream(tile, true); tile.remove(); }
  if (!hidden && !tile) {
    const d = state.mainList.find(x => tileId(x) === id);
    if (d) grid.appendChild(makeTile(d, true));
  }
  const visCount = grid.querySelectorAll(".tile").length;
  $("empty").classList.toggle("hidden", visCount > 0);
  const hiddenCount = state.mainList.length - visCount;
  $("stat-hidden").textContent = hiddenCount || "";
  $("stat-hidden").classList.toggle("bad", hiddenCount > 0);
  $("drag-hint").classList.toggle("hidden", visCount < 2);
}

$("btn-manage").onclick = () => {
  renderManage();
  $("manage").classList.remove("hidden");
};
$("mng-close").onclick = () => $("manage").classList.add("hidden");
$("mng-reset").onclick = () => {
  state.prefs.order = [];
  state.prefs.hidden = {};
  savePrefs();
  // 停掉全部主网格流并整体重建
  const grid = $("grid");
  for (const t of [...grid.querySelectorAll(".tile")]) detachStream(t, true);
  loadDevices();
  $("manage").classList.add("hidden");
};

// ================= 详情弹窗 =================
let modalDev = null;
let modalHls = null;
let modalQuality = "sub";

function openModal(d) {
  modalDev = d;
  modalQuality = "sub";
  $("modal-title").textContent = `${d.ip} · CH${d.ch} · ${d.model || ""}`;
  $("m-sub").classList.add("active");
  $("m-main").classList.remove("active");
  $("modal-ptz").classList.toggle("hidden", !d.ptz || d.status !== "online");
  hideSnapshot();
  if (d.status !== "online") {
    $("modal-video").src = "";
    if (modalHls) { modalHls.destroy(); modalHls = null; }
  } else {
    playModal(d, "sub");
  }
  $("modal").classList.remove("hidden");
}

function playModal(d, quality) {
  if (modalHls) { modalHls.destroy(); modalHls = null; }
  const video = $("modal-video");
  video.src = "";
  video.muted = quality === "sub" ? true : false;
  const url = `/stream/${d.ip}/${d.ch}/${quality}/live`;
  const canNative = video.canPlayType("application/vnd.apple.mpegurl");
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  if (Hls.isSupported() && !(isApple && canNative)) {
    modalHls = new Hls(HLS_CFG);
    modalHls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        try { modalHls.destroy(); } catch (e) {}
        modalHls = null;
        setTimeout(() => playModal(modalDev, modalQuality), 3000);
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        modalHls.recoverMediaError();
      }
    });
    modalHls.loadSource(url);
    modalHls.attachMedia(video);
  } else if (canNative) {
    video.src = url;
    video.load();
  }
  video.play().catch(() => {});
}

$("m-main").onclick = () => { modalQuality = "main"; $("m-main").classList.add("active"); $("m-sub").classList.remove("active"); playModal(modalDev, "main"); };
$("m-sub").onclick = () => { modalQuality = "sub"; $("m-sub").classList.add("active"); $("m-main").classList.remove("active"); playModal(modalDev, "sub"); };
$("m-close").onclick = () => {
  $("modal").classList.add("hidden");
  if (modalHls) { modalHls.destroy(); modalHls = null; }
  hideSnapshot();
  if (modalDev) {
    fetch(`/api/stream/release/${modalDev.ip}/${modalDev.ch}/main`, { method: "POST" }).catch(() => {});
  }
};
$("m-full").onclick = () => {
  const wrap = document.querySelector(".video-wrap");
  if (document.fullscreenElement) document.exitFullscreen();
  else wrap.requestFullscreen().catch(() => {});
};
$("m-snap").onclick = async () => {
  try {
    const r = await fetch(`/api/snapshot/${modalDev.ip}/${modalDev.ch}`);
    if (!r.ok) { alert("抓拍失败"); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    $("snapshot-img").src = url;
    $("snapshot-link").href = url;
    $("snapshot-link").download = `snapshot_${modalDev.ip}_ch${modalDev.ch}_${Date.now()}.jpg`;
    $("snapshot-wrap").classList.remove("hidden");
  } catch (e) { alert("抓拍失败: " + e.message); }
};
function hideSnapshot() { $("snapshot-wrap").classList.add("hidden"); $("snapshot-img").src = ""; }

document.querySelectorAll(".ptz-pad button, .ptz-zoom button").forEach(btn => {
  const cmd = btn.dataset.cmd;
  const send = (c) => fetch(`/api/ptz/${modalDev.ip}/${modalDev.ch}/${c}`, { method: "POST" }).catch(() => {});
  btn.addEventListener("pointerdown", () => send(cmd));
  btn.addEventListener("pointerup", () => { if (cmd !== "home" && cmd !== "zoomstop") send("stop"); });
  btn.addEventListener("pointerleave", () => { if (cmd !== "home" && cmd !== "zoomstop") send("stop"); });
});

// ================= 重新扫描 =================
$("btn-refresh").onclick = async () => {
  const r = await fetchJSON("/api/devices/refresh", { method: "POST" });
  if (!r.ok) { alert(r.msg || "扫描失败"); return; }
  $("scanning").classList.remove("hidden");
  const t = setInterval(async () => {
    try {
      const st = await fetchJSON("/api/status");
      if (!st.scanning) {
        clearInterval(t);
        $("scanning").classList.add("hidden");
        stopAllHls();
        await loadDevices();
      }
    } catch (e) { /* ignore */ }
  }, 1500);
};

function stopAllHls() {
  for (const t of document.querySelectorAll("#grid .tile")) detachStream(t, true);
  state.hls.forEach(h => { try { h.destroy(); } catch (e) {} });
  state.hls.clear();
}

function toggleSection(kind) {
  const grid = $(kind === "duplicate" ? "grid-duplicate" : "grid-failed");
  grid.classList.toggle("hidden");
}

// ================= 启动 =================
enableDrag($("grid"));
loadDevices().catch(e => {
  $("empty").classList.remove("hidden");
  $("empty").textContent = "加载失败: " + e.message;
});
