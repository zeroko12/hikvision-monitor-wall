"use strict";

const state = { devices: [], hls: new Map() }; // hls: tileId -> hls instance

const $ = (id) => document.getElementById(id);

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------- 设备加载与分组 ----------
async function loadDevices() {
  const data = await fetchJSON("/api/devices");
  const list = data.devices || [];
  const directIps = new Set(
    list.filter(d => d.src === "camera" && d.status === "online").map(d => d.ip)
  );
  const main = [], dups = [], failed = [];
  for (const d of list) {
    if (d.status === "auth_failed") { failed.push(d); continue; }
    if (d.src === "nvr" && d.camera_ip && directIps.has(d.camera_ip)) {
      dups.push(d); continue;
    }
    if (d.status === "online") main.push(d);
    else main.push(d); // offline NVR channels also shown in main grid
  }
  renderGrid("grid", main, true);
  renderGrid("grid-duplicate", dups, false);
  renderGrid("grid-failed", failed, false);
  $("duplicate-section").classList.toggle("hidden", dups.length === 0);
  $("failed-section").classList.toggle("hidden", failed.length === 0);
  $("empty").classList.toggle("hidden", main.length > 0);
  $("stat-total").textContent = list.length;
  $("stat-online").textContent = list.filter(d => d.status === "online").length;
  $("stat-failed").textContent = failed.length;
  attachVisible();
}

function tileId(d) { return `${d.ip}_${d.ch}`; }

function renderGrid(containerId, list, lazy) {
  const grid = $(containerId);
  grid.innerHTML = "";
  for (const d of list) {
    const t = document.createElement("div");
    t.className = "tile" + (d.status !== "online" ? " no-signal" : "");
    t.dataset.id = tileId(d);
    t.dataset.ip = d.ip;
    t.dataset.ch = d.ch;
    t.dataset.ptz = d.ptz;
    t.dataset.online = d.status === "online" ? "1" : "0";
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
    grid.appendChild(t);
    if (lazy && d.status === "online") observeTile(t, d);
  }
  if (!lazy) {
    // 备用通道与失败设备不自动播放，但备用通道可点击播放
  }
}

// ---------- 懒加载：视口内才启动子码流 ----------
// 注意：不依赖 IntersectionObserver（部分内嵌浏览器不触发回调），
// 采用渲染后立即检查视口 + 滚动/缩放时重新检查。
let attachTimer = null;

function attachVisible() {
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const tiles = document.querySelectorAll("#grid .tile");
  for (const t of tiles) {
    if (t._attached) continue;
    const dev = t._dev;
    if (!dev || dev.status !== "online") continue;
    const r = t.getBoundingClientRect();
    if (r.bottom > -400 && r.top < vh + 400) attachStream(t);
  }
}

function scheduleAttach() {
  if (attachTimer) return;
  attachTimer = setTimeout(() => { attachTimer = null; attachVisible(); }, 150);
}
window.addEventListener("scroll", scheduleAttach, { passive: true });
window.addEventListener("resize", scheduleAttach);

function observeTile(tile, dev) {
  tile._dev = dev;
}

function attachStream(tile) {
  if (tile._attached) return;
  tile._attached = true;
  const dev = tile._dev;
  const video = tile.querySelector("video");
  const poster = tile.querySelector(".poster");
  const url = `/stream/${dev.ip}/${dev.ch}/sub/live`;
  const canNative = video.canPlayType("application/vnd.apple.mpegurl");
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  let hls = null;
  const cleanup = () => { if (hls) { hls.destroy(); hls = null; } };

  // 超时检测：15秒无数据则提示（部分内置浏览器禁用了视频解码）
  const watch = setInterval(() => {
    if (video.readyState > 0 || video.videoWidth > 0) { clearInterval(watch); return; }
    poster.classList.remove("hidden");
    poster.querySelector("span").textContent = "无法播放：请用Chrome/Edge打开";
  }, 15000);

  if (Hls.isSupported() && !(isApple && canNative)) {
    hls = new Hls({
      liveSyncDurationCount: 2,
      maxLiveSyncPlaybackRate: 1.5,
      startPosition: -2,
    });
    state.hls.set(tileId(dev), hls);
    hls.on(Hls.Events.MANIFEST_PARSED, () => { poster.classList.add("hidden"); video.play().catch(() => {}); });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          cleanup();
          tile._attached = false;
          setTimeout(() => attachStream(tile), 3000);
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          hls.recoverMediaError(); break;
        default:
          cleanup();
          tile._attached = false;
          setTimeout(() => attachStream(tile), 5000);
      }
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (canNative) {
    // Safari / iOS：原生 HLS，需显式 load() 触发 preload="none" 的加载
    video.src = url;
    video.load();
    video.addEventListener("loadedmetadata", () => { poster.classList.add("hidden"); video.play().catch(() => {}); });
  } else {
    poster.querySelector("span").textContent = "浏览器不支持播放，请用Chrome/Edge";
  }
}

// ---------- 详情弹窗 ----------
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
    modalHls = new Hls({ liveSyncDurationCount: 2, maxLiveSyncPlaybackRate: 1.5 });
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
$("m-close").onclick = () => { $("modal").classList.add("hidden"); if (modalHls) { modalHls.destroy(); modalHls = null; } hideSnapshot(); };
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

// ---------- 重新扫描 ----------
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
        // 重新加载页面状态
        stopAllHls();
        await loadDevices();
      }
    } catch (e) { /* ignore */ }
  }, 1500);
};

function stopAllHls() {
  state.hls.forEach(h => h.destroy());
  state.hls.clear();
}

function toggleSection(kind) {
  const grid = $(kind === "duplicate" ? "grid-duplicate" : "grid-failed");
  grid.classList.toggle("hidden");
}

// ---------- 启动 ----------
loadDevices().catch(e => {
  $("empty").classList.remove("hidden");
  $("empty").textContent = "加载失败: " + e.message;
});
