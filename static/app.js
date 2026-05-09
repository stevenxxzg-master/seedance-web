// ── State ──
const MAX_TASKS = 50;
const tasks = [];

// Demo tasks (assets hosted on COS — tutorial/ prefix, excluded from daily cleanup)
const DEMO_TASKS = {
  all: {
    id: "demo-reference", demo: true, status: "completed",
    created: 0, endTime: 0,
    videoUrl: "https://seedance-1394865241.cos.na-siliconvalley.myqcloud.com/tutorial/1775538468251_aa98138a.mp4",
    input: {
      prompt: "@Image1 @Image2 copy movements and footworks in @Video1. Music reference: @Audio1.",
      model: "seedance", refMode: "all", ratio: "16:9", duration: 10,
      mediaItems: [
        { type: "image", name: "@Image1.png", url: "https://seedance-1394865241.cos.na-siliconvalley.myqcloud.com/tutorial/1775538452965_5c383288.png", cosUrl: "https://seedance-1394865241.cos.na-siliconvalley.myqcloud.com/tutorial/1775538452965_5c383288.png" },
        { type: "image", name: "@Image2.png", url: "https://seedance-1394865241.cos.na-siliconvalley.myqcloud.com/tutorial/1775538456877_2f8d3d96.png", cosUrl: "https://seedance-1394865241.cos.na-siliconvalley.myqcloud.com/tutorial/1775538456877_2f8d3d96.png" },
        { type: "video", name: "@Video1.mp4", url: "https://seedance-1394865241.cos.na-siliconvalley.myqcloud.com/tutorial/1775538460793_f57e860d.mp4", cosUrl: "https://seedance-1394865241.cos.na-siliconvalley.myqcloud.com/tutorial/1775538460793_f57e860d.mp4" },
        { type: "audio", name: "@Audio1.wav", url: "https://seedance-1394865241.cos.na-siliconvalley.myqcloud.com/tutorial/1775538464613_691ecf17.wav", cosUrl: "https://seedance-1394865241.cos.na-siliconvalley.myqcloud.com/tutorial/1775538464613_691ecf17.wav" },
      ]
    },
    response: {}
  },
  keyframes: {
    id: "demo-keyframes", demo: true, status: "completed",
    created: 0, endTime: 0,
    videoUrl: "https://seedance-1394865241.cos.na-siliconvalley.myqcloud.com/tutorial/1775538481089_b2495afe.mp4",
    input: {
      prompt: "Silver magic erupts, armor snaps onto her body in rapid flashes. Camera pushes in then pulls back wide. Hair billows, shockwave ripples the ocean. Moonlit beach, flat vector style.",
      model: "seedance", refMode: "keyframes", ratio: "16:9", duration: 5,
      kfFirst: { url: "https://seedance-1394865241.cos.na-siliconvalley.myqcloud.com/tutorial/1775538472721_f2bcbb33.png", cosUrl: "https://seedance-1394865241.cos.na-siliconvalley.myqcloud.com/tutorial/1775538472721_f2bcbb33.png", name: "frame_start.png" },
      kfLast: { url: "https://seedance-1394865241.cos.na-siliconvalley.myqcloud.com/tutorial/1775538476951_a184301d.png", cosUrl: "https://seedance-1394865241.cos.na-siliconvalley.myqcloud.com/tutorial/1775538476951_a184301d.png", name: "frame_end.png" },
    },
    response: {}
  }
};
let pollTimer = null;
const mediaItems = []; // { id, type, url, file, thumbUrl, name }
let mediaIdCounter = 0;
let pendingUploads = 0; // Track in-flight uploads
// Keyframe mode state: { url, thumbUrl, name, file } or null
let kfFirst = null;
let kfLast = null;
// Cached task DOM nodes for incremental render (declared early — init IIFE calls renderTasks before the function definitions below)
const _renderedTasks = new Map();
let _elapsedTimer = null;

const ACCEPT = {
  image: "image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif",
  video: "video/mp4,video/quicktime,video/webm",
  audio: "audio/wav,audio/mpeg,audio/mp3"
};
const MAX_MEDIA = { image: 9, video: 3, audio: 3 };
function canAddMedia(type) { return mediaItems.filter(m => m.type === type).length < (MAX_MEDIA[type] || 9); }
const RATIOS = ["21:9","16:9","4:3","1:1","3:4","9:16"];
const DURATIONS = [4,5,6,7,8,9,10,11,12,13,14,15];
// Base pricing USD/s, sourced from BytePlus ModelArk pricing tables (Dreamina Seedance 2.0).
// T2V = Table 3 (input without video) / 5s output baseline.
// V2V = Table 4 (input with video) midpoint of the 2-15s input range / 5s output baseline.
// 1080p Fast is unsupported upstream.
const BASE_PRICE = {
  "seedance":      { t2v: { "480p": 0.070, "720p": 0.152, "1080p": 0.374 },
                     v2v: { "480p": 0.125, "720p": 0.270, "1080p": 0.663 } },
  "seedance-fast": { t2v: { "480p": 0.056, "720p": 0.120 },
                     v2v: { "480p": 0.096, "720p": 0.207 } },
};

function updateCostLabel() {
  const res = document.getElementById("i-res")?.value || "720p";
  const dur = parseInt(document.getElementById("i-dur").value) || 15;
  const model = document.getElementById("i-model").value;
  const hasVideo = mediaItems.some(m => m.type === "video" && m.url);
  const mode = hasVideo ? "v2v" : "t2v";
  const tier = BASE_PRICE[model] || BASE_PRICE["seedance"];
  const base = tier[mode][res] ?? tier[mode]["720p"];
  const cost = (base * dur).toFixed(2);
  const el = document.getElementById("cost-label");
  if (el) el.textContent = `↑ $${cost}`;
}
const RATIO_SHAPES = {"21:9":[30,13],"16:9":[28,16],"4:3":[24,18],"1:1":[20,20],"3:4":[18,24],"9:16":[16,28]};

// ── Prefs sync (server-side, keyed by API Key) ──
let _prefsTimer = null;
let _suppressPrefsSync = false;
function syncPrefs() {
  if (_suppressPrefsSync) return;
  clearTimeout(_prefsTimer);
  _prefsTimer = setTimeout(() => {
    const key = document.getElementById("i-key").value.trim();
    if (!key) return;
    const refMode = document.getElementById("i-ref")?.value || "all";
    // Persist enough media metadata to rebuild the compose box on refresh.
    // Same shape as task input snapshots — keep includes assetUrl so resubmit
    // can skip PrivacyInformation when the asset is still whitelisted upstream.
    // Only items with a real cos/tos URL are eligible — never persist blob: URLs
    // or in-progress uploads, which would round-trip back as invalid url scheme
    // when the user resubmits after a refresh.
    const isPersistable = (m) => !!(m && m.cosUrl);
    const serializeMedia = (m) => ({
      type: m.type,
      url: m.cosUrl,
      cosUrl: m.cosUrl,
      name: m.name,
      assetUrl: m.assetUrl || "",
      contentHash: m.contentHash || "",
    });
    const prefs = {
      apiBase: document.getElementById("i-base").value,
      model: document.getElementById("i-model").value,
      ratio: document.getElementById("i-ratio").value,
      dur: document.getElementById("i-dur").value,
      res: document.getElementById("i-res").value,
      webSearch: document.getElementById("i-search")?.checked || false,
      watermark: document.getElementById("i-wm")?.checked || false,
      prompt: getPromptText(),
      tasks: tasks.filter(t => t.id || t.status === "failed").slice(0, MAX_TASKS).map(t => ({ id:t.id, status:t.status, progress:t.progress, created:t.created, apiCreatedAt:t.apiCreatedAt, apiUpdatedAt:t.apiUpdatedAt, videoUrl:t.videoUrl, response:t.response, input:t.input, error:t.error, endTime:t.endTime })),
      compose: {
        refMode,
        mediaItems: mediaItems.filter(isPersistable).map(serializeMedia),
        kfFirst: isPersistable(kfFirst) ? serializeMedia(kfFirst) : null,
        kfLast: isPersistable(kfLast) ? serializeMedia(kfLast) : null,
      },
    };
    fetch("/api/prefs", { method: "PUT", headers: { "X-Api-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(prefs) }).catch(() => {});
  }, 800);
}

function applyPrefs(p) {
  if (p.apiBase != null) document.getElementById("i-base").value = p.apiBase;
  if (p.model) {
    document.getElementById("i-model").value = p.model;
    document.getElementById("model-label").textContent = p.model === "seedance-fast" ? "Seedance Fast" : "Seedance";
    document.getElementById("chk-seedance").style.display = p.model === "seedance" ? "" : "none";
    document.getElementById("chk-seedance-fast").style.display = p.model === "seedance-fast" ? "" : "none";
    update1080pAvailability(p.model);
  }
  if (p.res) {
    document.getElementById("i-res").value = p.res;
    document.getElementById("res-label").textContent = p.res;
    document.querySelectorAll("#res-popup .popup-item").forEach(item => {
      item.classList.toggle("selected", item.dataset.value === p.res);
      const chk = item.querySelector(".check");
      if (chk) chk.style.display = item.dataset.value === p.res ? "" : "none";
    });
  }
  if (p.ratio) { document.getElementById("i-ratio").value = p.ratio; document.getElementById("ratio-label").textContent = p.ratio; }
  if (p.dur) { document.getElementById("i-dur").value = p.dur; document.getElementById("dur-label").textContent = p.dur + "s"; }
  if (p.webSearch != null) { const el = document.getElementById("i-search"); if (el) el.checked = p.webSearch; }
  if (p.watermark != null) { const el = document.getElementById("i-wm"); if (el) el.checked = p.watermark; }
  if (Array.isArray(p.tasks) && p.tasks.length) {
    tasks.length = 0;
    // Rescue: if a task was marked failed but has a videoUrl, restore to completed
    for (const t of p.tasks) {
      if (t.videoUrl) { t.status = "completed"; t.progress = null; }
      tasks.push(t);
    }
    renderTasks();
    // Kick off polling for any unfinished task loaded from server prefs
    if (tasks.some(t => t.id && !["completed","failed","cancelled"].includes(t.status))) startPolling();
  }
  // Restore compose box (media items / keyframes / refMode) from server prefs.
  // Skip the syncPrefs round-trip for these mutations — we just loaded this state.
  if (p.compose) {
    _suppressPrefsSync = true;
    try {
      const c = p.compose;
      if (c.refMode) {
        const refEl = document.getElementById("i-ref");
        if (refEl) refEl.value = c.refMode;
        const labels = { all: "Reference", keyframes: "Keyframes" };
        const refLabel = document.getElementById("ref-label");
        if (refLabel) refLabel.textContent = labels[c.refMode] || "Reference";
        document.querySelectorAll("#ref-popup .popup-item").forEach((item) => {
          item.classList.toggle("selected", item.dataset.value === c.refMode);
        });
      }
      if (Array.isArray(c.mediaItems)) {
        for (const m of mediaItems) {
          if (m.thumbUrl && m.thumbUrl.startsWith("blob:")) URL.revokeObjectURL(m.thumbUrl);
        }
        mediaItems.length = 0;
        for (const m of c.mediaItems) {
          mediaItems.push({
            id: ++mediaIdCounter,
            type: m.type,
            url: m.url,
            thumbUrl: m.cosUrl || m.url,
            cosUrl: m.cosUrl || "",
            name: m.name,
            assetUrl: m.assetUrl || "",
            contentHash: m.contentHash || "",
            file: null,
          });
        }
        renderStack();
      }
      if (kfFirst && kfFirst.thumbUrl && kfFirst.thumbUrl.startsWith("blob:")) URL.revokeObjectURL(kfFirst.thumbUrl);
      if (kfLast && kfLast.thumbUrl && kfLast.thumbUrl.startsWith("blob:")) URL.revokeObjectURL(kfLast.thumbUrl);
      kfFirst = c.kfFirst ? { url: c.kfFirst.url, thumbUrl: c.kfFirst.cosUrl || c.kfFirst.url, cosUrl: c.kfFirst.cosUrl || "", name: c.kfFirst.name, assetUrl: c.kfFirst.assetUrl || "", contentHash: c.kfFirst.contentHash || "", file: null } : null;
      kfLast = c.kfLast ? { url: c.kfLast.url, thumbUrl: c.kfLast.cosUrl || c.kfLast.url, cosUrl: c.kfLast.cosUrl || "", name: c.kfLast.name, assetUrl: c.kfLast.assetUrl || "", contentHash: c.kfLast.contentHash || "", file: null } : null;
      if (kfFirst) renderKfCard("first");
      if (kfLast) renderKfCard("last");
    } finally {
      _suppressPrefsSync = false;
    }
  }
  // Prompt restore must happen after mediaItems/kf are populated so that
  // setPromptText can find each @mention's media entry and inline its thumbnail.
  if (p.prompt) setPromptText(p.prompt);
}

async function loadPrefs() {
  const key = document.getElementById("i-key").value.trim();
  if (!key) { _suppressPrefsSync = false; return; }
  _suppressPrefsSync = true;
  clearTimeout(_prefsTimer);
  try {
    const resp = await fetch("/api/prefs", { headers: { "X-Api-Key": key } });
    if (resp.ok) { const p = await resp.json(); if (p && Object.keys(p).length) applyPrefs(p); }
  } catch (e) { console.warn("[Prefs] Load failed:", e.message); }
  finally { _suppressPrefsSync = false; }
}

// ── Init ──
(function init() {
  // Suppress prefs writes until the initial loadPrefs finishes (or we determine
  // there's nothing to load). Otherwise any input/focus event during boot can
  // overwrite the server-side compose snapshot with an empty mediaItems array.
  _suppressPrefsSync = true;

  // Only API key stays in localStorage
  const savedKey = localStorage.getItem("apiKey");
  if (savedKey) document.getElementById("i-key").value = savedKey;
  let _keyChangeTimer = null;
  document.getElementById("i-key").addEventListener("input", () => {
    localStorage.setItem("apiKey", document.getElementById("i-key").value);
    clearTimeout(_keyChangeTimer);
    _keyChangeTimer = setTimeout(() => {
      loadPrefs();
      _assetLoading = false; // reset lock so key change always triggers a fresh load
      loadAssetLibrary();
    }, 600);
  });

  // Apply defaults then load server prefs
  const fields = {"i-base":"apiBase","i-model":"model","i-ratio":"ratio","i-dur":"dur","i-res":"res"};
  const checks = {"i-search":"webSearch","i-wm":"watermark"};
  for (const [id] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", syncPrefs);
  }
  for (const [id] of Object.entries(checks)) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", syncPrefs);
  }

  // Restore model label from current value
  const m = document.getElementById("i-model").value;
  document.getElementById("model-label").textContent = m === "seedance-fast" ? "Seedance Fast" : "Seedance";
  document.getElementById("chk-seedance").style.display = m === "seedance" ? "" : "none";
  document.getElementById("chk-seedance-fast").style.display = m === "seedance-fast" ? "" : "none";
  update1080pAvailability(m);
  const res = document.getElementById("i-res").value || "720p";
  document.getElementById("res-label").textContent = res;
  const r = document.getElementById("i-ratio").value || "1:1";
  document.getElementById("ratio-label").textContent = r;
  const d = document.getElementById("i-dur").value || "15";
  document.getElementById("dur-label").textContent = d + "s";

  buildRatioGrid();
  buildDurList();

  // Load server-side prefs after a tick (key must be set). If no key, lift the
  // suppression flag so future user actions can persist normally.
  if (savedKey) setTimeout(loadPrefs, 100);
  else _suppressPrefsSync = false;

  // Setup prompt editor events
  const ta = document.getElementById("i-prompt");
  // Gate: require API key before typing in prompt
  ta.addEventListener("mousedown", (e) => {
    if (!document.getElementById("i-key").value.trim()) {
      e.preventDefault();
      showKeyModal(() => ta.focus());
    }
  });
  ta.addEventListener("focus", () => {
    if (!document.getElementById("i-key").value.trim()) {
      ta.blur();
      showKeyModal(() => ta.focus());
    }
  });
  ta.addEventListener("input", onPromptInput);
  ta.addEventListener("keydown", onPromptKeydown);
  // Paste as plain text
  ta.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    const html = esc(text).replace(/@(Image|Video|Audio)(\d+)/g, (match, type, num) => {
      const mType = type.toLowerCase();
      const idx = parseInt(num);
      let count = 0;
      const item = mediaItems.find(m => m.type === mType && ++count === idx);
      const thumb = item ? mentionThumbHtml(mType, item.thumbUrl) : '';
      return `<span class="mention" contenteditable="false" data-type="${mType}" data-text="${esc(match)}">${thumb}${match}</span>`;
    });
    document.execCommand("insertHTML", false, html);
  });

  // Pre-fill Base URL default
  if (!document.getElementById("i-base").value) {
    document.getElementById("i-base").value = "https://www.anyfast.ai";
  }

  renderTasks();
  updateCostLabel();
  if (tasks.some(t => t.id && !["completed","failed","cancelled"].includes(t.status))) startPolling();
})();

function buildRatioGrid() {
  const cur = document.getElementById("i-ratio").value;
  const g = document.getElementById("ratio-grid");
  g.innerHTML = RATIOS.map(r => {
    const [w,h] = RATIO_SHAPES[r];
    const sel = r === cur ? " selected" : "";
    return `<div class="ratio-opt${sel}" onclick="selectRatio('${r}')">
      <div class="ro-icon"><div class="ro-shape" style="width:${w}px;height:${h}px"></div></div>
      <div class="ro-label">${r}</div>
    </div>`;
  }).join("");
}

function buildDurList() {
  const cur = parseInt(document.getElementById("i-dur").value);
  const p = document.getElementById("dur-popup");
  const title = p.querySelector(".popup-title").outerHTML;
  p.innerHTML = title + DURATIONS.map(d => {
    const sel = d === cur ? " selected" : "";
    return `<div class="popup-item${sel}" onclick="selectDur(${d})">
      <span class="pi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>
      ${d}s
      ${d === cur ? '<span class="check">&#x2713;</span>' : ''}
    </div>`;
  }).join("");
}

// ── Popup management ──
let openPopup = null;
let openPill = null;

function closeAllPopups() {
  document.querySelectorAll(".popup.open").forEach(p => p.classList.remove("open"));
  const assetOpen = document.getElementById("asset-panel").classList.contains("open");
  document.querySelectorAll(".pill.active").forEach(p => {
    if (assetOpen && p.id === "at-pill") return;
    p.classList.remove("active");
  });
  openPopup = null;
  openPill = null;
}

function togglePill(popupId, pillEl) {
  const popup = document.getElementById(popupId);
  if (openPopup === popup) { closeAllPopups(); return; }
  closeAllPopups();

  // Position popup above the pill
  if (pillEl) {
    const compose = document.getElementById("compose-box");
    const composeRect = compose.getBoundingClientRect();
    const pillRect = pillEl.getBoundingClientRect();
    const pillLeft = pillRect.left - composeRect.left;
    const pillCenter = pillLeft + pillRect.width / 2;

    popup.style.left = "";
    popup.style.right = "";
    popup.style.bottom = "";

    // Show temporarily to measure
    popup.style.visibility = "hidden";
    popup.classList.add("open");
    const popupW = popup.offsetWidth;
    popup.classList.remove("open");
    popup.style.visibility = "";

    // Center popup on pill, clamp to compose bounds
    let left = pillCenter - popupW / 2;
    left = Math.max(8, Math.min(left, composeRect.width - popupW - 8));
    popup.style.left = left + "px";
    // Duration popup opens downward, others open upward
    if (popupId === "dur-popup") {
      popup.style.bottom = "";
      popup.style.top = (pillRect.bottom - composeRect.top + 6) + "px";
    } else {
      popup.style.top = "";
      popup.style.bottom = (composeRect.height - pillRect.top + composeRect.top + 6) + "px";
    }

    pillEl.classList.add("active");
  }

  popup.classList.add("open");
  openPopup = popup;
  openPill = pillEl;
  if (popupId === "mention-popup") buildMentionList();
}

document.addEventListener("click", (e) => {
  if (openPopup && !openPopup.contains(e.target) && (!openPill || !openPill.contains(e.target))) {
    closeAllPopups();
  }
});

function update1080pAvailability(model) {
  const el = document.getElementById("res-1080p");
  if (!el) return;
  const isFast = model === "seedance-fast";
  el.style.opacity = isFast ? "0.38" : "";
  el.style.pointerEvents = isFast ? "none" : "";
  el.title = isFast ? "1080p not available for Seedance Fast" : "";
  // If 1080p is currently selected and we switched to fast, fall back to 720p
  if (isFast && document.getElementById("i-res").value === "1080p") {
    selectRes(document.querySelector("#res-popup .popup-item[data-value='720p']"));
  }
}

function selectModel(el) {
  const v = el.dataset.value;
  document.getElementById("i-model").value = v;
  syncPrefs();
  document.getElementById("model-label").textContent = v === "seedance-fast" ? "Seedance Fast" : "Seedance";
  document.getElementById("chk-seedance").style.display = v === "seedance" ? "" : "none";
  document.getElementById("chk-seedance-fast").style.display = v === "seedance-fast" ? "" : "none";
  update1080pAvailability(v);
  closeAllPopups();
  updateCostLabel();
}

function selectRef(el) {
  const v = el.dataset.value;
  document.getElementById("i-ref").value = v;
  const labels = { all:"Reference", keyframes:"Keyframes" };
  document.getElementById("ref-label").textContent = labels[v] || v;
  document.querySelectorAll("#ref-popup .popup-item").forEach(item => {
    item.classList.toggle("selected", item.dataset.value === v);
    item.querySelector(".check").style.display = item.dataset.value === v ? "" : "none";
  });
  closeAllPopups();
  syncRefMode();
  syncPrefs();
}

function syncRefMode() {
  const v = document.getElementById("i-ref").value;
  const isKf = v === "keyframes";
  document.getElementById("media-stack").style.display = isKf ? "none" : "";
  document.getElementById("kf-area").classList.toggle("visible", isKf);
  document.getElementById("i-prompt").setAttribute("data-placeholder", isKf
    ? "Describe the action or smooth transition between these two frames."
    : "Upload 1-12 assets and enter your prompt. Mix images, video, and audio. Example: @Image1 mimics the motion of @Video1, with voice from @Audio1.");
  document.getElementById("at-pill").style.display = isKf ? "none" : "";
  if (isKf) { document.getElementById("asset-panel").classList.remove("open"); document.getElementById("compose-box").classList.remove("asset-open"); }
  renderTasks();
}

function selectRes(el) {
  const v = el.dataset.value;
  document.getElementById("i-res").value = v;
  syncPrefs();
  document.getElementById("res-label").textContent = v;
  document.querySelectorAll("#res-popup .popup-item").forEach(item => {
    item.classList.toggle("selected", item.dataset.value === v);
    item.querySelector(".check").style.display = item.dataset.value === v ? "" : "none";
  });
  closeAllPopups();
  updateCostLabel();
}

function selectRatio(r) {
  document.getElementById("i-ratio").value = r;
  syncPrefs();
  document.getElementById("ratio-label").textContent = r;
  buildRatioGrid();
  closeAllPopups();
}

function selectDur(d) {
  document.getElementById("i-dur").value = d;
  syncPrefs();
  document.getElementById("dur-label").textContent = d + "s";
  buildDurList();
  closeAllPopups();
  updateCostLabel();
}

function buildMentionList() {
  const el = document.getElementById("mention-list");
  if (mediaItems.length === 0) {
    el.innerHTML = '';
    return;
  }
  mentionIdx = 0;
  el.innerHTML = mediaItems.map((m, i) => {
    const typeLabel = m.type === "image" ? "Image" : m.type === "video" ? "Video" : "Audio";
    const num = mediaItems.filter((x, j) => x.type === m.type && j <= i).length;
    let thumb = '';
    if (m.thumbUrl && m.type === "video") {
      thumb = `<video src="${esc(m.thumbUrl)}" muted style="width:36px;height:36px;border-radius:8px;object-fit:cover;display:block"></video>`;
    } else if (m.thumbUrl) {
      thumb = `<img src="${esc(m.thumbUrl)}" width="36" height="36" style="width:36px;height:36px;border-radius:8px;object-fit:cover;display:block">`;
    } else {
      const icons = { image: "🖼", video: "🎬", audio: "🎵" };
      thumb = `<div class="mi-placeholder">${icons[m.type]}</div>`;
    }
    const active = i === 0 ? " active" : "";
    const colorMap = { image: "#3d9be9", video: "#e67e22", audio: "#27ae60" };
    const tagColor = colorMap[m.type];
    return `<div class="mention-item${active}" onclick="insertMention('${typeLabel}${num}')">
      ${thumb}<span style="color:${tagColor};font-weight:500">${typeLabel}${num}</span>
    </div>`;
  }).join("");
}

function showMentionAtCursor() {
  const popup = document.getElementById("mention-popup");
  const compose = document.getElementById("compose-box");
  const composeRect = compose.getBoundingClientRect();

  buildMentionList();
  closeAllPopups();

  // Position at caret using Selection API
  const sel = window.getSelection();
  if (sel.rangeCount) {
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);
    const caretRect = range.getBoundingClientRect();
    popup.style.left = (caretRect.left - composeRect.left) + "px";
    popup.style.bottom = "";
    popup.style.top = (caretRect.bottom - composeRect.top + 4) + "px";
  }

  popup.classList.add("open");
  openPopup = popup;
  openPill = null;
}

// ── Prompt editor helpers ──
function getPromptText() {
  const el = document.getElementById("i-prompt");
  let text = "";
  function walk(node) {
    for (const child of node.childNodes) {
      if (child.classList && child.classList.contains("mention")) {
        text += child.getAttribute("data-text") || child.textContent;
        continue; // skip entire subtree
      }
      if (child.tagName === "BR") { text += "\n"; continue; }
      if (child.nodeType === Node.TEXT_NODE) { text += child.textContent; continue; }
      if (child.childNodes.length) walk(child); // recurse into divs/spans etc
    }
  }
  walk(el);
  return text;
}

function mentionThumbHtml(mType, url) {
  if (!url && mType !== "audio") return '';
  if (mType === "video") return `<img class="mention-inline-thumb" src="${esc(url)}">`;
  if (mType === "audio") return `<span class="mention-inline-thumb" style="display:inline-flex;align-items:center;justify-content:center;background:#f0f2f5;font-size:10px">🎵</span>`;
  return `<img class="mention-inline-thumb" src="${esc(url)}">`;
}

function setPromptText(text) {
  const el = document.getElementById("i-prompt");
  if (!text) { el.innerHTML = ""; return; }
  el.innerHTML = esc(text).replace(/@(Image|Video|Audio)(\d+)/g, (match, type, num) => {
    const mType = type.toLowerCase();
    const idx = parseInt(num);
    let count = 0;
    const item = mediaItems.find(m => m.type === mType && ++count === idx);
    const thumb = item ? mentionThumbHtml(mType, item.thumbUrl) : '';
    return `<span class="mention" contenteditable="false" data-type="${mType}" data-text="${esc(match)}">${thumb}${match}</span>`;
  });
}

function buildMentionSpan(label, type, thumbUrl) {
  const span = document.createElement("span");
  span.className = "mention";
  span.contentEditable = "false";
  span.setAttribute("data-type", type);
  span.setAttribute("data-text", "@" + label);
  const thumbHtml = mentionThumbHtml(type, thumbUrl);
  if (thumbHtml) {
    const temp = document.createElement("span");
    temp.innerHTML = thumbHtml;
    span.appendChild(temp.firstChild);
  }
  span.appendChild(document.createTextNode("@" + label));
  return span;
}

let _savedRange = null;

function insertMention(text) {
  const el = document.getElementById("i-prompt");
  el.focus();
  const sel = window.getSelection();
  if (_savedRange) {
    sel.removeAllRanges();
    sel.addRange(_savedRange);
  }
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);

  // Find and remove the preceding "@"
  const textNode = range.startContainer;
  if (textNode.nodeType === Node.TEXT_NODE) {
    const t = textNode.textContent;
    const offset = range.startOffset;
    const atIdx = t.lastIndexOf("@", offset - 1);
    if (atIdx >= 0 && atIdx >= offset - 1) {
      textNode.textContent = t.slice(0, atIdx) + t.slice(offset);
      range.setStart(textNode, atIdx);
      range.collapse(true);
    }
  }

  const typeLabel = text;
  const mType = text.replace(/\d+$/, "").toLowerCase();
  const idx = parseInt(text.replace(/\D/g, ""));
  let count = 0;
  const item = mediaItems.find(m => m.type === mType && ++count === idx);

  const span = buildMentionSpan(text, mType, item?.thumbUrl);
  range.insertNode(span);

  // Add a space after and move cursor there
  const space = document.createTextNode("\u00A0");
  span.after(space);
  range.setStartAfter(space);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);

  closeAllPopups();
  el.focus();
  savePromptToStorage();
}

// ── Mention thumb preview ──
const _preview = document.createElement("div");
_preview.className = "mention-preview";
_preview.innerHTML = '<img>';
document.body.appendChild(_preview);

document.getElementById("i-prompt").addEventListener("mouseover", (e) => {
  const mention = e.target.closest(".mention");
  if (!mention) return;
  const thumb = mention.querySelector(".mention-inline-thumb");
  if (!thumb) return;
  const rect = mention.getBoundingClientRect();
  const pImg = _preview.querySelector("img");
  pImg.onload = () => {
    _preview.style.left = (rect.left + rect.width / 2 - pImg.offsetWidth / 2) + "px";
    _preview.style.top = (rect.top - pImg.offsetHeight - 8) + "px";
    _preview.classList.add("visible");
  };
  pImg.src = thumb.src;
  if (pImg.complete) pImg.onload();
});
document.getElementById("i-prompt").addEventListener("mouseout", (e) => {
  const mention = e.target.closest(".mention");
  if (mention || e.target.classList?.contains("mention")) {
    _preview.classList.remove("visible");
  }
});

// ── Prompt helpers (global) ──
let mentionIdx = 0;

function autoResize() { /* contenteditable grows naturally */ }

function updateHighlight() { /* no longer needed - contenteditable handles display */ }

let isComposing = false;
document.getElementById("i-prompt").addEventListener("compositionstart", () => { isComposing = true; });
document.getElementById("i-prompt").addEventListener("compositionend", () => { isComposing = false; onPromptInput(); });
// Save selection so mention popup click can restore it
document.addEventListener("selectionchange", () => {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const el = document.getElementById("i-prompt");
  if (el.contains(sel.anchorNode)) _savedRange = sel.getRangeAt(0).cloneRange();
});

function savePromptToStorage() {
  syncPrefs();
}

function onPromptInput() {
  savePromptToStorage();
  if (isComposing) return;
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    const t = node.textContent;
    const pos = range.startOffset;
    if (pos > 0 && t[pos - 1] === "@") {
      if (mediaItems.length > 0) {
        mentionIdx = 0;
        showMentionAtCursor();
      }
    } else if (openPopup === document.getElementById("mention-popup")) {
      closeAllPopups();
    }
  } else if (openPopup === document.getElementById("mention-popup")) {
    closeAllPopups();
  }
}

function onPromptKeydown(e) {
  const popup = document.getElementById("mention-popup");
  if (!popup.classList.contains("open")) return;
  const items = popup.querySelectorAll(".mention-item");
  if (!items.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    mentionIdx = (mentionIdx + 1) % items.length;
    highlightMentionItem(items);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    mentionIdx = (mentionIdx - 1 + items.length) % items.length;
    highlightMentionItem(items);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (items[mentionIdx]) items[mentionIdx].click();
  } else if (e.key === "Escape") {
    closeAllPopups();
  }
}

function highlightMentionItem(items) {
  items.forEach((el, i) => el.classList.toggle("active", i === mentionIdx));
}

// ── Media management ──
const ALL_ACCEPT = [ACCEPT.image, ACCEPT.video, ACCEPT.audio].join(",");

function detectFileType(file) {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  // Fallback: check extension
  const ext = file.name.split(".").pop().toLowerCase();
  if (["jpg","jpeg","png","webp","bmp","tiff","gif"].includes(ext)) return "image";
  if (["mp4","mov","webm","avi","mkv"].includes(ext)) return "video";
  if (["wav","mp3","aac","ogg","flac","m4a"].includes(ext)) return "audio";
  return "image"; // default
}

function pickFile() {
  if (!requireApiKey(pickFile)) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ALL_ACCEPT;
  input.multiple = true;
  input.onchange = () => {
    let skipped = false;
    for (const file of input.files) {
      const type = detectFileType(file);
      if (!canAddMedia(type)) { skipped = true; continue; }
      const id = ++mediaIdCounter;
      const thumbUrl = (type === "image" || type === "video") ? URL.createObjectURL(file) : "";
      const item = { id, type, url: "", thumbUrl, name: file.name, file };
      mediaItems.push(item);
      handleFileForItem(id, file);
    }
    renderStack();
    if (skipped) alert("Limit reached: max 9 images, 3 videos, 3 audio.");
  };
  input.click();
}

// ── Drag & Drop ──
const _compose = document.getElementById("compose-box");
let _dragCount = 0;
_compose.addEventListener("dragenter", (e) => { e.preventDefault(); _dragCount++; _compose.classList.add("drag-over"); });
_compose.addEventListener("dragleave", (e) => { e.preventDefault(); if (--_dragCount <= 0) { _dragCount = 0; _compose.classList.remove("drag-over"); } });
_compose.addEventListener("dragover", (e) => e.preventDefault());
_compose.addEventListener("drop", (e) => {
  e.preventDefault();
  _dragCount = 0;
  _compose.classList.remove("drag-over");
  // Asset library drag — insert existing asset without re-uploading
  const assetId = e.dataTransfer.getData("application/x-asset-id");
  if (assetId) {
    insertSavedAsset(Number(assetId));
    return;
  }
  const files = e.dataTransfer.files;
  if (!files.length) return;
  let skipped = false;
  for (const file of files) {
    const type = detectFileType(file);
    if (!canAddMedia(type)) { skipped = true; continue; }
    const id = ++mediaIdCounter;
    const thumbUrl = (type === "image" || type === "video") ? URL.createObjectURL(file) : "";
    mediaItems.push({ id, type, url: "", thumbUrl, name: file.name, file });
    handleFileForItem(id, file);
  }
  renderStack();
  if (skipped) alert("Limit reached: max 9 images, 3 videos, 3 audio.");
});

// Keep addMedia for asset library usage
function addMedia(type) {
  const id = ++mediaIdCounter;
  const item = { id, type, url: "", thumbUrl: "", name: "", file: null };
  mediaItems.push(item);
  renderStack();
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ACCEPT[type];
  input.onchange = () => handleFileForItem(id, input.files[0]);
  input.click();
}

function removeMediaItem(id) {
  const idx = mediaItems.findIndex(m => m.id === id);
  if (idx < 0) { renderStack(); return; }
  const item = mediaItems[idx];
  let typeIdx = 0;
  for (let i = 0; i <= idx; i++) {
    if (mediaItems[i].type === item.type) typeIdx++;
  }
  if (item.thumbUrl && item.thumbUrl.startsWith("blob:")) {
    URL.revokeObjectURL(item.thumbUrl);
  }
  mediaItems.splice(idx, 1);
  updateMentionsAfterRemove(item.type, typeIdx);
  renderStack();
}

function updateMentionsAfterRemove(removedType, removedIdx) {
  const typeLabel = { image: "Image", video: "Video", audio: "Audio" }[removedType];
  if (!typeLabel) return;
  const editor = document.getElementById("i-prompt");
  const mentions = [...editor.querySelectorAll(`.mention[data-type="${removedType}"]`)];
  for (const span of mentions) {
    const text = span.getAttribute("data-text") || span.textContent;
    const m = text.match(/^@(Image|Video|Audio)(\d+)$/);
    if (!m) continue;
    const n = parseInt(m[2], 10);
    if (n === removedIdx) {
      const next = span.nextSibling;
      if (next && next.nodeType === Node.TEXT_NODE && /^[\u00A0 ]/.test(next.textContent)) {
        next.textContent = next.textContent.slice(1);
      }
      span.remove();
    } else if (n > removedIdx) {
      const newLabel = typeLabel + (n - 1);
      const newText = "@" + newLabel;
      span.setAttribute("data-text", newText);
      const textNode = [...span.childNodes].reverse().find(c => c.nodeType === Node.TEXT_NODE);
      if (textNode) textNode.textContent = newText;
    }
  }
  savePromptToStorage();
}

function renderStack() {
  syncPrefs();
  const container = document.getElementById("media-stack");
  const addWrap = document.getElementById("add-wrap");

  // Remove old stack-items if exists
  const old = document.getElementById("stack-items");
  if (old) old.remove();

  const n = mediaItems.length;
  if (n === 0) {
    container.classList.add("empty-stack");
    return;
  }

  container.classList.remove("empty-stack");

  // Create stack-items container
  const stackItems = document.createElement("div");
  stackItems.className = "stack-items";
  stackItems.id = "stack-items";
  container.insertBefore(stackItems, addWrap);

  // Calculate stacked positions
  const rotations = n === 1 ? [0] : n === 2 ? [-6, 5] : n === 3 ? [-8, 0, 7] : generateRotations(n);

  mediaItems.forEach((item, i) => {
    const div = document.createElement("div");
    div.className = "stack-item";
    div.style.zIndex = i + 1;
    div.style.transform = `rotate(${rotations[i] || 0}deg)`;
    // Slight offset for stacking depth
    const offsetX = (i - (n - 1) / 2) * 4;
    const offsetY = (n - 1 - i) * 2;
    div.style.left = offsetX + "px";
    div.style.top = offsetY + "px";

    let inner = "";
    const stackSrc = stackThumbSrc(item);
    if (stackSrc && (item.type === "image" || item.type === "video")) {
      inner = `<img src="${esc(stackSrc)}">`;
    } else {
      const icons = { image: "🖼", video: "🎬", audio: "🎵" };
      inner = `<div class="stack-icon">${icons[item.type]}</div>`;
    }
    if (item.type === "video" && item.url) {
      inner += `<span class="stack-dur">00:${String(parseInt(document.getElementById("i-dur").value)||15).padStart(2,"0")}</span>`;
    }
    inner += `<button class="stack-remove" onclick="event.stopPropagation();removeMediaItem(${item.id})">&times;</button>`;
    div.innerHTML = inner;
    div.onclick = () => triggerReupload(item.id);
    stackItems.appendChild(div);
  });
  updateCostLabel();
}

// Pick the right URL for a stack-item thumbnail. Image: thumbUrl is fine.
// Video: thumbUrl is sometimes the mp4 itself (legacy uploads, or prefs reload
// where we only had cosUrl) — `<img src=mp4>` renders broken. When we know the
// asset_id, prefer the signed /api/assets/{id}/thumb endpoint (server returns the
// real first-frame, generating it on first miss). Falls back to thumbUrl when
// it's a blob: (fresh upload before persistedThumbUrl set) or when there's
// nothing better.
function stackThumbSrc(item) {
  if (item.type === "video" && item.assetUrl) {
    const a = (typeof assetLibrary !== "undefined" ? assetLibrary : []).find(x => x.asset_id === item.assetUrl);
    if (a && a.id != null && a.thumb_token) {
      return `/api/assets/${a.id}/thumb?t=${encodeURIComponent(a.thumb_token)}`;
    }
  }
  if (item.thumbUrl && (item.thumbUrl.startsWith("blob:") || !item.thumbUrl.endsWith(".mp4"))) {
    return item.thumbUrl;
  }
  return "";
}

function generateRotations(n) {
  const r = [];
  for (let i = 0; i < n; i++) r.push(-10 + (20 / (n - 1)) * i);
  return r;
}
function triggerReupload(id) {
  const item = mediaItems.find(m => m.id === id);
  if (!item) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ALL_ACCEPT;
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    // Update type based on new file
    item.type = detectFileType(file);
    handleFileForItem(id, file);
  };
  input.click();
}

async function handleFileForItem(id, file) {
  if (!file) return;
  pendingUploads++;
  const item = mediaItems.find(m => m.id === id);
  if (!item) { pendingUploads--; return; }
  item.name = file.name;
  item.file = file;

  // Local preview (revoke old blob URL to prevent memory leak)
  if (item.thumbUrl && item.thumbUrl.startsWith("blob:")) {
    URL.revokeObjectURL(item.thumbUrl);
  }
  if (item.type === "image") {
    item.thumbUrl = URL.createObjectURL(file);
  } else if (item.type === "video") {
    // Extract first frame for thumbnail; fall back to raw video blob if canvas fails
    item.thumbUrl = await extractVideoThumbnail(file) || URL.createObjectURL(file);
  }
  renderStack();

  try {
    let fileUrl, hash, reused = false, reusedAsset = null, thumbUrl = item.thumbUrl;
    if (item.type === "video") {
      const videoHash = await sha256Hex(file);
      const existing = await lookupAssetByHash(videoHash);
      if (existing && existing.storage_url && existing.type === "video") {
        showToast({ type: "success", title: existing.asset_status === "ready" ? "Reused video (whitelisted)" : "Reused video", desc: file.name || existing.name || "" });
        fileUrl = existing.storage_url;
        hash = videoHash;
        reused = true;
        reusedAsset = existing;
        thumbUrl = existing.thumb_url || thumbUrl;
      }
      let thumbBlob = null;
      if (item.thumbUrl && item.thumbUrl.startsWith("blob:")) {
        try { thumbBlob = await fetch(item.thumbUrl).then(r => r.blob()); } catch { /* non-fatal */ }
      }
      if (!reused) {
        // Upload video and first-frame thumbnail in parallel
        const form = new FormData();
        form.append("file", file);
        const thumbFile = thumbBlob
          ? new File([thumbBlob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" })
          : null;
        const [videoResp, uploadedThumbUrl] = await Promise.all([
          fetch("/api/upload/video", { method: "POST", headers: uploadHeaders(), body: form }),
          thumbFile ? uploadAssetWithHash(thumbFile, null, { dedupe: false }).then(r => r.fileUrl).catch(() => null) : Promise.resolve(null),
        ]);
        if (!videoResp.ok) {
          const err = await videoResp.json().catch(() => ({}));
          throw new Error(err.error || `Upload failed: ${videoResp.status}`);
        }
        ({ fileUrl } = await videoResp.json());
        if (uploadedThumbUrl) thumbUrl = uploadedThumbUrl;
        hash = videoHash;
        item.contentHash = hash || "";
      }
    } else {
      const result = await uploadAssetWithHash(file);
      fileUrl = result.fileUrl;
      hash = result.hash;
      reused = result.reused;
      reusedAsset = result.asset || null;
    }
    item.url = fileUrl;
    item.cosUrl = fileUrl;
    item.contentHash = hash || "";
    item.assetUrl = reusedAsset?.asset_id || "";
    item.assetStatus = reusedAsset?.asset_status || "";
    item.persistedThumbUrl = thumbUrl || "";
    renderStack();
    if (reused && reusedAsset) {
      const existingIdx = assetLibrary.findIndex(a => a.id === reusedAsset.id);
      if (existingIdx >= 0) assetLibrary.splice(existingIdx, 1);
      assetLibrary.unshift(reusedAsset);
      renderAssetGrid();
    } else {
      await registerAssetOnUpload(item);
    }
  } catch (err) {
    alert("Upload failed: " + (err.message || "Please retry"));
    removeMediaItem(id);
  } finally {
    pendingUploads--;
  }
}

// ── Keyframe mode ──
function pickKfFile(which) {
  if (!requireApiKey(() => pickKfFile(which))) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ACCEPT.image;
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    // Revoke old blob URL
    const old = which === "first" ? kfFirst : kfLast;
    if (old && old.thumbUrl && old.thumbUrl.startsWith("blob:")) {
      URL.revokeObjectURL(old.thumbUrl);
    }
    const thumbUrl = URL.createObjectURL(file);
    const obj = { url: "", thumbUrl, name: file.name, file };
    if (which === "first") kfFirst = obj; else kfLast = obj;
    renderKfCard(which);
    uploadKfFile(which, file);
  };
  input.click();
}

function removeKf(which, e) {
  e.stopPropagation();
  const obj = which === "first" ? kfFirst : kfLast;
  if (obj && obj.thumbUrl && obj.thumbUrl.startsWith("blob:")) {
    URL.revokeObjectURL(obj.thumbUrl);
  }
  if (which === "first") kfFirst = null; else kfLast = null;
  renderKfCard(which);
}

function renderKfCard(which) {
  syncPrefs();
  const card = document.getElementById(which === "first" ? "kf-first" : "kf-last");
  const obj = which === "first" ? kfFirst : kfLast;
  const label = which === "first" ? "First Frame" : "Last Frame";
  if (obj && obj.thumbUrl) {
    card.className = "kf-card has-img";
    card.innerHTML = `<img src="${esc(obj.thumbUrl)}"><button class="kf-remove" onclick="removeKf('${which}',event)">&times;</button>`;
  } else {
    card.className = "kf-card";
    card.innerHTML = `<span class="kf-plus">+</span><span class="kf-label">${label}</span>`;
  }
}

async function uploadKfFile(which, file) {
  const obj = which === "first" ? kfFirst : kfLast;
  if (!obj) return;
  pendingUploads++;
  try {
    const { fileUrl, hash, reused, asset } = await uploadAssetWithHash(file);
    obj.url = fileUrl;
    obj.cosUrl = fileUrl;
    obj.type = "image";
    obj.contentHash = hash;
    obj.assetUrl = asset?.asset_id || "";
    obj.assetStatus = asset?.asset_status || "";
    console.log(`[KF Upload] ${which} uploaded:`, fileUrl, reused ? "(reused)" : "");
    if (reused && asset) {
      const existingIdx = assetLibrary.findIndex(a => a.id === asset.id);
      if (existingIdx >= 0) assetLibrary.splice(existingIdx, 1);
      assetLibrary.unshift(asset);
      renderAssetGrid();
    } else {
      await registerAssetOnUpload(obj);
    }
  } catch (err) {
    alert("Upload failed: " + (err.message || "Please retry"));
    if (which === "first") kfFirst = null; else kfLast = null;
    renderKfCard(which);
  } finally {
    pendingUploads--;
  }
}

// ── Build request ──
function preferredStorage() {
  const base = document.getElementById("i-base")?.value || "";
  const host = location.hostname || "";
  return base.includes("anyfast.com.cn") || host.includes("anyfast.com.cn") ? "tos" : "cos";
}

function uploadHeaders() {
  const key = document.getElementById("i-key").value.trim();
  const base = document.getElementById("i-base").value.trim();
  const h = { "X-Storage": preferredStorage() };
  if (key) h["X-Api-Key"] = key;
  if (base) h["X-Api-Base"] = encodeURI(base);
  return h;
}

function apiHeaders() {
  return { ...uploadHeaders(), "Content-Type": "application/json" };
}

async function readJsonResponse(resp) {
  const text = await resp.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { error: text }; }
}

// Strip characters Seedance / upstream models choke on when emitted in the prompt
// (emoji, pictographs, decorative dingbats, zero-width joiners). Keeps CJK, Latin,
// digits, and standard punctuation.
function sanitizePrompt(s) {
  if (!s) return "";
  return s
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function buildRequest() {
  const content = [];
  const prompt = sanitizePrompt(getPromptText());
  if (prompt) content.push({ type: "text", text: prompt });

  const refMode = document.getElementById("i-ref").value;
  // Keep the page state centered on stable storage URLs. The server resolves
  // image/video storage URLs to asset:// just before forwarding upstream.
  const pickStorageOrAsset = (item) => {
    const candidates = [item.cosUrl, item.url, item.assetUrl];
    for (const u of candidates) {
      if (typeof u === "string" && (u.startsWith("asset://") || u.startsWith("https://"))) return u;
    }
    return "";
  };

  // Capture the cosUrl alongside every asset:// reference as diagnostic context;
  // the server strips these private fields before forwarding upstream.
  const cosOf = (item) => {
    const u = item.cosUrl || item.url;
    return (typeof u === "string" && u.startsWith("https://")) ? u : "";
  };

  if (refMode === "keyframes") {
    if (kfFirst) {
      const u = pickStorageOrAsset(kfFirst);
      if (u) content.push({ type: "image_url", image_url: { url: u, _cosUrl: cosOf(kfFirst), _name: kfFirst.name || "", _contentHash: kfFirst.contentHash || "" }, role: "first_frame" });
    }
    if (kfLast) {
      const u = pickStorageOrAsset(kfLast);
      if (u) content.push({ type: "image_url", image_url: { url: u, _cosUrl: cosOf(kfLast), _name: kfLast.name || "", _contentHash: kfLast.contentHash || "" }, role: "last_frame" });
    }
  } else {
    const grouped = { video: [], image: [], audio: [] };
    for (const item of mediaItems) {
      if (item.type === "audio") {
        const u = pickStorageOrAsset(item);
        if (u) grouped.audio.push({ type: "audio_url", audio_url: { url: u, _cosUrl: cosOf(item), _name: item.name || "", _contentHash: item.contentHash || "" }, role: "reference_audio" });
        continue;
      }
      const u = pickStorageOrAsset(item);
      if (!u) continue;
      if (item.type === "image") {
        grouped.image.push({ type: "image_url", image_url: { url: u, _cosUrl: cosOf(item), _name: item.name || "", _contentHash: item.contentHash || "" }, role: "reference_image" });
      } else if (item.type === "video") {
        grouped.video.push({ type: "video_url", video_url: { url: u, _cosUrl: cosOf(item), _name: item.name || "", _contentHash: item.contentHash || "" }, role: "reference_video" });
      }
    }
    content.push(...grouped.image, ...grouped.video, ...grouped.audio);
  }

  const body = {
    model: document.getElementById("i-model").value,
    prompt,
    content,
    resolution: document.getElementById("i-res").value,
    ratio: document.getElementById("i-ratio").value,
    duration: parseInt(document.getElementById("i-dur").value, 10),
    generate_audio: true,
    watermark: document.getElementById("i-wm")?.checked || false,
  };
  if (document.getElementById("i-search")?.checked) {
    body.tools = [{ type: "web_search" }];
  }
  return body;
}

// ── Generate ──
async function generate() {
  const btn = document.getElementById("gen-btn");
  // Micro-animation: restart by forcing reflow
  btn.classList.remove("sending");
  void btn.offsetWidth;
  btn.classList.add("sending");
  btn.disabled = true;
  try {
    if (pendingUploads > 0) {
      while (pendingUploads > 0) await new Promise(r => setTimeout(r, 200));
    }
    const apiKey = document.getElementById("i-key").value.trim();
    if (!apiKey) {
      btn.disabled = false; btn.classList.remove("sending");
      showKeyModal(); return;
    }
    const refMode = document.getElementById("i-ref").value;
    // Promote already-whitelisted storage URLs to asset:// and proactively
    // whitelist any remaining media before generation.
    await reconcileAssetUrls();

    // Surface visual items that failed to acquire an asset_id — buildRequest will
    // drop them, leading to a quietly-shorter request. Better to fail loudly so
    // the user knows to retry instead of getting silently degraded output.
    const visualSources = refMode === "keyframes"
      ? [kfFirst, kfLast].filter(Boolean)
      : mediaItems.filter(m => m && m.type !== "audio" && (m.cosUrl || m.url));
    const stranded = visualSources.filter(m => !(typeof m.assetUrl === "string" && m.assetUrl.startsWith("asset://")));
    if (stranded.length > 0) {
      btn.disabled = false; btn.classList.remove("sending");
      showToast({
        type: "warn",
        title: "Whitelisting in progress",
        desc: `${stranded.length} item(s) still preparing. Please retry in a few seconds.`,
        duration: 4000,
      });
      return;
    }

    const body = buildRequest();
    console.log("[Generate] Request body:", JSON.stringify(body, null, 2));
    if (body.content.length === 0) {
      btn.disabled = false; btn.classList.remove("sending");
      alert("Please add a prompt or media before generating."); return;
    }
    const inputSnapshot = {
      prompt: getPromptText().trim(),
      model: document.getElementById("i-model").value,
      ratio: document.getElementById("i-ratio").value,
      duration: parseInt(document.getElementById("i-dur").value, 10),
      refMode,
      webSearch: document.getElementById("i-search")?.checked || false,
      watermark: document.getElementById("i-wm")?.checked || false,
      mediaItems: refMode === "all" ? mediaItems.filter(m => m.url).map(m => ({ type: m.type, url: m.url, cosUrl: m.cosUrl || "", name: m.name, assetUrl: m.assetUrl || "", contentHash: m.contentHash || "" })) : [],
      kfFirst: (kfFirst && kfFirst.url) ? { url: kfFirst.url, cosUrl: kfFirst.cosUrl || "", name: kfFirst.name, assetUrl: kfFirst.assetUrl || "", contentHash: kfFirst.contentHash || "" } : null,
      kfLast: (kfLast && kfLast.url) ? { url: kfLast.url, cosUrl: kfLast.cosUrl || "", name: kfLast.name, assetUrl: kfLast.assetUrl || "", contentHash: kfLast.contentHash || "" } : null,
    };
    // Show placeholder task immediately
    const task = { id: null, status: "submitting", progress: 0, created: Date.now(), response: null, videoUrl: null, pollErrors: 0, input: inputSnapshot };
    tasks.unshift(task);
    renderTasks();
    // Re-enable button after 1.5s regardless of submission result
    setTimeout(() => { btn.disabled = false; btn.classList.remove("sending"); }, 1500);
    // Run submission in background (non-blocking)
    runSubmit(task, body);
  } catch (err) {
    btn.disabled = false; btn.classList.remove("sending");
    alert(friendlyError(err.message));
  }
}

async function runSubmit(task, body) {
  let lastErr = "";
  let currentBody = body;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[Generate] Attempt ${attempt}/3...`);
      const resp = await fetch("/api/generate", { method: "POST", headers: apiHeaders(), body: JSON.stringify(currentBody) });
      const data = await readJsonResponse(resp);
      const errMsg = (typeof data.error === "string" ? data.error : data.error?.message) || data.message || data.msg || "";
      if (!resp.ok || (data.code && data.code !== "success")) {
        lastErr = errMsg || JSON.stringify(data);
        const rawJson = JSON.stringify(data);
        console.warn(`[Generate] Attempt ${attempt} failed:`, lastErr);
        // Upstream 'invalid url scheme' is usually an indexing/resolve delay
        // between the asset service and generation service. Do not rebuild the
        // permanent asset here; retry the same body so one upload maps to one
        // asset_id.
        if ((rawJson.includes("invalid url scheme") || data.code === "ASSET_SYNC_PENDING") && attempt < 3) {
          const waitMs = attempt === 1 ? 15000 : 30000;
          console.log(`[Generate] asset sync pending — waiting ${waitMs / 1000}s before retrying same body`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        // Upstream asset_id orphaned → ask user to confirm re-upload, then retry
        if (data.code === "ASSETS_UNRECOVERABLE" && Array.isArray(data.assetIds) && data.assetIds.length && attempt < 3) {
          const recovered = await recoverUnrecoverableAssets(currentBody, data.assetIds, task);
          if (recovered) {
            currentBody = recovered;
            continue;
          }
          lastErr = "Cancelled by user";
          break;
        }
        // PrivacyInformation → server-side bulk whitelist, then retry.
        // If the body already has every image/video on asset://, retrying won't
        // change anything — the upstream privacy guard is rejecting the actual
        // image content, not the URL form. Bail out so the user gets the real
        // "image may contain real person" message instead of waiting through
        // doomed retries.
        if ((lastErr.includes("PrivacyInformation") || rawJson.includes("PrivacyInformation")) && attempt < 3) {
          const allVisualOnAsset = (currentBody.content || []).every(c => {
            if (c.type !== "image_url" && c.type !== "video_url") return true;
            const url = c.image_url?.url || c.video_url?.url || "";
            return url.startsWith("asset://");
          });
          if (allVisualOnAsset) {
            console.log("[Generate] PrivacyInformation persists with all-asset body — image content rejected by upstream, not retrying");
            break;
          }
          console.log("[Generate] PrivacyInformation detected, bulk whitelisting...");
          task.status = "whitelisting";
          task.whitelistStart = Date.now();
          renderTasks();
          const needWhitelist = currentBody.content.filter(c => {
            const url = c.image_url?.url || c.video_url?.url || c.audio_url?.url;
            return url && !url.startsWith("asset://");
          });
          if (needWhitelist.length > 0) {
            try {
              const lookupItem = (u) => mediaItems.find(m => (m.cosUrl || m.url) === u)
                || (kfFirst && (kfFirst.cosUrl || kfFirst.url) === u ? kfFirst : null)
                || (kfLast && (kfLast.cosUrl || kfLast.url) === u ? kfLast : null);
              const storageUrls = needWhitelist.map(c => c.image_url?.url || c.video_url?.url || c.audio_url?.url);
              const items = needWhitelist.map(c => {
                const u = c.image_url?.url || c.video_url?.url || c.audio_url?.url;
                const it = lookupItem(u);
                const type = c.type === "video_url" ? "video" : c.type === "audio_url" ? "audio" : "image";
                return { url: u, contentHash: it?.contentHash || "", name: it?.name || "", type };
              });
              const resp = await fetch("/api/assets/bulk-whitelist", {
                method: "POST", headers: assetHeaders(),
                body: JSON.stringify({ storageUrls, items }),
              });
              const { results, errors: wlErrors } = await readJsonResponse(resp);
              const urlMap = {};
              for (const [cosUrl, assetUrl] of Object.entries(results || {})) {
                if (!assetUrl) continue;
                urlMap[cosUrl] = assetUrl;
                const item = mediaItems.find(m => (m.cosUrl || m.url) === cosUrl);
                if (item) item.assetUrl = assetUrl;
                if (kfFirst && (kfFirst.cosUrl || kfFirst.url) === cosUrl) kfFirst.assetUrl = assetUrl;
                if (kfLast && (kfLast.cosUrl || kfLast.url) === cosUrl) kfLast.assetUrl = assetUrl;
              }
              const firstErr = Object.values(wlErrors || {})[0];
              if (firstErr) {
                const isQuota = firstErr.includes("额度不足") || firstErr.includes("quota") || firstErr.includes("insufficient") || firstErr.includes("balance");
                showToast({ type: "warn", title: isQuota ? "账户余额不足" : "素材加白失败", desc: isQuota ? "请前往 AnyFast 充值后重试" : firstErr, duration: 5000 });
              }
              // Retry with the ORIGINAL body — only swap cos URLs to asset:// URLs in content.
              // Never rebuild from current UI: user may have changed duration/ratio/mediaItems meanwhile.
              const swapUrl = (c, key) => urlMap[c[key].url]
                ? { ...c, [key]: { ...c[key], url: urlMap[c[key].url] } }
                : c;
              currentBody = {
                ...currentBody,
                content: currentBody.content.map(c => {
                  if (c.type === "image_url") return swapUrl(c, "image_url");
                  if (c.type === "video_url") return swapUrl(c, "video_url");
                  if (c.type === "audio_url") return swapUrl(c, "audio_url");
                  return c;
                }),
              };
              loadAssetLibrary();
            } catch (e) { console.warn("[Generate] Bulk whitelist failed:", e.message); }
          }
          console.log("[Generate] Retry body:", JSON.stringify(currentBody, null, 2));
          continue;
        }
        if (attempt < 3) { await new Promise(r => setTimeout(r, 2000)); continue; }
      } else {
        const parsed = parseResponse(data);
        task.id = parsed.id;
        task.status = parsed.status;
        task.progress = parsed.progress;
        task.response = data;
        task.videoUrl = parsed.videoUrl;
        if (parsed.createdAt) task.apiCreatedAt = parsed.createdAt;
        if (parsed.updatedAt) task.apiUpdatedAt = parsed.updatedAt;
        saveTasks(); renderTasks();
        if (parsed.id) startPolling();
        return;
      }
    } catch (e) {
      lastErr = e.message;
      console.warn(`[Generate] Attempt ${attempt} error:`, e.message);
      if (attempt < 3) { await new Promise(r => setTimeout(r, 2000)); continue; }
    }
  }
  // All attempts failed
  task.status = "failed";
  task.endTime = Date.now();
  task.error = friendlyError(lastErr);
  task.response = { _error: lastErr };
  saveTasks(); renderTasks();
}

// ── Task management ──
function saveTasks() {
  syncPrefs();
}

function hasRunningTasks() {
  const TERMINAL = ["completed","failed","cancelled"];
  return tasks.some(t => t.id && !TERMINAL.includes(t.status));
}
function startPolling() {
  if (pollTimer) return;
  if (document.hidden) return; // visibilitychange will start polling when tab becomes visible
  pollAll();
  pollTimer = setInterval(pollAll, 6000);
}
function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

async function pollAll() {
  const TERMINAL = ["completed","failed","cancelled"];
  const running = tasks.filter(t => t.id && !TERMINAL.includes(t.status));
  if (running.length === 0) { clearInterval(pollTimer); pollTimer = null; saveTasks(); renderTasks(); return; }
  let changed = false;
  for (const task of running) {
    try {
      const resp = await fetch(`/api/status/${task.id}`, { headers: apiHeaders() });
      const data = await readJsonResponse(resp);
      task.response = data;
      if (resp.ok && data.code !== "fail_to_fetch_task") {
        const parsed = parseResponse(data);
        if (!task.videoUrl) task.videoUrl = parsed.videoUrl;
        const finalStatus = task.videoUrl ? "completed" : parsed.status;
        if (task.status !== finalStatus || task.progress !== parsed.progress || (!task.videoUrl && parsed.videoUrl)) changed = true;
        task.status = finalStatus;
        task.progress = task.videoUrl ? null : parsed.progress;
        if (parsed.createdAt) task.apiCreatedAt = parsed.createdAt;
        if (parsed.updatedAt) task.apiUpdatedAt = parsed.updatedAt;
        task.pollErrors = 0;
      } else {
        // If we already have a videoUrl, the generation succeeded
        if (task.videoUrl) {
          task.status = "completed"; task.endTime = Date.now(); changed = true;
        } else {
          task.pollErrors = (task.pollErrors||0)+1;
          if (task.pollErrors >= 5) { task.status="failed"; task.endTime=Date.now(); changed=true; }
        }
      }
    } catch(e) {
      if (task.videoUrl) {
        task.status = "completed"; task.endTime = Date.now(); changed = true;
      } else {
        task.pollErrors = (task.pollErrors||0)+1;
        if (task.pollErrors >= 5) { task.status="failed"; task.endTime=Date.now(); changed=true; }
      }
    }
  }
  saveTasks();
  if (changed) renderTasks();
}

const STATUS_MAP = {"IN_PROGRESS":"running","SUCCESS":"completed","FAILED":"failed","CANCELLED":"cancelled","running":"running","completed":"completed","failed":"failed","cancelled":"cancelled","submitted":"submitted","success":"completed","succeeded":"completed","done":"completed"};

function parseResponse(raw) {
  const wrap = raw.data||raw; const inner = wrap.data||wrap;
  const videoUrl = findVideoUrl(raw);
  // If there's a video URL, the task completed regardless of status field
  if (videoUrl) {
    return { id: inner.id||wrap.task_id||raw.id, status: "completed", progress: null, videoUrl, createdAt: inner.created_at||wrap.created_at||0, updatedAt: inner.updated_at||wrap.updated_at||0 };
  }
  const rawStatus = raw.status||inner.status||wrap.status||"submitted";
  const status = STATUS_MAP[rawStatus] || STATUS_MAP[inner.status||wrap.status||"submitted"] || (wrap.status||"submitted").toLowerCase();
  const progress = (status === "completed" || status === "failed" || status === "cancelled") ? null : (wrap.progress||raw.progress||null);
  return { id: inner.id||wrap.task_id||raw.id, status, progress, videoUrl: null, createdAt: inner.created_at||wrap.created_at||0, updatedAt: inner.updated_at||wrap.updated_at||0 };
}

function findVideoUrl(d) {
  if(d.video?.url)return d.video.url; if(d.video_result?.[0]?.url)return d.video_result[0].url; if(d.output?.video_url)return d.output.video_url;
  const m=JSON.stringify(d).match(/(https?:\/\/[^"\\]+\.mp4[^"\\]*)/); return m?m[1]:null;
}

function fmtSec(s){if(s<0)s=0;s=Math.floor(s);const m=Math.floor(s/60);return m>0?`${m}m ${s%60}s`:`${s}s`}
const TERMINAL_STATES=["completed","failed","cancelled"];
function elapsed(t){if(t.status==="whitelisting"&&t.whitelistStart)return"WL "+fmtSec((Date.now()-t.whitelistStart)/1000);if(t.apiCreatedAt){const end=t.apiUpdatedAt||Math.floor(Date.now()/1000);return fmtSec(end-t.apiCreatedAt)}const start=t.startTime||t.created;return fmtSec(((t.endTime||Date.now())-start)/1000)}

function renderTaskInput(t) {
  if (!t.input) return '';
  const inp = t.input;
  let h = `<div class="task-input" onclick="restoreInput('${escJs(t.id||'')}')">`;
  h += `<div class="task-input-header"><span style="font-size:10px;color:#c0c4ca;text-transform:uppercase;letter-spacing:.3px">Input</span><span class="task-input-reuse"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 105.64-11.36L1 10"/></svg> Re-use</span></div>`;
  if (inp.prompt) {
    const media = inp.mediaItems || [];
    const promptHtml = esc(inp.prompt).replace(/@(Image|Video|Audio)(\d+)/g, (match, type, num) => {
      const mType = type.toLowerCase();
      const idx = parseInt(num);
      let count = 0;
      const item = media.find(m => m.type === mType && ++count === idx);
      const thumb = item ? mentionThumbHtml(mType, item.cosUrl || item.url) : '';
      const c = mType === "image" ? "#3d9be9" : mType === "video" ? "#e67e22" : "#27ae60";
      return `<span style="color:${c};font-weight:500">${thumb}${match}</span>`;
    });
    h += `<div class="task-input-prompt">${promptHtml}</div>`;
  }
  // Thumbnails
  const thumbs = [];
  if (inp.refMode === 'keyframes') {
    if (inp.kfFirst) thumbs.push({ type:'image', url:inp.kfFirst.cosUrl||inp.kfFirst.url, label:'First Frame' });
    if (inp.kfLast) thumbs.push({ type:'image', url:inp.kfLast.cosUrl||inp.kfLast.url, label:'Last Frame' });
  } else if (inp.mediaItems && inp.mediaItems.length) {
    for (const m of inp.mediaItems) thumbs.push({ type:m.type, url:m.cosUrl||m.url, label:m.name });
  }
  if (thumbs.length) {
    h += '<div class="task-input-media">';
    for (const th of thumbs) {
      if (!th.url) continue;
      h += '<div class="task-input-thumb">';
      if (th.type === 'video') {
        h += `<video src="${esc(th.url)}" muted preload="metadata" title="${esc(th.label)}"></video>`;
      } else if (th.type === 'image') {
        h += `<img src="${esc(th.url)}" loading="lazy" title="${esc(th.label)}" onerror="this.parentNode.innerHTML='<div class=\\'task-input-thumb-icon\\'>🖼</div>'">`;
      } else {
        h += `<div class="task-input-thumb-icon" title="${esc(th.label)}">🎵</div>`;
      }
      h += '</div>';
    }
    h += '</div>';
  }
  // Tags
  const ml = inp.model === 'seedance-fast' ? 'Fast' : '2.0';
  const rl = inp.refMode === 'keyframes' ? 'Keyframes' : 'Reference';
  h += `<div class="task-input-tags"><span class="task-input-tag">${esc(ml)}</span><span class="task-input-tag">${esc(rl)}</span>${inp.ratio?`<span class="task-input-tag">${esc(inp.ratio)}</span>`:""}<span class="task-input-tag">${inp.duration||""}s</span></div>`;
  return h + '</div>';
}

function restoreInput(taskId) {
  const task = tasks.find(t => t.id === taskId) || Object.values(DEMO_TASKS).find(d => d.id === taskId);
  if (!task || !task.input) return;
  const inp = task.input;

  // Model
  document.getElementById("i-model").value = inp.model || "seedance";
  document.getElementById("model-label").textContent = inp.model === "seedance-fast" ? "Seedance Fast" : "Seedance";
  document.getElementById("chk-seedance").style.display = inp.model === "seedance" ? "" : "none";
  document.getElementById("chk-seedance-fast").style.display = inp.model === "seedance-fast" ? "" : "none";

  // Ratio & Duration (reuse existing functions which also update UI + localStorage)
  selectRatio(inp.ratio || "1:1");
  selectDur(inp.duration || 15);

  // Ref mode
  document.getElementById("i-ref").value = inp.refMode || "all";
  const refLabels = { all:"Reference", keyframes:"Keyframes" };
  document.getElementById("ref-label").textContent = refLabels[inp.refMode] || "Reference";
  document.querySelectorAll("#ref-popup .popup-item").forEach(item => {
    item.classList.toggle("selected", item.dataset.value === inp.refMode);
    item.querySelector(".check").style.display = item.dataset.value === inp.refMode ? "" : "none";
  });
  syncRefMode();

  // Checkboxes
  const se = document.getElementById("i-search");
  if (se) { se.checked = inp.webSearch || false; }
  const wm = document.getElementById("i-wm");
  if (wm) { wm.checked = inp.watermark || false; }
  syncPrefs();

  // Clear existing media
  for (const m of mediaItems) {
    if (m.thumbUrl && m.thumbUrl.startsWith("blob:")) URL.revokeObjectURL(m.thumbUrl);
  }
  mediaItems.length = 0;
  if (kfFirst && kfFirst.thumbUrl && kfFirst.thumbUrl.startsWith("blob:")) URL.revokeObjectURL(kfFirst.thumbUrl);
  if (kfLast && kfLast.thumbUrl && kfLast.thumbUrl.startsWith("blob:")) URL.revokeObjectURL(kfLast.thumbUrl);
  kfFirst = null;
  kfLast = null;

  // Restore media
  if (inp.refMode === "all" && inp.mediaItems) {
    for (const m of inp.mediaItems) {
      mediaItems.push({
        id: ++mediaIdCounter,
        type: m.type,
        url: m.url,
        thumbUrl: m.cosUrl || m.url,
        cosUrl: m.cosUrl || "",
        name: m.name,
        file: null
      });
    }
  }
  renderStack();

  // Restore keyframes
  if (inp.refMode === "keyframes") {
    if (inp.kfFirst) {
      kfFirst = { url: inp.kfFirst.url, thumbUrl: inp.kfFirst.cosUrl || inp.kfFirst.url, cosUrl: inp.kfFirst.cosUrl || "", name: inp.kfFirst.name, file: null };
      renderKfCard("first");
    }
    if (inp.kfLast) {
      kfLast = { url: inp.kfLast.url, thumbUrl: inp.kfLast.cosUrl || inp.kfLast.url, cosUrl: inp.kfLast.cosUrl || "", name: inp.kfLast.name, file: null };
      renderKfCard("last");
    }
  }

  // Prompt (after media restored so thumbnails resolve)
  setPromptText(inp.prompt || "");

  // Scroll to compose box
  document.getElementById("compose-box").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderOneTask(t) {
  const SL = {submitting:"Submitting",whitelisting:"Whitelisting",submitted:"Queued",processing:"Generating",running:"Generating",completed:"Done",failed:"Failed",cancelled:"Cancelled"};
  // Safety net: if we have a videoUrl, always show as completed regardless of stored status
  if (t.videoUrl && t.status !== "completed") { t.status = "completed"; t.progress = null; }
  const isLive = t.status === "submitting" || t.status === "whitelisting";
  const liveIcon = isLive ? `<span style="display:inline-block;width:8px;height:8px;border:1.5px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:3px"></span>` : "";
  const key = t.id || ("_" + t.created);
  const demoBadge = t.demo ? `<span style="font-size:10px;font-weight:500;color:#3d9be9;background:#eef6ff;padding:2px 7px;border-radius:10px">Tutorial</span>` : "";
  const removeBtn = t.demo
    ? `<button class="task-remove" onclick="dismissDemo('${escJs(t.id)}')" title="Remove">×</button>`
    : `<button class="task-remove" onclick="removeTask('${escJs(key)}')" title="Remove">×</button>`;
  const tidHtml = t.id ? `<span class="tid">${t.id}</span>` : "";
  const errorInline = (t.status === "failed" && t.error) ? `<span style="font-size:11px;color:#cf222e;font-weight:500">${esc(t.error)}</span>` : "";
  let h = `<div class="task" id="task-${key}">`;
  h += `<div class="task-header"><div class="task-header-left">${demoBadge}<span class="st ${t.status}">${liveIcon}${SL[t.status]||t.status}</span>${tidHtml}${errorInline}${t.progress?`<span style="font-size:10px;color:#0969da">${t.progress}</span>`:""}</div>`;
  h += `<div class="task-header-right">${t.demo?"":`<span class="task-elapsed" data-elapsed="${key}">${elapsed(t)}</span>`}${removeBtn}</div></div>`;
  h += `<div class="task-body">`;
  h += renderTaskInput(t);
  if (t.videoUrl) {
    h += `<video class="task-video" src="${esc(t.videoUrl)}" controls preload="none"></video>`;
    if (!t.demo) h += `<div class="task-actions"><input type="text" value="${esc(t.videoUrl)}" readonly onclick="this.select()"><button onclick="navigator.clipboard.writeText('${escJs(t.videoUrl)}')">Copy</button><a href="${esc(t.videoUrl)}" target="_blank" download class="s">Save</a></div>`;
  }
  const detailsOpen = t.status === "failed" ? " open" : "";
  if (!t.demo) h += `<details class="task-json"${detailsOpen}><summary>Response</summary><div class="rj">${esc(JSON.stringify(t.response,null,2))}</div></details>`;
  h += `</div></div>`;
  return h;
}

// Incremental render: only the cards whose signature changed get re-rendered.
// Cuts DOM churn during 6s polling — the running <video> elements aren't recreated.
// _renderedTasks is declared at the top of the file (init IIFE calls renderTasks before this point).
function _taskKey(t) { return t.id || ("_" + t.created); }
function _taskSig(t) {
  return [t.id||"", t.status||"", t.progress||"", t.videoUrl||"", t.error||"", t.apiUpdatedAt||"", t.demo?1:0].join("|");
}
function _renderOneTaskNode(t) {
  const tpl = document.createElement("template");
  tpl.innerHTML = renderOneTask(t).trim();
  return tpl.content.firstChild;
}
function renderTasks() {
  const c = document.getElementById("tasks");
  const mode = document.getElementById("i-ref").value === "keyframes" ? "keyframes" : "all";
  const demo = DEMO_TASKS[mode];
  const dismissed = JSON.parse(localStorage.getItem("dismissedDemos") || "[]");
  const list = [...tasks];
  if (demo && !dismissed.includes(demo.id)) list.push(demo);

  if (!list.length) {
    _renderedTasks.clear();
    c.innerHTML = '<p class="empty">No tasks yet</p>';
    return;
  }

  // Drop the placeholder if it's still there
  const placeholder = c.querySelector(".empty");
  if (placeholder) placeholder.remove();

  const wantedKeys = new Set();
  let prevNode = null;
  for (const t of list) {
    const key = _taskKey(t);
    wantedKeys.add(key);
    const sig = _taskSig(t);
    const cached = _renderedTasks.get(key);
    let node;
    if (!cached) {
      node = _renderOneTaskNode(t);
      _renderedTasks.set(key, { sig, node });
    } else if (cached.sig !== sig) {
      const fresh = _renderOneTaskNode(t);
      cached.node.replaceWith(fresh);
      cached.node = fresh;
      cached.sig = sig;
      node = fresh;
    } else {
      node = cached.node;
    }
    // Re-anchor in case order changed (rare: tasks usually only get appended/removed)
    const expectedAfter = prevNode ? prevNode.nextSibling : c.firstChild;
    if (node !== expectedAfter) {
      c.insertBefore(node, expectedAfter);
    }
    prevNode = node;
  }

  // Remove cards whose tasks were deleted/dismissed
  for (const [key, entry] of _renderedTasks) {
    if (!wantedKeys.has(key)) {
      entry.node.remove();
      _renderedTasks.delete(key);
    }
  }
}

function dismissDemo(id) {
  const dismissed = JSON.parse(localStorage.getItem("dismissedDemos") || "[]");
  if (!dismissed.includes(id)) dismissed.push(id);
  localStorage.setItem("dismissedDemos", JSON.stringify(dismissed));
  renderTasks();
}

function removeTask(key) {
  const idx = tasks.findIndex(t => (t.id || ("_" + t.created)) === key);
  if (idx < 0) return;
  tasks.splice(idx, 1);
  saveTasks();
  renderTasks();
}
function clearTasks(){if(!confirm("Clear all task history?"))return;tasks.length=0;saveTasks();renderTasks()}
function friendlyError(msg) {
  if (!msg) return "生成失败，请重试";
  if (msg === "Cancelled by user" || msg === "已取消重新加白") return "已取消";
  if (msg.includes("Unexpected end of JSON input") || msg.includes("empty response body")) return "服务返回空响应，请稍后重试";
  if (msg.includes("timeout") || msg.includes("Timeout")) return "服务繁忙，请稍后重试";
  if (msg.includes("resolve asset")) return "素材处理中，请稍后重试";
  if (msg.includes("ASSET_SYNC_PENDING")) return "素材已加白但上游暂未同步，请稍后重试";
  if (msg.includes("invalid url scheme")) return "素材已加白但上游暂未同步，请稍后重试";
  if (msg.includes("image_url")) return "图片处理异常，请重新上传图片后重试";
  if (msg.includes("SensitiveContent") || msg.includes("PrivacyInformation")) return "图片内容不符合规范，请更换图片";
  if (msg.includes("content moderation")) return "内容审核未通过，请调整提示词或素材";
  if (msg.includes("rate limit") || msg.includes("RateLimit")) return "请求过于频繁，请稍后重试";
  if (msg.includes("401") || msg.includes("Unauthorized")) return "API Key 无效，请检查设置";
  if (msg.includes("NetworkError") || msg.includes("Failed to fetch")) return "网络连接失败，请检查网络";
  // Truncate long technical messages
  if (msg.length > 80) return "生成失败：" + msg.slice(0, 60) + "...";
  return "生成失败：" + msg;
}
function esc(s){const d=document.createElement("div");d.textContent=s==null?"":s;return d.innerHTML}
function escJs(s){return (s==null?"":String(s)).replace(/\\/g,"\\\\").replace(/'/g,"\\'").replace(/"/g,'\\"')}

// ── Recover unrecoverable assets (modal + bulk re-whitelist) ──
let _recoverModalResolve = null;

// Look up storage info for an asset:// URL by walking the task input snapshot
// (mediaItems / kfFirst / kfLast). Falls back to assetLibrary if needed.
function lookupAssetByAssetUrl(assetUrl, snap) {
  const pools = [];
  if (snap?.mediaItems) pools.push(...snap.mediaItems);
  if (snap?.kfFirst) pools.push(snap.kfFirst);
  if (snap?.kfLast) pools.push(snap.kfLast);
  for (const m of pools) {
    if (m && m.assetUrl === assetUrl) {
      const cosUrl = m.cosUrl || m.url;
      if (cosUrl && (cosUrl.startsWith("https://") || cosUrl.startsWith("http://"))) {
        return { cosUrl, name: m.name || "", type: m.type || "image", contentHash: m.contentHash || "" };
      }
    }
  }
  for (const m of (typeof assetLibrary !== "undefined" ? assetLibrary : [])) {
    if (m.assetUrl === assetUrl || m.asset_id === assetUrl) {
      const cosUrl = m.cosUrl || m.storage_url || m.url;
      if (cosUrl && (cosUrl.startsWith("https://") || cosUrl.startsWith("http://"))) {
        return { cosUrl, name: m.name || "", type: m.type || "image", contentHash: m.contentHash || "" };
      }
    }
  }
  return null;
}

// Show the recover-modal and resolve to true (confirm) / false (cancel).
function openRecoverModal(rows) {
  return new Promise((resolve) => {
    _recoverModalResolve = resolve;
    const list = document.getElementById("recover-modal-list");
    const confirmBtn = document.getElementById("recover-modal-confirm");
    const recoverable = rows.filter(r => r.cosUrl);
    list.innerHTML = rows.map(r => {
      const ok = !!r.cosUrl;
      const icon = ok ? "🔄" : "⚠";
      const label = ok ? esc(r.name || r.assetId) : `${esc(r.name || r.assetId)} (no local copy — please re-upload from Assets)`;
      return `<div style="display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid #f5f5f5"><span>${icon}</span><span style="flex:1;${ok ? "" : "color:#c00"}">${label}</span></div>`;
    }).join("");
    confirmBtn.disabled = recoverable.length === 0;
    confirmBtn.textContent = recoverable.length === rows.length
      ? "Re-upload & Continue"
      : `Re-upload ${recoverable.length}/${rows.length} & Continue`;
    document.getElementById("recover-modal-ov").style.display = "flex";
  });
}
function closeRecoverModal() {
  document.getElementById("recover-modal-ov").style.display = "none";
  if (_recoverModalResolve) { _recoverModalResolve(false); _recoverModalResolve = null; }
}
function confirmRecoverAssets() {
  document.getElementById("recover-modal-ov").style.display = "none";
  if (_recoverModalResolve) { _recoverModalResolve(true); _recoverModalResolve = null; }
}
window.closeRecoverModal = closeRecoverModal;
window.confirmRecoverAssets = confirmRecoverAssets;

// Returns a new body with rewritten asset:// URLs, or null if user cancelled
// or no asset could be recovered.
async function recoverUnrecoverableAssets(currentBody, assetIds, task) {
  const snap = task?.input || {};
  const rows = assetIds.map(assetId => {
    const info = lookupAssetByAssetUrl(assetId, snap);
    return { assetId, cosUrl: info?.cosUrl || "", name: info?.name || "", type: info?.type || "image", contentHash: info?.contentHash || "" };
  });
  const ok = await openRecoverModal(rows);
  if (!ok) return null;
  const recoverable = rows.filter(r => r.cosUrl);
  if (recoverable.length === 0) return null;
  task.status = "whitelisting";
  task.whitelistStart = Date.now();
  renderTasks();
  try {
    const storageUrls = recoverable.map(r => r.cosUrl);
    const items = recoverable.map(r => ({ url: r.cosUrl, contentHash: r.contentHash, name: r.name, type: r.type }));
    const resp = await fetch("/api/assets/bulk-whitelist", {
      method: "POST", headers: assetHeaders(),
      body: JSON.stringify({ storageUrls, items, forceRecreate: storageUrls }),
    });
    const { results, errors: wlErrors } = await readJsonResponse(resp);
    const oldToNew = {};
    for (const r of recoverable) {
      const newAssetUrl = results?.[r.cosUrl];
      // Skip if upstream returned the SAME stale asset_id we're trying to replace.
      if (!newAssetUrl || newAssetUrl === r.assetId) continue;
      oldToNew[r.assetId] = newAssetUrl;
      const item = mediaItems.find(m => m.assetUrl === r.assetId);
      if (item) item.assetUrl = newAssetUrl;
      if (kfFirst && kfFirst.assetUrl === r.assetId) kfFirst.assetUrl = newAssetUrl;
      if (kfLast && kfLast.assetUrl === r.assetId) kfLast.assetUrl = newAssetUrl;
    }
    const firstErr = Object.values(wlErrors || {})[0];
    if (firstErr) showToast({ type: "warn", title: "Some assets failed to whitelist", desc: firstErr, duration: 5000 });
    if (Object.keys(oldToNew).length === 0) return null;
    const swapUrl = (c, key) => oldToNew[c[key]?.url]
      ? { ...c, [key]: { ...c[key], url: oldToNew[c[key].url] } }
      : c;
    const newBody = {
      ...currentBody,
      content: currentBody.content.map(c => {
        if (c.type === "image_url") return swapUrl(c, "image_url");
        if (c.type === "video_url") return swapUrl(c, "video_url");
        if (c.type === "audio_url") return swapUrl(c, "audio_url");
        return c;
      }),
    };
    loadAssetLibrary();
    return newBody;
  } catch (e) {
    console.warn("[Recover] bulk-whitelist failed:", e.message);
    showToast({ type: "warn", title: "Re-upload failed", desc: e.message, duration: 5000 });
    return null;
  }
}

// Elapsed-time ticker — only running while tab is visible
// _elapsedTimer is declared at the top of the file.
function tickElapsed() {
  document.querySelectorAll("[data-elapsed]").forEach(el => {
    const key = el.dataset.elapsed;
    const task = tasks.find(t => (t.id || ("_" + t.created)) === key);
    if (task && !TERMINAL_STATES.includes(task.status)) el.textContent = elapsed(task);
  });
}
function startElapsedTimer() {
  if (_elapsedTimer || document.hidden) return;
  _elapsedTimer = setInterval(tickElapsed, 1000);
}
function stopElapsedTimer() {
  if (!_elapsedTimer) return;
  clearInterval(_elapsedTimer);
  _elapsedTimer = null;
}
startElapsedTimer();

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
    stopElapsedTimer();
  } else {
    startElapsedTimer();
    tickElapsed();
    if (hasRunningTasks()) startPolling();
  }
});

// ── Asset Library (Panel) ──
let assetLibrary = [];
let _assetLoading = false;

function assetHeaders() {
  return apiHeaders();
}

// ── Toast notifications ──
function showToast({ title, desc, type = "info", duration = 3500 }) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  const icons = { info: "ℹ", success: "✓", warn: "!" };
  el.innerHTML = `
    <span class="toast-icon ${type}">${icons[type] || icons.info}</span>
    <div class="toast-body">
      <div class="toast-title">${esc(title || "")}</div>
      ${desc ? `<div class="toast-desc">${esc(desc)}</div>` : ""}
    </div>
    <button class="toast-close" type="button">×</button>
  `;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  const close = () => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  };
  el.querySelector(".toast-close").addEventListener("click", close);
  if (duration > 0) setTimeout(close, duration);
}

// Extract first frame of a video file as a PNG blob URL
function extractVideoThumbnail(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    video.src = url;
    const cleanup = () => URL.revokeObjectURL(url);
    video.onerror = () => { cleanup(); resolve(null); };
    video.onloadeddata = () => {
      video.currentTime = 0;
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0);
        canvas.toBlob((blob) => {
          cleanup();
          resolve(blob ? URL.createObjectURL(blob) : null);
        }, "image/jpeg", 0.8);
      } catch { cleanup(); resolve(null); }
    };
  });
}

// Compute SHA-256 hex of a File/Blob
async function sha256Hex(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function lookupAssetByHash(hash) {
  const key = document.getElementById("i-key").value.trim();
  if (!key) return null;
  try {
    const r = await fetch(`/api/assets/by-hash/${hash}`, { headers: uploadHeaders() });
    if (!r.ok) return null;
    const data = await r.json();
    return data.asset || null;
  } catch { return null; }
}

async function uploadAssetWithHash(file, onProgress, options = {}) {
  const hash = await sha256Hex(file);
  if (options.dedupe !== false) {
    const existing = await lookupAssetByHash(hash);
    if (existing && existing.storage_url) {
      const statusDesc = existing.asset_status === "ready"
        ? "Reused asset (whitelisted)"
        : "Reused asset";
      showToast({
        type: "success",
        title: statusDesc,
        desc: file.name || existing.name || "",
      });
      return { fileUrl: existing.storage_url, hash, reused: true, asset: existing };
    }
  }
  const ext = ((file.name || "file").split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
  const clientKey = `assets/${hash}.${ext || "bin"}`;
  const presignResp = await fetch("/api/cos/presign", {
    method: "POST",
    headers: { ...uploadHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name || `${hash}.${ext || "bin"}`,
      contentType: file.type || "application/octet-stream",
      prefix: "assets",
      key: clientKey,
    }),
  });
  if (!presignResp.ok) throw new Error("Failed to get upload URL");
  const presign = await presignResp.json();
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", presign.uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("Upload failed: " + xhr.status));
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(file);
  });
  return { fileUrl: presign.fileUrl, hash, reused: false };
}

function toggleAssetPanel(pillEl) {
  const panel = document.getElementById("asset-panel");
  const compose = document.getElementById("compose-box");
  const isOpen = panel.classList.contains("open");
  if (isOpen) {
    panel.classList.remove("open");
    compose.classList.remove("asset-open");
    if (pillEl) pillEl.classList.remove("active");
    return;
  }
  if (!requireApiKey(() => toggleAssetPanel(pillEl))) return;
  panel.classList.add("open");
  compose.classList.add("asset-open");
  if (pillEl) pillEl.classList.add("active");
  loadAssetLibrary();
}

async function loadAssetLibrary() {
  const key = document.getElementById("i-key").value.trim();
  if (!key) { assetLibrary = []; renderAssetGrid(); return; }
  if (_assetLoading) return;
  _assetLoading = true;
  try {
    const resp = await fetch("/api/assets", { headers: assetHeaders() });
    if (resp.ok) {
      const data = await readJsonResponse(resp);
      assetLibrary = data.assets || [];
    }
  } catch (e) {
    console.warn("[AssetLib] Load failed:", e.message);
  } finally {
    _assetLoading = false;
    renderAssetGrid();
  }
}

// Look up an already-whitelisted asset_id for a given storage URL.
function lookupAssetUrl(storageUrl) {
  if (!storageUrl) return "";
  const hit = assetLibrary.find(a => a.storage_url === storageUrl && a.asset_status === "ready" && a.asset_id);
  return hit ? hit.asset_id : "";
}

// Before submitting, reconcile in-memory media with the asset library so any item that's
// ALREADY been whitelisted goes out as asset:// on the FIRST try.
// Seedance hard requirement: any media that goes through generate as a raw cosUrl
// is rejected by the upstream privacy/sensitive-content guard. So if we still
// have items without an asset:// after the lookup pass, we proactively bulk-
// whitelist them here — the generate call should NEVER see a cosUrl for image/
// video items if we can avoid it.
async function reconcileAssetUrls() {
  if (assetLibrary.length === 0) {
    await loadAssetLibrary();
  }
  // Pass 1: cheap lookup — pick up any asset_id that's already ready upstream.
  for (const item of mediaItems) {
    if (!item.assetUrl) {
      const found = lookupAssetUrl(item.cosUrl || item.url);
      if (found) { item.assetUrl = found; item.assetStatus = "ready"; }
    }
  }
  if (kfFirst && !kfFirst.assetUrl) {
    const found = lookupAssetUrl(kfFirst.cosUrl || kfFirst.url);
    if (found) { kfFirst.assetUrl = found; kfFirst.assetStatus = "ready"; }
  }
  if (kfLast && !kfLast.assetUrl) {
    const found = lookupAssetUrl(kfLast.cosUrl || kfLast.url);
    if (found) { kfLast.assetUrl = found; kfLast.assetStatus = "ready"; }
  }

  // Pass 2: proactively whitelist anything still on a cosUrl, including audio.
  // Audio must go through volc-asset-audio before mixed media generation.
  const refMode = document.getElementById("i-ref")?.value || "all";
  const targets = [];
  const collect = (item) => {
    if (!item) return;
    if (item.assetUrl) return;
    if (item.assetStatus === "pending") return;
    const url = item.cosUrl || item.url;
    if (!url || !url.startsWith("https://")) return;
    targets.push({ item, url });
  };
  if (refMode === "keyframes") {
    collect(kfFirst);
    collect(kfLast);
  } else {
    for (const m of mediaItems) collect(m);
  }
  if (targets.length === 0) return;

  try {
    const seen = new Set();
    const unique = targets.filter(t => seen.has(t.url) ? false : (seen.add(t.url), true));
    const storageUrls = unique.map(t => t.url);
    const items = unique.map(t => ({
      url: t.url,
      contentHash: t.item.contentHash || "",
      name: t.item.name || "",
      type: t.item.type || "image",
    }));
    const resp = await fetch("/api/assets/bulk-whitelist", {
      method: "POST", headers: assetHeaders(),
      body: JSON.stringify({ storageUrls, items }),
    });
    if (!resp.ok) {
      console.warn("[Reconcile] bulk-whitelist HTTP", resp.status);
      return;
    }
    const { results, errors } = await readJsonResponse(resp);
    if (!results) return;
    for (const t of targets) {
      const assetUrl = results[t.url];
      if (assetUrl) {
        t.item.assetUrl = assetUrl;
        t.item.assetStatus = "ready";
      } else if (errors?.[t.url]) {
        t.item.assetStatus = "failed";
      }
    }
    loadAssetLibrary();
  } catch (e) {
    console.warn("[Reconcile] proactive whitelist failed:", e.message);
  }
}

function renderAssetGrid() {
  const el = document.getElementById("asset-grid");
  if (!el) return;
  if (assetLibrary.length === 0) {
    el.innerHTML = '<div class="asset-empty">Click Upload to add assets<br>Asset library is independent from input</div>';
    return;
  }
  const statusLabel = { ready: "Ready", pending: "Pending...", failed: "Failed", none: "Not whitelisted", uploading: "Uploading..." };
  el.innerHTML = assetLibrary.map(a => {
    const isUploading = a.asset_status === "uploading";
    // Uploading placeholders use local blob; saved assets always use storage_url
    const thumbSrc = isUploading ? a.thumb_url : (a.thumb_url || a.storage_url);
    // For saved videos always hit the server thumb endpoint — it 302s to the real
    // thumbnail (generating one on first miss) and filters out legacy rows where
    // thumb_url accidentally points at the video itself.
    // The thumb_token is a short-lived HMAC signature server-side issues per list call.
    const videoThumbSrc = isUploading
      ? thumbSrc
      : `/api/assets/${a.id}/thumb?t=${encodeURIComponent(a.thumb_token || "")}`;
    const thumb = a.type === "audio"
      ? `<div class="asset-card-icon">🎵</div>`
      : a.type === "video"
        ? `<img src="${esc(videoThumbSrc)}" loading="lazy">`
        : `<img src="${esc(thumbSrc)}" loading="lazy">`;
    const canWl = !isUploading && (a.asset_status === "none" || a.asset_status === "failed");
    const wlOverlay = canWl
      ? `<div class="asset-card-wl show"><button onclick="event.stopPropagation();whitelistAsset(${a.id})">Whitelist</button></div>` : '';
    const progressBar = isUploading
      ? `<div class="asset-card-progress"><div class="asset-card-progress-bar" id="prog-${a.id}" style="width:${a._progress || 0}%"></div></div>` : '';
    const clickAttr = isUploading ? '' : `onclick="insertSavedAsset(${a.id})"`;
    const dragAttrs = isUploading ? '' : `draggable="true" ondragstart="onAssetDragStart(event, ${a.id})"`;
    const removeBtn = isUploading ? '' : `<button class="asset-card-remove" onclick="event.stopPropagation();deleteLibraryAsset(${a.id})">✕</button>`;
    return `<div class="asset-card${isUploading ? ' uploading' : ''}" ${clickAttr} ${dragAttrs} title="${esc(a.name || 'Asset')}">
      ${thumb}
      <span class="asset-card-status ${a.asset_status}">${statusLabel[a.asset_status]}</span>
      ${removeBtn}
      <div class="asset-card-name">${esc(a.name || "Asset")}</div>
      ${wlOverlay}
      ${progressBar}
    </div>`;
  }).join("");
}

function onAssetDragStart(e, id) {
  e.dataTransfer.setData("application/x-asset-id", String(id));
  e.dataTransfer.effectAllowed = "copy";
}

async function handleAssetUpload(files) {
  if (!files || !files.length) return;
  const key = document.getElementById("i-key").value.trim();
  if (!key) {
    const cached = Array.from(files);
    showKeyModal(() => handleAssetUpload(cached));
    return;
  }
  const fileList = Array.from(files);
  setTimeout(() => { const el = document.getElementById("asset-file-input"); if (el) el.value = ""; }, 0);
  for (const file of fileList) {
    const type = file.type.startsWith("video") ? "video" : file.type.startsWith("audio") ? "audio" : "image";
    const placeholderId = "_up_" + Date.now() + Math.random().toString(36).slice(2, 6);
    const localUrl = URL.createObjectURL(file);
    const placeholder = { id: placeholderId, name: file.name, type, storage_url: localUrl, thumb_url: localUrl, asset_status: "uploading", _progress: 0 };
    assetLibrary.unshift(placeholder);
    renderAssetGrid();
    try {
      const { fileUrl, hash, reused, asset } = await uploadAssetWithHash(file, (pct) => {
        const bar = document.getElementById("prog-" + placeholderId);
        if (bar) bar.style.width = pct + "%";
        placeholder._progress = pct;
      });
      if (reused && asset) {
        const idx = assetLibrary.findIndex(a => a.id === placeholderId);
        if (idx >= 0) assetLibrary.splice(idx, 1);
        const existingIdx = assetLibrary.findIndex(a => a.id === asset.id);
        if (existingIdx >= 0) assetLibrary.splice(existingIdx, 1);
        assetLibrary.unshift(asset);
      } else {
        const regResp = await fetch("/api/assets", {
          method: "POST", headers: assetHeaders(),
          body: JSON.stringify({ name: file.name, type, storageUrl: fileUrl, contentHash: hash }),
        });
        const idx = assetLibrary.findIndex(a => a.id === placeholderId);
        if (regResp.ok) {
          const data = await regResp.json();
          if (data.asset && idx >= 0) assetLibrary[idx] = data.asset;
          else if (data.asset) assetLibrary.unshift(data.asset);
        } else {
          const errText = await regResp.text();
          throw new Error("Register failed: " + errText);
        }
        if (idx >= 0 && assetLibrary[idx].id === placeholderId) assetLibrary.splice(idx, 1);
      }
    } catch (e) {
      console.warn("[AssetLib] Upload failed:", file.name, e.message);
      const idx = assetLibrary.findIndex(a => a.id === placeholderId);
      if (idx >= 0) assetLibrary.splice(idx, 1);
      alert("Upload failed: " + file.name + " — " + e.message);
    } finally {
      URL.revokeObjectURL(localUrl);
    }
    renderAssetGrid();
  }
}

// ── Asset panel drag & drop ──
(function() {
  const panel = document.getElementById("asset-panel");
  let dragCounter = 0;
  panel.addEventListener("dragenter", (e) => { e.preventDefault(); dragCounter++; panel.classList.add("drag-over"); });
  panel.addEventListener("dragleave", (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; panel.classList.remove("drag-over"); } });
  panel.addEventListener("dragover", (e) => e.preventDefault());
  panel.addEventListener("drop", (e) => {
    e.preventDefault(); dragCounter = 0; panel.classList.remove("drag-over");
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith("image/") || f.type.startsWith("video/") || f.type.startsWith("audio/"));
    if (files.length) handleAssetUpload(files);
  });
})();

async function whitelistAsset(id) {
  const a = assetLibrary.find(x => x.id === id);
  if (!a) return;
  a.asset_status = "pending";
  renderAssetGrid();
  try {
    const resp = await fetch(`/api/assets/${id}/whitelist`, { method: "POST", headers: assetHeaders() });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = data.error || `HTTP ${resp.status}`;
      a.asset_status = "failed";
      renderAssetGrid();
      showToast({ type: "warn", title: "素材加白失败", desc: msg, duration: 4000 });
      return;
    }
    if (data.asset) {
      const idx = assetLibrary.findIndex(x => x.id === id);
      if (idx >= 0) assetLibrary[idx] = data.asset;
      const item = mediaItems.find(m => (m.cosUrl || m.url) === data.asset.storage_url);
      if (item && data.asset.asset_id) item.assetUrl = data.asset.asset_id;
      renderAssetGrid();
    }
    if (data.error) {
      const msg = data.error;
      const isQuota = msg.includes("额度不足") || msg.includes("quota") || msg.includes("insufficient") || msg.includes("balance");
      showToast({
        type: "warn",
        title: isQuota ? "账户余额不足" : "素材加白失败",
        desc: isQuota ? "请前往 AnyFast 充值后重试" : msg,
        duration: 5000,
      });
    }
  } catch (e) {
    console.warn("[AssetLib] Whitelist failed:", e.message);
    a.asset_status = "failed";
    renderAssetGrid();
    showToast({ type: "warn", title: "素材加白失败", desc: e.message, duration: 4000 });
  }
  renderAssetGrid();
}

async function deleteLibraryAsset(id) {
  try {
    await fetch(`/api/assets/${id}`, { method: "DELETE", headers: assetHeaders() });
    assetLibrary = assetLibrary.filter(a => a.id !== id);
    renderAssetGrid();
  } catch (e) { console.warn("[AssetLib] Delete failed:", e.message); }
}

function insertSavedAsset(id) {
  const a = assetLibrary.find(x => x.id === id);
  if (!a) return;
  // Check if already in mediaItems
  let existing = mediaItems.find(m => (m.cosUrl || m.url) === a.storage_url);
  if (!existing) {
    const newItem = {
      id: Date.now(),
      type: a.type || "image",
      url: a.storage_url,
      file: null,
      thumbUrl: a.thumb_url || a.storage_url,
      name: a.name || "Asset",
      cosUrl: a.storage_url,
      assetUrl: a.asset_id || null,
      assetStatus: a.asset_status || "",
    };
    mediaItems.push(newItem);
    renderStack();
    existing = newItem;
  }
  const typeLabel = existing.type === "image" ? "Image" : existing.type === "video" ? "Video" : "Audio";
  let count = 0;
  for (const m of mediaItems) {
    if (m.type === existing.type) count++;
    if (m === existing) break;
  }
  insertMention(typeLabel + count);
}

async function registerAssetOnUpload(item) {
  const key = document.getElementById("i-key").value.trim();
  if (!key) return null;
  const storageUrl = item.cosUrl || item.url;
  if (!storageUrl || !storageUrl.startsWith("https://")) return null;
  try {
    const resp = await fetch("/api/assets", {
      method: "POST",
      headers: assetHeaders(),
      body: JSON.stringify({
        name: item.name || "",
        type: item.type || "image",
        storageUrl,
        thumbUrl: item.persistedThumbUrl || "",
        contentHash: item.contentHash || "",
      }),
    });
    if (resp.ok) {
      const data = await readJsonResponse(resp);
      if (data.asset) {
        if (data.asset.asset_id && data.asset.asset_status === "ready") {
          item.assetUrl = data.asset.asset_id;
        }
        item.assetStatus = data.asset.asset_status || "";
        const idx = assetLibrary.findIndex(a => a.id === data.asset.id);
        if (idx >= 0) assetLibrary[idx] = data.asset;
        else assetLibrary.unshift(data.asset);
        renderAssetGrid();
        syncPrefs();
        return data.asset;
      }
    }
  } catch (e) { console.warn("[AssetLib] Register failed:", e.message); }
  return null;
}

function toggleAbout() {
  const sec = document.getElementById("about-modal");
  const btn = document.getElementById("about-toggle");
  const open = sec.style.display === "none";
  sec.style.display = open ? "flex" : "none";
  btn.textContent = open ? "About ▴" : "About ▾";
}

let _afterKeyCallback = null;
function showKeyModal(callback) {
  _afterKeyCallback = typeof callback === "function" ? callback : null;
  document.getElementById("key-modal-ov").style.display = "flex";
  setTimeout(() => document.getElementById("modal-key-input").focus(), 50);
}
function closeKeyModal() {
  document.getElementById("key-modal-ov").style.display = "none";
  document.getElementById("modal-key-input").value = "";
  _afterKeyCallback = null;
}
function saveKeyAndGenerate() {
  const key = document.getElementById("modal-key-input").value.trim();
  if (!key) { document.getElementById("modal-key-input").focus(); return; }
  document.getElementById("i-key").value = key;
  localStorage.setItem("apiKey", key);
  const cb = _afterKeyCallback;
  closeKeyModal();
  if (cb) cb(); else generate();
}

function requireApiKey(callback) {
  const key = document.getElementById("i-key").value.trim();
  if (key) return true;
  showKeyModal(callback);
  return false;
}
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && document.getElementById("key-modal-ov").style.display === "flex") closeKeyModal();
});

// ── Auto-reload on new deploy ──
// Pull our own bundle hash off the <script src="...?v=HASH"> tag the server
// rendered. When /api/version reports a different hash, the server has been
// redeployed; reload so the user runs the new code (otherwise old tabs keep
// hitting bugs we already fixed). We hold off reloading while a generation is
// in flight so we don't drop the user's work.
const _selfJsHash = (() => {
  const scripts = document.querySelectorAll('script[src*="/static/app.js"]');
  for (const s of scripts) {
    const m = (s.getAttribute("src") || "").match(/[?&]v=([^&]+)/);
    if (m) return m[1];
  }
  return null;
})();
let _reloadScheduled = false;
async function checkVersion() {
  if (_reloadScheduled || !_selfJsHash) return;
  try {
    const r = await fetch("/api/version", { cache: "no-store" });
    if (!r.ok) return;
    const v = await r.json();
    if (v && typeof v.js === "string" && v.js && v.js !== _selfJsHash) {
      _reloadScheduled = true;
      const tryReload = () => {
        if (hasRunningTasks() || pendingUploads > 0 || document.hidden) {
          setTimeout(tryReload, 5000);
          return;
        }
        console.log(`[Version] new bundle (${v.js}), reloading…`);
        location.reload();
      };
      tryReload();
    }
  } catch { /* offline / network blip — try again next tick */ }
}
setInterval(checkVersion, 60000);
// Don't run the first check immediately on load — give the page time to settle
// and the user a moment to see the UI before any potential reload kicks in.
setTimeout(checkVersion, 30000);
