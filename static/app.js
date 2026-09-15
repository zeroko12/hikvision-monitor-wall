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
  attachQueue: [],       // 前端并发闸: 待起流队列(与后端MAX_STARTING=6对齐)
  attachingCount: 0,     // 正在起流中的新流数量
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
    <div class="snap hidden"></div>
    <span class="tile-state ${d.status === "online" ? "loading" : "off"}">${d.status === "online" ? "加载中" : "离线"}</span>
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
  t.addEventListener("click", () => {
    // 播放被浏览器策略暂停/重试额度耗尽时, 点击立即恢复(用户手势可解锁自动播放)
    const v = t.querySelector("video");
    if (v && v.paused && t._attached) {
      t._retries = 0;
      v.play().catch(() => {
        t._retries = 0; t._attached = false; attachStream(t);
      });
    } else if (t._attached && (t._retries || 0) >= 3) {
      t._retries = 0; t._attached = false; attachStream(t);
    } else {
      openModal(d);
    }
  });
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

// 手机切回前台(锁屏/切App回来)时, 视口内未取流的通道错峰恢复,
// 避免同时冲击设备RTSP会话(设备会话满会拒绝导致黑屏)
function resumeViewportStaggered() {
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const tiles = [...document.querySelectorAll("#grid .tile")].filter(t => {
    if (!t._dev || t.dataset.online !== "1") return false;
    const r = t.getBoundingClientRect();
    return r.bottom > -400 && r.top < vh + 400;
  });
  // 回前台: 卡在"离线"终态的强制重置重试(锁屏/切后台期间重试额度被耗尽, 恢复正常播放)
  tiles.forEach(t => {
    if (t._attached && (t._retries || 0) >= 3) {
      t._retries = 0;
      t._attached = false;
      attachStream(t);
    }
  });
  const need = tiles.filter(t => !t._attached);
  let i = 0;
  const step = () => {
    if (i >= need.length) return;
    attachStream(need[i++]);
    setTimeout(step, 700);   // 每700ms起一路, 14路约10秒铺满, 设备端可承受
  };
  if (need.length) step();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resumeViewportStaggered();
});

// 抓取当前帧作为定格画面(离开视口后画面残留, 回来无感知接续)
function captureFrame(tile) {
  const video = tile.querySelector("video");
  if (!video || video.videoWidth <= 0 || tile._snapUrl) return;
  try {
    const w = video.videoWidth, h = video.videoHeight;
    const c = document.createElement("canvas");
    c.width = Math.min(320, Math.round(w * 320 / Math.max(w, 1)));
    c.height = Math.round(c.width * h / Math.max(w, 1));
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    tile._snapUrl = c.toDataURL("image/jpeg", 0.55);
    const snap = tile.querySelector(".snap");
    if (snap) { snap.style.backgroundImage = `url(${tile._snapUrl})`; }
  } catch (e) { /* 抓帧失败则无定格, 走原逻辑 */ }
}

function showSnap(tile) {
  const snap = tile.querySelector(".snap");
  if (snap && tile._snapUrl) snap.classList.remove("hidden");
}

function hideSnap(tile) {
  const snap = tile.querySelector(".snap");
  if (snap) snap.classList.add("hidden");
}

function setDot(tile, live) {
  const dot = tile.querySelector(".dot");
  if (!dot) return;
  dot.classList.toggle("live", !!live);
  dot.classList.toggle("dead", !live);
}

// 状态角标: live实时 / frozen定格 / retry重连中 / loading加载中 / off离线
const STATE_TEXT = { live: "实时", frozen: "定格", retry: "重连中", loading: "加载中", off: "离线" };
function setTileState(tile, s) {
  const el = tile.querySelector(".tile-state");
  if (!el) return;
  el.className = "tile-state " + s;
  el.textContent = STATE_TEXT[s] || s;
}

// 帧真正渲染出来才切换定格→实时(比play()更早更准)
function onFirstFrame(tile, fn) {
  const video = tile.querySelector("video");
  if (!video) { fn(); return; }
  let done = false;
  const go = () => { if (done) return; done = true; video.removeEventListener("playing", go); fn(); };
  video.addEventListener("playing", go);
  // 兜底: 2秒内没有playing事件, 只要有解码画面就切换(避免漏掉);
  // 完全没解码(黑屏)则不切, 定格帧继续垫底, 由看门狗决定重连
  setTimeout(() => {
    if (video.videoWidth > 0) go();
  }, 2000);
}

// 离开视口: 定格最后一帧 + 保留热流60秒(滚动返回秒开), 超时未返回才销毁并释放
function detachStream(tile, immediate) {
  // 排队中(前端并发闸)的流: 直接移出队列
  if (tile._queued) {
    tile._queued = false;
    state.attachQueue = state.attachQueue.filter(x => x !== tile);
    return;
  }
  if (!tile._attached) return;
  tile._attached = false;
  tile._retries = 0;
  const id = tile.dataset.id;
  const video = tile.querySelector("video");
  const h = state.hls.get(id);
  clearTimeout(tile._stallTimer);
  clearTimeout(tile._timeout);
  captureFrame(tile);
  setTileState(tile, "frozen");
  if (h && !h.destroyed && !immediate) {
    try { h.stopLoad(); } catch (e) {}
    try { video.pause(); } catch (e) {}
    showSnap(tile);
    tile._releaseTimer = setTimeout(() => {
      const hh = state.hls.get(id);
      if (hh) { try { hh.destroy(); } catch (e) {} state.hls.delete(id); }
      if (video) { video.removeAttribute("src"); video.load(); }
      fetch(`/api/stream/release/${tile.dataset.ip}/${tile.dataset.ch}`, { method: "POST" }).catch(() => {});
    }, 60000);
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
  lowLatencyMode: true,          // 低延迟模式: 更激进的分片预取/缓冲调度
  maxBufferLength: 8,            // 直播流缓冲上限8秒(默认30s), 更贴近实时、内存更省
  maxMaxBufferLength: 12,        // 缓冲软上限(网络恢复追赶时也封顶12s)
  backBufferLength: 5,           // 回看缓冲5s(热流恢复有MSE残留+新分片, 足够秒接)
  manifestLoadingTimeOut: 6000,
  levelLoadingTimeOut: 6000,
  fragLoadingTimeOut: 8000,
  manifestLoadingMaxRetry: 2,
  levelLoadingMaxRetry: 2,
  fragLoadingMaxRetry: 3,
};

// 前端并发闸: 与后端MAX_STARTING=10对齐, 最多同时起16路新流(一屏上限), 其余排队等待.
// 避免几十路同时attach → 浏览器/网络压力与后端排队叠加.
const MAX_ATTACH = 16;
function startNextAttach() {
  while (state.attachingCount < MAX_ATTACH && state.attachQueue.length) {
    const t = state.attachQueue.shift();
    t._queued = false;
    if (!t._attached && t._dev) doAttachStream(t);
  }
}
function attachStream(tile) {
  if (tile._attached) return;
  // 热流恢复(已有实例)不走闸, 直接秒开
  const kept = state.hls.get(tile.dataset.id);
  if (kept && !kept.destroyed) { tile._tookSlot = false; doAttachStream(tile); return; }
  if (state.attachingCount >= MAX_ATTACH) {
    if (!tile._queued) { tile._queued = true; state.attachQueue.push(tile); setTileState(tile, "loading"); }
    return;
  }
  state.attachingCount++;
  tile._tookSlot = true;
  doAttachStream(tile);
}

function doAttachStream(tile) {
  if (tile._attached) return;
  tile._attached = true;
  tile._lastFragAt = 0;   // 分片心跳, 看门狗据此区分"慢"与"死"
  const releaseSlot = () => {
    if (!tile._tookSlot) return;
    tile._tookSlot = false;
    if (state.attachingCount > 0) state.attachingCount--;
    startNextAttach();
  };
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

  // 播放看门狗: 每3秒核对一次 currentTime 是否在走, 驱动"实时/重连中/离线"角标.
  // 重建判据(区分"慢"与"死"):
  //  - MSE路径(hls.js): 分片心跳 fragAlive 权威——分片还在加载=后端在干活, 温和等待绝不重建
  //  - 原生路径(iPhone Safari等): 无分片心跳, 用 readyState——缓冲等待(<2)温和等待,
  //    只有"有缓冲却不动"(>=2)才是真死 → 重建
  // 避免: ①后端MAX_STARTING限流下排队流被误杀→重建风暴 ②原生播放器缓冲间隙被误判
  // 只在本attach会话真正出过画面(started)后才计数, 避免误杀启动期.
  let lastTime = -1, stallCount = 0, started = false;
  const markStarted = () => { started = true; };
  const isNative = () => !hls;   // 原生HLS路径没有hls.js实例
  const stallWatch = () => {
    tile._stallTimer = setTimeout(() => {
      if (!tile._attached) { stallWatch(); return; }
      if (!started || !video.currentTime) { stallWatch(); return; }
      const moving = Math.abs(video.currentTime - lastTime) >= 0.001;
      const fragAlive = (Date.now() - (tile._lastFragAt || 0)) < 10000;  // 10秒内有分片加载
      const buffering = video.readyState < 2;   // 正在等缓冲数据
      if (moving) {
        stallCount = 0;
        setTileState(tile, "live");   // currentTime 在走 = 真实时, 角标实时校正
      } else {
        setTileState(tile, tile._retries >= 3 ? "off" : "retry");
        if (video.paused) {
          // 播放被浏览器策略暂停: 尝试恢复, 连续3拍仍暂停才重建
          video.play().catch(() => {});
          stallCount++;
        } else if (isNative() && buffering) {
          stallCount = 0;   // 原生播放器在等缓冲: 温和等待
        } else if (!fragAlive) {
          stallCount++;     // 真死: 视频停 + (MSE)无分片 或 (原生)有缓冲却不动
        } else {
          stallCount = 0;   // 分片还在加载(后端慢/排队): 温和等待
        }
        if (stallCount >= 3 && tile._retries < 3) {
          tile._retries++;
          stallCount = 0;
          cleanup();
          releaseSlot();   // 让出并发位, 1.5秒后重建重新占位
          setTimeout(() => {
            tile._attached = false;   // 关键: 先释放占用标记, 重连才会真正执行
            if (tile._dev) attachStream(tile);
          }, 1500);
          return;
        }
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

  // 统一重试入口:
  //  force=true (hls致命错误): 流已死, 无条件重连(videoWidth残留帧不能拦截)
  //  force=false (加载超时): 已有画面则直接恢复, 否则按退避重连(最多3次)
  const retryStream = (finalMsg, force) => {
    const rt = tile._retries || 0;
    if (rt >= 3) {
      // 终态: 有定格帧则保持定格(状态点变灰+角标离线), 否则显示失败文案
      setTileState(tile, "off");
      if (tile._snapUrl) { showSnap(tile); setDot(tile, false); }
      else showPoster(finalMsg);
      releaseSlot();
      return;
    }
    if (!force && (video.videoWidth > 0 || video.readyState >= 2)) {
      poster.classList.add("hidden");
      hideSnap(tile);
      setTileState(tile, "live");
      releaseSlot();
      return;
    }
    // 重试期间: 有定格帧就顶着(角标"重连中"), 新画面出来才替换
    setTileState(tile, "retry");
    if (tile._snapUrl) showSnap(tile);
    else showPoster("加载中…自动重试");
    cleanup();
    releaseSlot();
    const backoff = [2000, 5000, 10000][Math.min(rt, 2)];
    setTimeout(() => {
      tile._retries = (tile._retries || 0) + 1;
      tile._attached = false;   // 关键: 释放占用标记后才能真正重连
      if (tile._dev) attachStream(tile);
    }, backoff);
  };

  // 加载超时: 18秒无画面则提示并自动重试(给后端启动限流排队留足时间)
  tile._timeout = setTimeout(() => {
    if (video.videoWidth > 0 || video.readyState > 0) {
      poster.classList.add("hidden");
      hideSnap(tile);
      releaseSlot();
      return;
    }
    retryStream("该路设备无响应，点击重试", false);
  }, 18000);

  const bindErrors = (h) => {
    // 分片心跳: 每次成功加载分片都刷新时间戳, 看门狗据此区分"慢"与"死"
    h.on(Hls.Events.FRAG_LOADED, () => { tile._lastFragAt = Date.now(); });
    h.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        retryStream(failReason(data) + "，点击重试", true);
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        try { h.recoverMediaError(); } catch (e) { retryStream(failReason(data) + "，点击重试", true); }
      } else {
        retryStream(failReason(data) + "，点击重试", true);
      }
    });
  };

  // ===== 热流恢复: 刚离开视口(60秒内)保留的实例直接续播, 秒开 =====
  const kept = state.hls.get(id);
  if (kept && !kept.destroyed) {
    clearTimeout(tile._releaseTimer);
    tile._releaseTimer = null;
    poster.classList.add("hidden");
    hls = kept;
    try { hls.startLoad(); } catch (e) { retryStream("该路设备无响应，点击重试", true); return; }
    tile._lastFragAt = Date.now();   // 热流恢复后给足缓冲期, 不因拉流间隙误判
    onFirstFrame(tile, () => { hideSnap(tile); setDot(tile, true); });
    markStarted();
    video.play().catch(() => {});
    lastTime = video.currentTime || 0;
    stallWatch();
    return;
  }

  // 重建期间: 有定格帧则垫底, 新画面出来才替换(全程不黑屏)
  if (tile._snapUrl) { showSnap(tile); setTileState(tile, "retry"); }

  if (Hls.isSupported() && !(isApple && canNative)) {
    hls = new Hls(HLS_CFG);
    state.hls.set(id, hls);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      poster.classList.add("hidden");
      markStarted();
      releaseSlot();   // 流已起来, 让出并发位给排队流
      onFirstFrame(tile, () => { hideSnap(tile); setDot(tile, true); });
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
      markStarted();
      releaseSlot();   // 流已起来, 让出并发位给排队流
      onFirstFrame(tile, () => { hideSnap(tile); setDot(tile, true); });
      video.play().catch(() => {});
      lastTime = video.currentTime || 0;
      stallWatch();
    }, { once: true });
  } else {
    poster.classList.remove("hidden");
    poster.querySelector("span").textContent = "浏览器不支持播放，请用Chrome/Edge";
    releaseSlot();
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
