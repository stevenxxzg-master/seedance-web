import express from "express";
import compression from "compression";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import COS from "cos-nodejs-sdk-v5";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { createReadStream, createWriteStream, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { createRequire } from "module";
import multer from "multer";
import os from "os";
import {
  hashApiKey, listAssets, findAssetByUrl, findAssetByHash, findAssetByAssetId,
  insertAsset, updateAssetStatus, updateAssetThumb, getAssetById,
  upsertAssetIdentity, deleteAsset as dbDeleteAsset, getPrefs, setPrefs,
} from "./db.js";

const require = createRequire(import.meta.url);

const execFileAsync = promisify(execFile);

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(compression());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (origin.includes("anyfast.com.cn") || origin.includes("anyfast.ai"))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Api-Key,X-Api-Base,X-Storage,Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: "50mb" }));

// Static assets are versioned via ?v=<hash> in HTML — safe to cache aggressively.
// express.static defaults to ETag on, which lets unversioned requests still 304.
app.use("/static", express.static(join(__dirname, "static"), {
  maxAge: "365d",
  immutable: true,
  index: false,
}));

// Hash static assets at boot so HTML can reference them with cache-busting query strings.
// Each deploy that changes app.css/app.js produces a new hash → new HTML body → new ETag,
// while unchanged files get hit-or-304 from the long-cache /static/ route.
function fileHash(p) {
  try {
    return crypto.createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 10);
  } catch {
    return "dev";
  }
}
const ASSET_HASHES = {
  "/static/app.css": fileHash(join(__dirname, "static", "app.css")),
  "/static/app.js": fileHash(join(__dirname, "static", "app.js")),
  "/static/app.zh.js": fileHash(join(__dirname, "static", "app.zh.js")),
};

const HTML_CACHE = new Map();
function loadHtml(file) {
  if (HTML_CACHE.has(file)) return HTML_CACHE.get(file);
  const raw = readFileSync(join(__dirname, file), "utf8");
  const out = raw
    .replace(/__CSS_HASH__/g, ASSET_HASHES["/static/app.css"])
    .replace(/__JS_HASH__/g, file.includes("zh") ? ASSET_HASHES["/static/app.zh.js"] : ASSET_HASHES["/static/app.js"]);
  HTML_CACHE.set(file, out);
  return out;
}

// HTML: revalidate every request (must-revalidate) but allow 304 via ETag.
// express.send computes a weak ETag from the body, so unchanged HTML returns 304.
function sendHtml(file) {
  return (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.type("html").send(loadHtml(file));
  };
}
app.get("/", sendHtml("index.html"));
app.get("/zh", sendHtml("index-zh.html"));

const API_BASE = process.env.API_BASE_URL || "https://www.example.com";

function getKey(req) {
  const key = req.headers["x-api-key"];
  if (!key) throw new Error("API Key is required");
  return key;
}

function getBase(req) {
  const raw = req.headers["x-api-base"] || API_BASE;
  const base = decodeURI(raw);
  // Allowlist: only https to public domains
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error("Invalid API base URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Only HTTPS base URLs are allowed");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    host.startsWith("[") ||
    host.startsWith("0x") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    /^\d+$/.test(host)
  ) {
    throw new Error("Invalid API base URL");
  }
  return base;
}

app.post("/api/generate", async (req, res) => {
  try {
    let body = await resolveVisualAssetsForGenerate(req, req.body);
    let { resp, data } = await forwardVideoGeneration(req, body);
    if (!resp.ok) {
      logGenerateFailure(resp, data, body);
      if (!resp.ok && isInvalidUrlSchemeError(data)) {
        const rejected = collectVisualAssetIds(body);
        if (rejected.length) console.warn(`[Generate] re-creating ${rejected.length} visual asset_id(s) after scheme error`);
        const retryBody = await resolveVisualAssetsForGenerate(req, body, { forceAssetUrls: rejected });
        await new Promise((r) => setTimeout(r, 3000));
        ({ resp, data } = await forwardVideoGeneration(req, retryBody));
        if (!resp.ok) {
          logGenerateFailure(resp, data, retryBody, " retry");
          if (isInvalidUrlSchemeError(data)) {
            const finalRejected = collectVisualAssetIds(retryBody);
            const finalBody = await resolveVisualAssetsForGenerate(req, retryBody, { forceAssetUrls: finalRejected });
            await new Promise((r) => setTimeout(r, 12000));
            ({ resp, data } = await forwardVideoGeneration(req, finalBody));
            body = finalBody;
            if (!resp.ok) logGenerateFailure(resp, data, finalBody, " retry-after-wait");
          }
        }
      }
    }
    if (!resp.ok && isInvalidUrlSchemeError(data)) {
      throw assetResolutionError(collectVisualAssetIds(body));
    }
    res.status(resp.status).json(data);
  } catch (err) {
    const status = err.statusCode
      || (err.message === "API Key is required" ? 401 : 502);
    const payload = { error: err.message };
    if (err.code) payload.code = err.code;
    if (err.assetIds) payload.assetIds = err.assetIds;
    res.status(status).json(payload);
  }
});

async function forwardVideoGeneration(req, body) {
  const upstreamBody = normalizeAssetUrlSchemeForUpstream(body);
  rewriteAudioAssetsToHttpForUpstream(req, upstreamBody);
  const resp = await fetch(`${getBase(req)}/v1/video/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getKey(req)}`,
    },
    body: JSON.stringify(upstreamBody),
  });
  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || `Upstream returned HTTP ${resp.status} with an empty response body` };
  }
  return { resp, data };
}

function rewriteAudioAssetsToHttpForUpstream(req, body) {
  for (const c of (body?.content || [])) {
    const slot = c?.audio_url;
    if (!slot || typeof slot.url !== "string" || !isAssetUrl(slot.url)) continue;
    const meta = getAssetRecovery(req, slot.url);
    if (meta?.storageUrl && isHttpUrl(meta.storageUrl)) {
      slot.url = meta.storageUrl;
    }
  }
}

function normalizeAssetUrlSchemeForUpstream(originalBody) {
  const body = JSON.parse(JSON.stringify(originalBody || {}));
  for (const c of (body.content || [])) {
    for (const key of ["image_url", "video_url", "audio_url"]) {
      const slot = c?.[key];
      if (!slot || typeof slot.url !== "string") continue;
      if (isAssetUrl(slot.url)) {
        slot.url = toCanonicalAssetUrl(slot.url);
      }
    }
  }
  return body;
}

function logGenerateFailure(resp, data, body, label = "") {
  const urls = (body.content || []).map((c) => {
    const slot = c.image_url || c.video_url || c.audio_url;
    return slot ? `${c.type}=${slot.url}` : c.type;
  });
  console.warn(`[Generate${label}] upstream ${resp.status} | urls=${JSON.stringify(urls)} | err=${JSON.stringify(data).slice(0, 800)}`);
}

function isInvalidUrlSchemeError(data) {
  return JSON.stringify(data || {}).includes("invalid url scheme");
}

function isPrivacyInformationError(data) {
  return JSON.stringify(data || {}).includes("PrivacyInformation");
}

function collectVisualAssetIds(body) {
  const ids = [];
  for (const c of (body?.content || [])) {
    if (c.type !== "image_url" && c.type !== "video_url") continue;
    const slot = c.image_url || c.video_url;
    const url = slot?.url;
    if (typeof url === "string" && isAssetUrl(url)) ids.push(toCanonicalAssetUrl(url));
  }
  return ids;
}

function assetResolutionError(assetIds) {
  const err = new Error("素材解析失败，请重新上传对应素材后重试");
  err.statusCode = 503;
  err.code = "ASSET_RESOLUTION_FAILED";
  err.assetIds = assetIds;
  return err;
}

function getVisualSlot(contentItem) {
  if (contentItem?.type === "image_url") return { slot: contentItem.image_url, mediaType: "image" };
  if (contentItem?.type === "video_url") return { slot: contentItem.video_url, mediaType: "video" };
  return { slot: null, mediaType: "" };
}

function getAudioSlot(contentItem) {
  return contentItem?.type === "audio_url" ? contentItem.audio_url : null;
}

function cleanClientSlot(slot) {
  if (!slot || typeof slot !== "object") return;
  delete slot._cosUrl;
  delete slot._name;
  delete slot._contentHash;
}

function normalizeForceAssetSet(forceAssetUrls = []) {
  return new Set((forceAssetUrls || [])
    .map((u) => toCanonicalAssetUrl(u))
    .filter(Boolean));
}

function resolveStorageUrlFromSlot(req, slot) {
  if (!slot) return "";
  const direct = typeof slot.url === "string" ? slot.url : "";
  if (isHttpUrl(direct)) return direct;
  const hinted = typeof slot._cosUrl === "string" ? slot._cosUrl : "";
  if (isHttpUrl(hinted)) return hinted;
  if (isAssetUrl(direct)) {
    const meta = getAssetRecovery(req, direct);
    if (meta?.storageUrl && isHttpUrl(meta.storageUrl)) return meta.storageUrl;
  }
  return "";
}

async function resolveVisualAssetFromStorage(req, slot, mediaType, { force = false } = {}) {
  const userHash = getUserHash(req);
  const originalStorageUrl = resolveStorageUrlFromSlot(req, slot);
  if (!isHttpUrl(originalStorageUrl)) {
    const err = new Error("素材缺少可恢复的 URL，请重新上传后重试");
    err.statusCode = 422;
    err.code = "ASSET_STORAGE_MISSING";
    throw err;
  }

  const hintedHash = normalizeContentHash(slot?._contentHash);
  const originalHash = hintedHash || deriveContentHashFromStorageUrl(originalStorageUrl);
  const storageUrl = await mirrorCosAssetToTosIfNeeded(req, originalStorageUrl, originalHash);
  const contentHash = originalHash || deriveContentHashFromStorageUrl(storageUrl);
  const name = (typeof slot?._name === "string" && slot._name) ? slot._name : deriveNameFromUrl(storageUrl);

  let asset = (contentHash ? findAssetByHash(userHash, contentHash) : null)
    || findAssetByUrl(userHash, storageUrl)
    || (storageUrl !== originalStorageUrl ? findAssetByUrl(userHash, originalStorageUrl) : null);

  if (asset && asset.storage_url !== storageUrl) {
    asset = upsertKnownAsset({
      userHash,
      name: asset.name || name,
      type: asset.type || mediaType,
      storageUrl,
      thumbUrl: asset.thumb_url || "",
      contentHash: asset.content_hash || contentHash,
      assetId: "",
      assetStatus: "none",
    }) || asset;
  }

  if (!asset) {
    asset = insertAsset({ userHash, name, type: mediaType, storageUrl, thumbUrl: "", contentHash });
  } else {
    asset = upsertKnownAsset({
      userHash,
      name: asset.name || name,
      type: asset.type || mediaType,
      storageUrl,
      contentHash: asset.content_hash || contentHash,
    }) || asset;
  }

  if (!force && asset.asset_status === "ready" && asset.asset_id) {
    rememberAssetRecovery(asset.asset_id, {
      storageUrl: asset.storage_url || storageUrl,
      name: asset.name || name,
      type: asset.type || mediaType,
      contentHash: asset.content_hash || contentHash,
    });
    return asset.asset_id;
  }

  const result = await whitelistLocalAsset(req, userHash, asset, {
    force,
    name: asset.name || name,
    type: asset.type || mediaType,
  });
  if (result.error) {
    const err = new Error(result.error);
    err.statusCode = 422;
    err.code = "ASSET_WHITELIST_FAILED";
    throw err;
  }
  if (!result.asset?.asset_id) {
    const err = new Error("素材加白未返回 asset_id，请重新上传后重试");
    err.statusCode = 422;
    err.code = "ASSET_ID_MISSING";
    throw err;
  }

  rememberAssetRecovery(result.asset.asset_id, {
    storageUrl: result.asset.storage_url || storageUrl,
    name: result.asset.name || name,
    type: result.asset.type || mediaType,
    contentHash: result.asset.content_hash || contentHash,
  });
  return result.asset.asset_id;
}

async function resolveVisualAssetsForGenerate(req, originalBody, { forceAssetUrls = [] } = {}) {
  const body = JSON.parse(JSON.stringify(originalBody || {}));
  const force = normalizeForceAssetSet(forceAssetUrls);
  const cache = new Map();
  let converted = 0;

  for (const c of (body.content || [])) {
    const { slot, mediaType } = getVisualSlot(c);
    if (slot) {
      const currentAssetUrl = isAssetUrl(slot.url) ? toCanonicalAssetUrl(slot.url) : "";
      const storageUrl = resolveStorageUrlFromSlot(req, slot);
      const cacheKey = `${mediaType}:${normalizeContentHash(slot._contentHash)}:${storageUrl || currentAssetUrl}`;
      let assetUrl = cache.get(cacheKey);
      if (!assetUrl) {
        assetUrl = await resolveVisualAssetFromStorage(req, slot, mediaType, {
          force: currentAssetUrl ? force.has(currentAssetUrl) : false,
        });
        cache.set(cacheKey, assetUrl);
      }
      slot.url = toCanonicalAssetUrl(assetUrl);
      cleanClientSlot(slot);
      converted++;
      continue;
    }

    const audioSlot = getAudioSlot(c);
    if (audioSlot) {
      const storageUrl = resolveStorageUrlFromSlot(req, audioSlot);
      if (storageUrl) audioSlot.url = storageUrl;
      cleanClientSlot(audioSlot);
    }
  }

  if (converted) console.warn(`[Generate] resolved ${converted} visual URL(s) to asset://`);
  return body;
}

function isHttpUrl(url) {
  return typeof url === "string" && (url.startsWith("https://") || url.startsWith("http://"));
}

function isAssetUrl(url) {
  return typeof url === "string" && /^asset:\/\//i.test(url);
}

function assetIdFromUrl(url) {
  return isAssetUrl(url) ? url.slice("asset://".length) : "";
}

function toCanonicalAssetUrl(url) {
  const id = assetIdFromUrl(url);
  return id ? "asset://" + id : "";
}

function normalizeContentHash(contentHash) {
  return typeof contentHash === "string" && /^[a-f0-9]{32,128}$/i.test(contentHash)
    ? contentHash.toLowerCase()
    : "";
}

function deriveContentHashFromStorageUrl(storageUrl) {
  if (!isHttpUrl(storageUrl)) return "";
  try {
    const raw = new URL(storageUrl).pathname.split("/").filter(Boolean).pop() || "";
    const base = decodeURIComponent(raw).split("?")[0].split("#")[0].split(".")[0] || "";
    return normalizeContentHash(base);
  } catch {
    return "";
  }
}

function normalizeAssetMeta(meta) {
  const { userHash, name, type, storageUrl, thumbUrl, contentHash, assetUrl, assetId, assetStatus } = meta;
  const hasAssetId = Object.prototype.hasOwnProperty.call(meta, "assetUrl")
    || Object.prototype.hasOwnProperty.call(meta, "assetId");
  const canonicalAssetUrl = assetUrl ? toCanonicalAssetUrl(assetUrl) : (assetId ? toCanonicalAssetUrl("asset://" + assetId) : "");
  const normalizedHash = normalizeContentHash(contentHash) || deriveContentHashFromStorageUrl(storageUrl);
  return {
    userHash,
    name: name || (storageUrl ? deriveNameFromUrl(storageUrl) : ""),
    type: type || "image",
    storageUrl: isHttpUrl(storageUrl) ? storageUrl : "",
    thumbUrl: thumbUrl || "",
    contentHash: normalizedHash,
    assetId: hasAssetId ? canonicalAssetUrl : undefined,
    assetStatus: assetStatus || (canonicalAssetUrl ? "ready" : ""),
  };
}

function upsertKnownAsset(meta) {
  const normalized = normalizeAssetMeta(meta);
  if (!normalized.userHash || !normalized.storageUrl) return null;
  const row = upsertAssetIdentity(normalized);
  if (row?.asset_id && row?.storage_url) {
    rememberAssetRecovery(row.asset_id, {
      storageUrl: row.storage_url,
      name: row.name || normalized.name,
      type: row.type || normalized.type,
      contentHash: row.content_hash || normalized.contentHash,
    });
  }
  return row;
}

function rememberAssetRecovery(assetUrl, meta) {
  assetUrl = toCanonicalAssetUrl(assetUrl);
  if (!assetUrl) return;
  const storageUrl = meta?.storageUrl || meta?.storage_url || "";
  if (!isHttpUrl(storageUrl)) return;
  _assetRecoveryByAssetUrl.set(assetUrl, {
    storageUrl,
    name: meta.name || "",
    type: meta.type || "image",
    contentHash: meta.contentHash || meta.content_hash || "",
  });
}

function getAssetRecovery(req, assetUrl) {
  assetUrl = toCanonicalAssetUrl(assetUrl);
  const cached = _assetRecoveryByAssetUrl.get(assetUrl);
  if (cached?.storageUrl) return cached;
  try {
    const local = findAssetByAssetId(getUserHash(req), assetUrl);
    if (local?.storage_url) {
      const meta = {
        storageUrl: local.storage_url,
        name: local.name || "",
        type: local.type || "image",
        contentHash: local.content_hash || "",
      };
      rememberAssetRecovery(assetUrl, meta);
      return meta;
    }
  } catch {}
  return null;
}

app.get("/api/status/:id", async (req, res) => {
  try {
    const resp = await fetch(
      `${getBase(req)}/v1/video/generations/${encodeURIComponent(req.params.id)}`,
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${getKey(req)}`,
        },
      }
    );
    const text = await resp.text();
    try {
      res.status(resp.status).json(JSON.parse(text));
    } catch {
      res.status(resp.status).json({ error: text });
    }
  } catch (err) {
    res
      .status(err.message === "API Key is required" ? 401 : 502)
      .json({ error: err.message });
  }
});

// ── COS Configuration ──
const COS_BUCKET = process.env.COS_BUCKET;
const COS_REGION = process.env.COS_REGION;
const COS_SECRET_ID = process.env.COS_SECRET_ID;
const COS_SECRET_KEY = process.env.COS_SECRET_KEY;
const COS_BASE_URL = `https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`;

const cos = new COS({
  SecretId: COS_SECRET_ID,
  SecretKey: COS_SECRET_KEY,
});

// Detect storage backend from Origin/Referer
const TOS_ORIGINS = ["anyfast.com.cn"];
function isTosOrigin(req) {
  const origin = req.headers.origin || "";
  const referer = req.headers.referer || "";
  const apiBase = req.headers["x-api-base"] || "";
  return TOS_ORIGINS.some(h => origin.includes(h) || referer.includes(h))
    || TOS_ORIGINS.some(h => typeof apiBase === "string" && decodeURI(apiBase).includes(h))
    || req.body?.storage === "tos" || req.query?.storage === "tos" || req.headers["x-storage"] === "tos";
}

function isCosStorageUrl(url) {
  return typeof url === "string" && url.startsWith(COS_BASE_URL + "/");
}

function isTosStorageUrl(url) {
  return typeof url === "string" && url.includes(`://${TOS_PUBLIC_HOST}/`);
}

function shouldMirrorCosToTos(req, storageUrl) {
  return isTosOrigin(req) && isCosStorageUrl(storageUrl) && !isTosStorageUrl(storageUrl);
}

async function uploadBufferToTos(key, contentType, body) {
  if (!TOS_AK || !TOS_SK) throw new Error("TOS not configured");
  const presign = tosPresignPut(key, contentType || "application/octet-stream");
  const upResp = await fetch(presign.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType || "application/octet-stream" },
    body,
  });
  if (!upResp.ok) throw new Error(`TOS upload failed: ${upResp.status}`);
  return presign.fileUrl;
}

async function mirrorCosAssetToTosIfNeeded(req, storageUrl, contentHash = "") {
  if (!shouldMirrorCosToTos(req, storageUrl)) return storageUrl;
  const hash = normalizeContentHash(contentHash) || deriveContentHashFromStorageUrl(storageUrl);
  const ext = (() => {
    try {
      const last = new URL(storageUrl).pathname.split("/").filter(Boolean).pop() || "";
      const m = last.match(/\.([a-zA-Z0-9]+)$/);
      return (m?.[1] || "bin").toLowerCase();
    } catch {
      return "bin";
    }
  })();
  if (hash) {
    const existing = findAssetByHash(getUserHash(req), hash);
    if (existing?.storage_url && isTosStorageUrl(existing.storage_url)) return existing.storage_url;
  }
  const source = await fetch(storageUrl);
  if (!source.ok) throw new Error(`Failed to mirror COS asset to TOS: source ${source.status}`);
  const bytes = Buffer.from(await source.arrayBuffer());
  const finalHash = hash || crypto.createHash("sha256").update(bytes).digest("hex");
  const contentType = source.headers.get("content-type") || "application/octet-stream";
  const key = `assets/${finalHash}.${ext}`;
  const fileUrl = await uploadBufferToTos(key, contentType, bytes);
  console.warn(`[StorageMirror] mirrored COS asset to TOS for zh base: ${storageUrl.slice(0, 90)} -> ${fileUrl}`);
  return fileUrl;
}

// Get presigned upload URL — auto-routes COS or TOS based on origin
app.post("/api/presign", (req, res, next) => { req.url = "/api/cos/presign"; next(); });
app.post("/api/cos/presign", (req, res) => {
  try {
    getKey(req);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  const { filename, contentType, prefix, key: clientKey } = req.body;
  if (!filename || !contentType) {
    return res.status(400).json({ error: "filename and contentType required" });
  }

  const pfx = prefix || "uploads";
  const ext = filename.split(".").pop() || "bin";
  // Allow client to provide a deterministic key (e.g. assets/{hash}.{ext}) for dedup
  const key = clientKey && /^[a-zA-Z0-9/_\-.]+$/.test(clientKey)
    ? clientKey
    : `${pfx}/${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;

  // TOS mode: auto-detect from origin or explicit storage param
  if (isTosOrigin(req) && TOS_AK && TOS_SK) {
    try {
      const result = tosPresignPut(key, contentType);
      return res.json({ ...result, key });
    } catch (err) {
      console.error("TOS presign error:", err);
      return res.status(500).json({ error: "Failed to generate upload URL" });
    }
  }

  cos.getObjectUrl(
    {
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Key: key,
      Method: "PUT",
      Sign: true,
      Expires: 600,
      Headers: { "Content-Type": contentType },
    },
    (err, data) => {
      if (err) {
        console.error("COS presign error:", err);
        return res.status(500).json({ error: "Failed to generate upload URL" });
      }
      res.json({
        uploadUrl: data.Url,
        fileUrl: `${COS_BASE_URL}/${key}`,
        key,
      });
    }
  );
});

// ── Video upload with compression ──
const MAX_PIXELS = 927408;
const MAX_DURATION = 15;
const tmpDir = join(os.tmpdir(), "seedance-uploads");
mkdirSync(tmpDir, { recursive: true });

const upload = multer({ dest: tmpDir, limits: { fileSize: 200 * 1024 * 1024 } });

// Content-addressed key under assets/. Same content -> same key, so repeated
// uploads dedupe and the storage URL remains stable for the asset library.
function hashFileKey(filePath, ext) {
  const hash = crypto.createHash("sha256").update(readFileSync(filePath)).digest("hex");
  return `assets/${hash}.${ext}`;
}

async function probeVideo(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams", "-show_format",
    filePath,
  ]);
  const info = JSON.parse(stdout);
  const vs = info.streams.find((s) => s.codec_type === "video");
  return {
    width: vs ? parseInt(vs.width, 10) : 0,
    height: vs ? parseInt(vs.height, 10) : 0,
    duration: parseFloat(info.format.duration || "0"),
  };
}

app.post("/api/upload/video", upload.single("file"), async (req, res) => {
  try {
    getKey(req);
  } catch (err) {
    if (req.file?.path) try { unlinkSync(req.file.path); } catch {}
    return res.status(401).json({ error: err.message });
  }
  if (!req.file) return res.status(400).json({ error: "No file provided" });

  const inputPath = req.file.path;
  const outName = `${crypto.randomUUID().slice(0, 8)}.mp4`;
  const outputPath = join(tmpDir, outName);

  try {
    const { width, height, duration } = await probeVideo(inputPath);
    const pixels = width * height;

    const ffArgs = ["-i", inputPath, "-y"];

    // Trim duration if needed — take the last MAX_DURATION seconds
    if (duration > MAX_DURATION) {
      const startTime = duration - MAX_DURATION;
      ffArgs.push("-ss", String(startTime), "-t", String(MAX_DURATION));
    }

    // Scale down if pixel count exceeds limit
    if (pixels > MAX_PIXELS) {
      const scale = Math.sqrt(MAX_PIXELS / pixels);
      const newW = Math.floor((width * scale) / 2) * 2;
      const newH = Math.floor((height * scale) / 2) * 2;
      ffArgs.push("-vf", `scale=${newW}:${newH}`);
    }

    ffArgs.push("-c:v", "libx264", "-preset", "fast", "-crf", "23");
    ffArgs.push("-c:a", "aac", "-b:a", "128k");
    ffArgs.push(outputPath);

    await execFileAsync("ffmpeg", ffArgs, { timeout: 120000 });

    // Upload to COS or TOS
    const useTos = isTosOrigin(req);
    const storageKey = hashFileKey(outputPath, "mp4");
    let fileUrl;
    if (useTos && TOS_AK && TOS_SK) {
      const presign = tosPresignPut(storageKey, "video/mp4");
      const body = readFileSync(outputPath);
      const upResp = await fetch(presign.uploadUrl, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body });
      if (!upResp.ok) throw new Error(`TOS upload failed: ${upResp.status}`);
      fileUrl = presign.fileUrl;
    } else {
      await new Promise((resolve, reject) => {
        cos.putObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: storageKey, Body: createReadStream(outputPath), ContentType: "video/mp4" }, (err) => err ? reject(err) : resolve());
      });
      fileUrl = `${COS_BASE_URL}/${storageKey}`;
    }
    res.json({ fileUrl });
  } catch (err) {
    console.error("Video processing error:", err);
    res.status(500).json({ error: "Video processing failed: " + err.message });
  } finally {
    try { unlinkSync(inputPath); } catch {}
    try { unlinkSync(outputPath); } catch {}
  }
});

// ── TOS (Volcengine) Configuration ──
const TOS_AK = process.env.TOS_AK;
const TOS_SK = process.env.TOS_SK;
const TOS_BUCKET = process.env.TOS_BUCKET || "anyfast-seedance-web";
const TOS_REGION = process.env.TOS_REGION || "cn-beijing";
const TOS_S3_HOST = `${TOS_BUCKET}.tos-s3-${TOS_REGION}.volces.com`;
const TOS_PUBLIC_HOST = `${TOS_BUCKET}.tos-${TOS_REGION}.volces.com`;

function tosSignKey(dateShort) {
  let k = crypto.createHmac("sha256", "AWS4" + TOS_SK).update(dateShort).digest();
  k = crypto.createHmac("sha256", k).update(TOS_REGION).digest();
  k = crypto.createHmac("sha256", k).update("s3").digest();
  return crypto.createHmac("sha256", k).update("aws4_request").digest();
}

function tosPresignPut(key, contentType, expires = 600) {
  const now = new Date();
  const iso = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const dateShort = iso.slice(0, 8);
  const scope = `${dateShort}/${TOS_REGION}/s3/aws4_request`;

  const params = new URLSearchParams();
  params.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  params.set("X-Amz-Credential", `${TOS_AK}/${scope}`);
  params.set("X-Amz-Date", iso);
  params.set("X-Amz-Expires", String(expires));
  params.set("X-Amz-SignedHeaders", "host");
  params.sort();

  const canon = ["PUT", `/${key}`, params.toString(), `host:${TOS_S3_HOST}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const sts = ["AWS4-HMAC-SHA256", iso, scope, crypto.createHash("sha256").update(canon).digest("hex")].join("\n");
  const sig = crypto.createHmac("sha256", tosSignKey(dateShort)).update(sts).digest("hex");
  params.set("X-Amz-Signature", sig);

  return {
    uploadUrl: `https://${TOS_S3_HOST}/${key}?${params.toString()}`,
    fileUrl: `https://${TOS_PUBLIC_HOST}/${key}`,
  };
}


// Generic file upload — supports COS (default) and TOS (X-Storage: tos)
app.post("/api/upload/file", upload.single("file"), async (req, res) => {
  try {
    getKey(req);
  } catch (err) {
    if (req.file?.path) try { unlinkSync(req.file.path); } catch {}
    return res.status(401).json({ error: err.message });
  }
  if (!req.file) return res.status(400).json({ error: "No file provided" });
  const useTos = req.body?.storage === "tos" || req.query?.storage === "tos" || req.headers["x-storage"] === "tos";
  try {
    let fileUrl;
    if (useTos) {
      if (!TOS_AK || !TOS_SK) throw new Error("TOS not configured");
      const ext = (req.file.originalname || "bin").split(".").pop() || "bin";
      const key = hashFileKey(req.file.path, ext);
      const presign = tosPresignPut(key, req.file.mimetype);
      const body = readFileSync(req.file.path);
      const upResp = await fetch(presign.uploadUrl, { method: "PUT", headers: { "Content-Type": req.file.mimetype }, body });
      if (!upResp.ok) throw new Error(`TOS upload failed: ${upResp.status}`);
      fileUrl = presign.fileUrl;
    } else {
      const ext = (req.file.originalname || "bin").split(".").pop() || "bin";
      const cosKey = hashFileKey(req.file.path, ext);
      await new Promise((resolve, reject) => {
        cos.putObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: cosKey, Body: createReadStream(req.file.path), ContentType: req.file.mimetype }, (err) => err ? reject(err) : resolve());
      });
      fileUrl = `${COS_BASE_URL}/${cosKey}`;
    }
    res.json({ fileUrl });
  } catch (err) {
    console.error("File upload error:", err);
    res.status(500).json({ error: "Upload failed: " + err.message });
  } finally {
    try { unlinkSync(req.file.path); } catch {}
  }
});

// TOS presign - browser uploads directly to TOS.
// Server has no file bytes here, so we can't compute a content hash. Prefer
// /api/cos/presign with a deterministic key (eg assets/{sha256}.{ext}) when
// the caller needs the URL to dedupe against the asset library.
app.post("/api/tos/presign", (req, res) => {
  try {
    getKey(req);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  const { filename, contentType } = req.body;
  if (!filename || !contentType) return res.status(400).json({ error: "filename and contentType required" });
  if (!TOS_AK || !TOS_SK) return res.status(500).json({ error: "TOS not configured" });
  const ext = filename.split(".").pop() || "bin";
  const key = `uploads/${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
  try {
    const result = tosPresignPut(key, contentType);
    res.json({ ...result, key });
  } catch (err) {
    console.error("TOS presign error:", err);
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

// TOS video upload — ffmpeg + upload to TOS
app.post("/api/tos/upload-video", upload.single("file"), async (req, res) => {
  try {
    getKey(req);
  } catch (err) {
    if (req.file?.path) try { unlinkSync(req.file.path); } catch {}
    return res.status(401).json({ error: err.message });
  }
  if (!req.file) return res.status(400).json({ error: "No file provided" });
  if (!TOS_AK || !TOS_SK) return res.status(500).json({ error: "TOS not configured" });
  const inputPath = req.file.path;
  const outName = `${crypto.randomUUID().slice(0, 8)}.mp4`;
  const outputPath = join(tmpDir, outName);
  try {
    const { width, height, duration } = await probeVideo(inputPath);
    const pixels = width * height;
    const ffArgs = ["-i", inputPath, "-y"];
    if (duration > MAX_DURATION) {
      const startTime = duration - MAX_DURATION;
      ffArgs.push("-ss", String(startTime), "-t", String(MAX_DURATION));
    }
    if (pixels > MAX_PIXELS) {
      const scale = Math.sqrt(MAX_PIXELS / pixels);
      const newW = Math.floor((width * scale) / 2) * 2;
      const newH = Math.floor((height * scale) / 2) * 2;
      ffArgs.push("-vf", `scale=${newW}:${newH}`);
    }
    ffArgs.push("-c:v", "libx264", "-preset", "fast", "-crf", "23");
    ffArgs.push("-c:a", "aac", "-b:a", "128k");
    ffArgs.push(outputPath);
    await execFileAsync("ffmpeg", ffArgs, { timeout: 120000 });
    const storageKey = hashFileKey(outputPath, "mp4");
    const presign = tosPresignPut(storageKey, "video/mp4");
    const body = readFileSync(outputPath);
    const upResp = await fetch(presign.uploadUrl, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body });
    if (!upResp.ok) throw new Error(`TOS upload failed: ${upResp.status}`);
    res.json({ fileUrl: presign.fileUrl });
  } catch (err) {
    console.error("Video processing error (TOS):", err);
    res.status(500).json({ error: "Video processing failed: " + err.message });
  } finally {
    try { unlinkSync(inputPath); } catch {}
    try { unlinkSync(outputPath); } catch {}
  }
});

// ── Volcengine Asset API (proxied via AnyFast gateway so calls are metered) ──
// Calls go to `${X-Api-Base}/volc/asset/<Action>` with the user's own Bearer key,
// instead of directly hitting open.volcengineapi.com with server-side AK/SK.
const VOLC_ASSET_MODEL = {
  Image: "volc-asset",
  Video: "volc-asset-video",
  Audio: "volc-asset-audio",
};

const ALLOWED_ASSET_ACTIONS = new Set([
  "CreateAssetGroup", "CreateAsset", "ListAssetGroups", "ListAssets",
  "GetAsset", "GetAssetGroup", "UpdateAssetGroup", "UpdateAsset",
]);

// Normalize any proxy/Volc error shape into a plain string for logging/throwing.
// Proxy returns `{error: {code, message, type}}` or `{error: "string"}`.
// Volc SDK style returns `{ResponseMetadata: {Error: {Code, Message}}}`.
function extractErrorMessage(data, fallback) {
  if (!data) return fallback;
  const e = data.error;
  if (typeof e === "string" && e) return e;
  if (e && typeof e === "object") {
    if (typeof e.message === "string" && e.message) return e.message;
    try { return JSON.stringify(e); } catch { /* fall through */ }
  }
  const volcErr = data.ResponseMetadata?.Error;
  if (volcErr?.Message) return volcErr.Message;
  if (volcErr?.Code) return volcErr.Code;
  return fallback;
}

async function volcAssetCall(req, action, body) {
  const base = getBase(req);
  const key = getKey(req);
  const resp = await fetch(`${base}/volc/asset/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ ...body, model: VOLC_ASSET_MODEL[body.AssetType] || VOLC_ASSET_MODEL.Image }),
  });
  let data;
  const text = await resp.text();
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!resp.ok) {
    throw new Error(extractErrorMessage(data, `HTTP ${resp.status}`));
  }
  // Proxy may return 200 with an error body
  if (data?.error) {
    throw new Error(extractErrorMessage(data, "Asset API error"));
  }
  if (data?.ResponseMetadata?.Error) {
    throw new Error(extractErrorMessage(data, "Asset API error"));
  }
  return data.Result || data;
}

app.post("/api/asset/:action", async (req, res) => {
  const { action } = req.params;
  if (!ALLOWED_ASSET_ACTIONS.has(action)) {
    return res.status(400).json({ error: "Invalid action" });
  }
  try {
    const data = await volcAssetCall(req, action, req.body || {});
    res.json(data);
  } catch (err) {
    console.error(`Asset API ${action} error:`, err.message);
    const code = err.message === "API Key is required" ? 401
      : err.message?.includes("Invalid API base") ? 400 : 502;
    res.status(code).json({ error: err.message });
  }
});

// ── Server-side Asset Group Management ──
// Cache keyed by (base|key) so different users/gateways don't collide.
const _groupCache = new Map();
const _groupLocks = new Map();

async function serverEnsureAssetGroup(req) {
  const cacheKey = getBase(req) + "|" + getKey(req);
  const cached = _groupCache.get(cacheKey);
  if (cached && cached.count < 64) return cached.id;

  const existingLock = _groupLocks.get(cacheKey);
  if (existingLock) {
    await existingLock;
    const after = _groupCache.get(cacheKey);
    if (after && after.count < 64) return after.id;
  }
  let resolve;
  const lock = new Promise((r) => { resolve = r; });
  _groupLocks.set(cacheKey, lock);
  try {
    const list = await volcAssetCall(req, "ListAssetGroups", {
      Filter: { GroupType: "AIGC" }, PageNumber: 1, PageSize: 100,
    });
    const groups = (list.Items || []).filter((g) => !g.Name?.startsWith("__del__"));
    for (const g of groups) {
      const assets = await volcAssetCall(req, "ListAssets", {
        Filter: { GroupIds: [g.Id], GroupType: "AIGC" }, PageNumber: 1, PageSize: 1,
      });
      const count = assets.TotalCount || 0;
      if (count < 64) {
        _groupCache.set(cacheKey, { id: g.Id, count });
        return g.Id;
      }
    }
    const name = "auto-assets-" + Date.now();
    const created = await volcAssetCall(req, "CreateAssetGroup", { Name: name, GroupType: "AIGC" });
    _groupCache.set(cacheKey, { id: created.Id, count: 0 });
    return created.Id;
  } finally {
    _groupLocks.delete(cacheKey);
    resolve();
  }
}

// Shared batched poller. Many serverCreateAsset calls can run in parallel
// (eg user submits 10 images at once); each used to do its own ListAssets every
// 2s, so 10 parallel CreateAssets = 300 ListAssets calls in 60s. Now we group
// pending ids by (base, key) and run ONE ListAssets per tick that covers every
// id the group is waiting on. Same total wall time, ~10× fewer upstream calls.
//
// Each group entry: { req, pending: Map<assetId, {resolve,reject,deadline}>, ticker, busy }
const _pollGroups = new Map();
const POLL_INTERVAL_MS = 3000;

function poolKey(req) { return getBase(req) + "|" + getKey(req); }

async function listAssetsByIds(req, ids, { scanIfMissing = false, logPrefix = "ListAssets" } = {}) {
  const wanted = new Set((ids || []).filter(Boolean));
  const found = new Map();
  if (wanted.size === 0) return found;

  const addRequested = (items) => {
    let unrelated = 0;
    for (const item of items || []) {
      if (!item?.Id || !wanted.has(item.Id)) {
        if (item?.Id) unrelated++;
        continue;
      }
      found.set(item.Id, item);
    }
    return unrelated;
  };

  const first = await volcAssetCall(req, "ListAssets", {
    Filter: { Ids: [...wanted], GroupType: "AIGC" },
    PageNumber: 1, PageSize: Math.max(wanted.size, 10),
  });
  const unrelated = addRequested(first.Items || []);

  if (!scanIfMissing || found.size === wanted.size) return found;

  const missing = () => [...wanted].filter((id) => !found.has(id));
  console.warn(`[${logPrefix}] Filter.Ids returned ${found.size}/${wanted.size} requested id(s)${unrelated ? ` plus ${unrelated} unrequested` : ""}; scanning groups for missing id(s)`);

  const groupList = await volcAssetCall(req, "ListAssetGroups", {
    Filter: { GroupType: "AIGC" }, PageNumber: 1, PageSize: 100,
  });
  const groups = (groupList.Items || []).filter((g) => g.Id && !g.Name?.startsWith("__del__"));
  for (const g of groups) {
    if (missing().length === 0) break;
    let page = 1;
    const pageSize = 100;
    while (page <= 50) {
      const list = await volcAssetCall(req, "ListAssets", {
        Filter: { GroupIds: [g.Id], GroupType: "AIGC" },
        PageNumber: page, PageSize: pageSize,
      });
      addRequested(list.Items || []);
      if (missing().length === 0 || (list.Items || []).length < pageSize) break;
      page++;
    }
  }
  return found;
}

async function runPollTick(key) {
  const group = _pollGroups.get(key);
  if (!group || group.busy) return;
  group.busy = true;
  try {
    // Drop any deadlines that have expired.
    const now = Date.now();
    for (const [id, w] of [...group.pending]) {
      if (now >= w.deadline) {
        group.pending.delete(id);
        w.reject(new Error("Asset whitelisting timeout (120s)"));
      }
    }
    if (group.pending.size === 0) return;
    const ids = [...group.pending.keys()];
    let items = [];
    try {
      const byId = await listAssetsByIds(group.req, ids, { scanIfMissing: true, logPrefix: "PollGroup" });
      items = [...byId.values()];
    } catch (e) {
      console.warn(`[PollGroup] ListAssets error for ${ids.length} id(s):`, e.message);
      return; // try again next tick
    }
    const seen = new Set();
    for (const item of items) {
      if (!item.Id || !group.pending.has(item.Id)) continue;
      seen.add(item.Id);
      const status = item.Status;
      const itemUrl = typeof item.URL === "string" ? item.URL : "";
      const urlOk = itemUrl.startsWith("https://") || itemUrl.startsWith("http://");
      console.log(`[Asset ${item.Id}] Status: ${status}${status === "Active" && !urlOk ? " (URL not ready)" : ""}`);
      if (status === "Active" && urlOk) {
        const w = group.pending.get(item.Id);
        group.pending.delete(item.Id);
        w.resolve(item.Id);
      } else if (status === "Failed" || status === "failed") {
        const w = group.pending.get(item.Id);
        group.pending.delete(item.Id);
        w.reject(new Error("Asset whitelisting failed: " + (item.FailReason || "unknown")));
      }
      // else (Active no URL, Processing): keep waiting
    }
    for (const id of ids) {
      if (!seen.has(id)) {
        console.log(`[Asset ${id}] not visible yet via ListAssets, retrying`);
      }
    }
  } finally {
    group.busy = false;
    if (group.pending.size === 0 && group.ticker) {
      clearInterval(group.ticker);
      group.ticker = null;
      _pollGroups.delete(key);
    }
  }
}

// Wait for a single asset to reach Active+urlOk via the shared batch poller.
function awaitAssetActive(req, assetId) {
  const key = poolKey(req);
  let group = _pollGroups.get(key);
  if (!group) {
    group = { req, pending: new Map(), ticker: null, busy: false };
    _pollGroups.set(key, group);
  } else {
    // Refresh req: token rotation etc shouldn't matter for ListAssets,
    // but keep the most recent valid req object as the canonical one.
    group.req = req;
  }
  return new Promise((resolve, reject) => {
    group.pending.set(assetId, { resolve, reject, deadline: Date.now() + 120000 });
    if (!group.ticker) {
      group.ticker = setInterval(() => { runPollTick(key); }, POLL_INTERVAL_MS);
      // Kick off an immediate first tick after a small delay so the asset has
      // a moment to land in upstream's index before we ask.
      setTimeout(() => runPollTick(key), 1500);
    }
  });
}

async function serverCreateAsset(req, url, name, assetType = "Image") {
  // Reject upstream-bound bad URLs at the source. Volc CreateAsset will happily
  // accept anything but later /generate calls fail with "invalid url scheme",
  // by which point the bad asset_id is loose in the system. Catch it here.
  if (typeof url !== "string" || !(url.startsWith("https://") || url.startsWith("http://"))) {
    throw new Error(`serverCreateAsset rejected invalid URL: ${JSON.stringify(url)?.slice(0, 100)}`);
  }
  const groupId = await serverEnsureAssetGroup(req);
  const result = await volcAssetCall(req, "CreateAsset", {
    GroupId: groupId, URL: url, AssetType: assetType, Name: (name || assetType.toLowerCase()).slice(0, 60),
  });
  const cacheKey = getBase(req) + "|" + getKey(req);
  const entry = _groupCache.get(cacheKey);
  if (entry) entry.count++;
  return await awaitAssetActive(req, result.Id);
}

const _assetRecoveryByAssetUrl = new Map();

// ── Asset Library API ──
function getUserHash(req) {
  const key = req.headers["x-api-key"];
  if (!key) throw new Error("API Key is required");
  return hashApiKey(key);
}

// HMAC-signed thumbnail tokens. <img> can't send X-Api-Key headers, so we sign
// a short-lived URL parameter that proves "user with this userHash may view this asset id".
// Restarting the server invalidates outstanding tokens — fine, list refetch issues new ones.
const THUMB_SIGN_SECRET = process.env.THUMB_SIGN_SECRET || crypto.randomBytes(32).toString("hex");
const THUMB_TOKEN_TTL_SECONDS = 3600;

function signThumb(userHash, assetId, expSeconds) {
  const payload = `${userHash}:${assetId}:${expSeconds}`;
  const sig = crypto.createHmac("sha256", THUMB_SIGN_SECRET).update(payload).digest("base64url");
  return `${expSeconds}.${sig}`;
}

function verifyThumb(token, userHash, assetId) {
  if (typeof token !== "string" || !token.includes(".")) return false;
  const dot = token.indexOf(".");
  const exp = parseInt(token.slice(0, dot), 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = signThumb(userHash, assetId, exp);
  // Constant-time compare to avoid leaking timing info on bad tokens.
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function decorateWithThumbToken(assets, userHash) {
  const exp = Math.floor(Date.now() / 1000) + THUMB_TOKEN_TTL_SECONDS;
  return assets.map((a) => ({ ...a, thumb_token: signThumb(userHash, a.id, exp) }));
}

// Coalesce all whitelist attempts for the same local asset row. Without this,
// the compose uploader's auto-register path and the generate-time reconcile path
// can both call CreateAsset for the same permanent storage URL.
const _localWhitelistLocks = new Map();

async function whitelistLocalAsset(req, userHash, asset, { force = false, name, type } = {}) {
  const lockKey = `${userHash}:${asset.id}`;
  if (!force) {
    const current = getAssetById(asset.id) || asset;
    if (current.asset_status === "ready" && current.asset_id && !shouldMirrorCosToTos(req, current.storage_url)) {
      return { asset: current };
    }
    const existingLock = _localWhitelistLocks.get(lockKey);
    if (existingLock) return await existingLock;
  }

  const pending = (async () => {
    let current = getAssetById(asset.id) || asset;
    if (!force && current.asset_status === "ready" && current.asset_id && !shouldMirrorCosToTos(req, current.storage_url)) {
      return { asset: current };
    }
    updateAssetStatus(current.id, userHash, { assetId: null, assetStatus: "pending" });
    try {
      const mediaType = type || current.type || "image";
      const assetType = mediaType === "video" ? "Video" : mediaType === "audio" ? "Audio" : "Image";
      const mirroredUrl = await mirrorCosAssetToTosIfNeeded(req, current.storage_url, current.content_hash);
      if (mirroredUrl !== current.storage_url) {
        current = upsertKnownAsset({
          userHash,
          name: name || current.name,
          type: mediaType,
          storageUrl: mirroredUrl,
          thumbUrl: current.thumb_url || "",
          contentHash: current.content_hash || deriveContentHashFromStorageUrl(current.storage_url),
          assetId: "",
          assetStatus: "pending",
        }) || current;
      }
      const volcId = await serverCreateAsset(req, current.storage_url, name || current.name, assetType);
      const updated = updateAssetStatus(current.id, userHash, {
        assetId: "asset://" + volcId,
        assetStatus: "ready",
      });
      return { asset: updated };
    } catch (e) {
      const failed = updateAssetStatus(current.id, userHash, { assetId: null, assetStatus: "failed" });
      return { asset: failed, error: e.message };
    }
  })().finally(() => {
    if (_localWhitelistLocks.get(lockKey) === pending) _localWhitelistLocks.delete(lockKey);
  });

  _localWhitelistLocks.set(lockKey, pending);
  return await pending;
}

// List user's assets
app.get("/api/assets", (req, res) => {
  try {
    const userHash = getUserHash(req);
    res.json({ assets: decorateWithThumbToken(listAssets(userHash), userHash) });
  } catch (err) {
    res.status(err.message === "API Key is required" ? 401 : 500).json({ error: err.message });
  }
});

// On-demand video thumbnail. Resolves to a real image URL via 302:
//   - has thumb_url       → redirect to it
//   - non-video           → redirect to storage_url
//   - video missing thumb → ffmpeg first-frame, upload to COS/TOS, persist, redirect
//   - any failure         → redirect to storage_url (graceful — never breaks the grid)
// Concurrent calls for the same asset are coalesced via _thumbInflight.
const _thumbInflight = new Map();

const MAX_THUMB_SOURCE_BYTES = 300 * 1024 * 1024;

async function generateVideoThumb(asset) {
  const sourceUrl = asset.storage_url;
  if (!sourceUrl) throw new Error("Asset has no storage_url");
  const inputPath = join(tmpDir, `thumb-src-${asset.id}-${Date.now()}.mp4`);
  const outputPath = join(tmpDir, `thumb-${asset.id}-${Date.now()}.jpg`);
  try {
    const resp = await fetch(sourceUrl);
    if (!resp.ok) throw new Error(`Source fetch ${resp.status}`);
    // Reject obviously oversized sources up front so a single huge upload can't
    // OOM the box. Streaming below also enforces the cap on missing/lying headers.
    const declared = parseInt(resp.headers.get("content-length") || "0", 10);
    if (declared && declared > MAX_THUMB_SOURCE_BYTES) {
      throw new Error(`Source too large: ${declared} bytes`);
    }
    // Stream to disk so peak RAM stays bounded — large videos used to blow up
    // when read fully into memory via arrayBuffer().
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(inputPath));
    const written = statSync(inputPath).size;
    if (written > MAX_THUMB_SOURCE_BYTES) {
      throw new Error(`Source too large after download: ${written} bytes`);
    }
    try {
      await execFileAsync("ffmpeg", [
        "-y", "-ss", "0", "-i", inputPath,
        "-frames:v", "1", "-q:v", "3", "-vf", "scale='min(640,iw)':-2",
        outputPath,
      ], { timeout: 30000 });
    } catch (e) {
      // ffmpeg can exit non-zero on truncated/unsupported files. Re-throw a clean
      // error so the outer catch in the route can fall back to storage_url instead
      // of letting an unhandled rejection bubble up.
      throw new Error(`ffmpeg failed: ${e.message?.split("\n")[0] || e.code || "unknown"}`);
    }
    // Verify the output is actually there and non-empty before we try to upload.
    // Without this check, ffmpeg silently producing nothing would cause the COS
    // putObject stream to emit ENOENT asynchronously — which becomes an
    // unhandled rejection and crashes the request.
    let outStat;
    try { outStat = statSync(outputPath); } catch { throw new Error("ffmpeg produced no output file"); }
    if (!outStat || outStat.size === 0) throw new Error("ffmpeg produced empty output");

    const useTos = sourceUrl.includes(".volces.com");
    const key = `thumbs/${asset.id}_${Date.now()}.jpg`;
    const body = readFileSync(outputPath);
    let thumbUrl;
    if (useTos && TOS_AK && TOS_SK) {
      const presign = tosPresignPut(key, "image/jpeg");
      const upResp = await fetch(presign.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body });
      if (!upResp.ok) throw new Error(`TOS thumb upload ${upResp.status}`);
      thumbUrl = presign.fileUrl;
    } else {
      await new Promise((resolve, reject) => {
        cos.putObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: key, Body: body, ContentType: "image/jpeg" }, (err) => err ? reject(err) : resolve());
      });
      thumbUrl = `${COS_BASE_URL}/${key}`;
    }
    updateAssetThumb(asset.id, thumbUrl);
    console.log(`[Thumb] Generated for asset ${asset.id} → ${thumbUrl}`);
    return thumbUrl;
  } finally {
    try { unlinkSync(inputPath); } catch {}
    try { unlinkSync(outputPath); } catch {}
  }
}

app.get("/api/assets/:id/thumb", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
  const asset = getAssetById(id);
  if (!asset) return res.status(404).json({ error: "Not found" });
  // <img> can't send X-Api-Key, so authorize via signed token tied to (userHash, id).
  if (!verifyThumb(req.query.t, asset.user_hash, asset.id)) {
    return res.status(401).json({ error: "Invalid or expired thumb token" });
  }
  // Browser-cache the redirect target for a day so repeat views don't even hit us.
  res.setHeader("Cache-Control", "public, max-age=86400");
  // Treat thumb_url == storage_url as "no thumb" — that's a bulk-whitelist legacy row
  // pointing at the video itself, which would make the <img> load a full video stream.
  const hasRealThumb = asset.thumb_url && asset.thumb_url !== asset.storage_url;
  if (hasRealThumb) return res.redirect(302, asset.thumb_url);
  if (asset.type !== "video") return res.redirect(302, asset.storage_url);

  let pending = _thumbInflight.get(id);
  if (!pending) {
    pending = generateVideoThumb(asset).finally(() => _thumbInflight.delete(id));
    _thumbInflight.set(id, pending);
  }
  try {
    const thumbUrl = await pending;
    res.redirect(302, thumbUrl);
  } catch (err) {
    console.warn(`[Thumb] Generation failed for asset ${id}:`, err.message);
    res.redirect(302, asset.storage_url);
  }
});

// Reconcile local asset library against upstream Volc ListAssets.
// For every Active upstream asset whose URL matches a local row, write back
// asset_id + asset_status='ready' so submission can use asset:// on the first try
// (covers assets whitelisted out-of-band — other devices, sessions, etc).
app.get("/api/assets/sync", async (req, res) => {
  try {
    const userHash = getUserHash(req);
    const groupList = await volcAssetCall(req, "ListAssetGroups", {
      Filter: { GroupType: "AIGC" }, PageNumber: 1, PageSize: 100,
    });
    const groups = (groupList.Items || []).filter((g) => !g.Name?.startsWith("__del__"));
    const upstreamByUrl = new Map();
    const upstreamByHash = new Map();
    for (const g of groups) {
      let page = 1;
      const pageSize = 100;
      while (true) {
        const list = await volcAssetCall(req, "ListAssets", {
          Filter: { GroupIds: [g.Id], GroupType: "AIGC" },
          PageNumber: page, PageSize: pageSize,
        });
        const items = list.Items || [];
        for (const item of items) {
          if (item.Status === "Active" && item.URL && item.Id) {
            upstreamByUrl.set(item.URL, item.Id);
            const hash = deriveContentHashFromStorageUrl(item.URL);
            if (hash) upstreamByHash.set(hash, item.Id);
          }
        }
        if (items.length < pageSize) break;
        page++;
        if (page > 50) break; // safety cap (5000 assets per group)
      }
    }
    let reconciled = 0;
    for (const [url, volcId] of upstreamByUrl) {
      const local = findAssetByUrl(userHash, url);
      if (!local) continue;
      const targetAssetId = "asset://" + volcId;
      if (local.asset_status === "ready" && local.asset_id === targetAssetId) continue;
      updateAssetStatus(local.id, userHash, { assetId: targetAssetId, assetStatus: "ready" });
      reconciled++;
    }
    for (const local of listAssets(userHash)) {
      if (!local.content_hash) continue;
      const volcId = upstreamByHash.get(local.content_hash);
      if (!volcId) continue;
      const targetAssetId = "asset://" + volcId;
      if (local.asset_status === "ready" && local.asset_id === targetAssetId) continue;
      updateAssetStatus(local.id, userHash, { assetId: targetAssetId, assetStatus: "ready" });
      reconciled++;
    }
    console.log(`[AssetSync] Upstream=${upstreamByUrl.size} hashHints=${upstreamByHash.size} reconciled=${reconciled}`);
    res.json({
      assets: decorateWithThumbToken(listAssets(userHash), userHash),
      reconciled, upstreamCount: upstreamByUrl.size,
    });
  } catch (err) {
    console.error("[AssetSync] Failed:", err.message);
    const code = err.message === "API Key is required" ? 401
      : err.message?.includes("Invalid API base") ? 400 : 502;
    res.status(code).json({ error: err.message });
  }
});

// Register a new asset and proactively whitelist it so the asset_id is ready
// before the user ever submits generate. Once an asset has an asset_id in DB
// we never re-create it — generate flow just reuses what's stored. The whitelist
// step runs in the request lifetime so the response carries the final asset_id
// when the call succeeds; if it fails we return the row as 'none' and the
// user can retry from the asset library button.
app.post("/api/assets", async (req, res) => {
  try {
    const userHash = getUserHash(req);
    const { name, type, thumbUrl, contentHash } = req.body;
    let { storageUrl } = req.body;
    if (!storageUrl) return res.status(400).json({ error: "storageUrl required" });
    storageUrl = await mirrorCosAssetToTosIfNeeded(req, storageUrl, contentHash);
    const asset = upsertKnownAsset({
      userHash,
      name,
      type,
      storageUrl,
      thumbUrl,
      contentHash,
    }) || insertAsset({ userHash, name, type, storageUrl, thumbUrl, contentHash });

    // If the row came back from dedup already in 'ready' state, return as-is
    // unless a zh request is carrying a legacy COS-backed row that needs a
    // TOS asset id instead.
    if (asset.asset_status === "ready" && asset.asset_id && !shouldMirrorCosToTos(req, asset.storage_url)) {
      return res.json({ asset });
    }
    const result = await whitelistLocalAsset(req, userHash, asset, { name, type });
    if (result.error) {
      console.warn(`[Whitelist] Asset ${asset.id} auto-whitelist failed:`, result.error);
      return res.json({ asset: result.asset, whitelistError: result.error });
    }
    console.log(`[Whitelist] Asset ${asset.id} ready (auto): ${result.asset.asset_id}`);
    return res.json({ asset: result.asset });
  } catch (err) {
    res.status(err.message === "API Key is required" ? 401 : 500).json({ error: err.message });
  }
});

// Lookup asset by content hash (for dedup before upload)
app.get("/api/assets/by-hash/:hash", async (req, res) => {
  try {
    const userHash = getUserHash(req);
    let asset = findAssetByHash(userHash, req.params.hash);
    if (asset && shouldMirrorCosToTos(req, asset.storage_url)) {
      const storageUrl = await mirrorCosAssetToTosIfNeeded(req, asset.storage_url, asset.content_hash || req.params.hash);
      asset = upsertKnownAsset({
        userHash,
        name: asset.name || "",
        type: asset.type || "image",
        storageUrl,
        thumbUrl: asset.thumb_url || "",
        contentHash: asset.content_hash || req.params.hash,
        assetId: "",
        assetStatus: "none",
      });
    }
    res.json({ asset: asset || null });
  } catch (err) {
    res.status(err.message === "API Key is required" ? 401 : 500).json({ error: err.message });
  }
});

// Whitelist a single asset
app.post("/api/assets/:id/whitelist", async (req, res) => {
  try {
    const userHash = getUserHash(req);
    const id = parseInt(req.params.id, 10);
    const assets = listAssets(userHash);
    const asset = assets.find((a) => a.id === id);
    if (!asset) return res.status(404).json({ error: "Asset not found" });
    if (asset.asset_status === "ready" && asset.asset_id) {
      return res.json({ asset });
    }
    const result = await whitelistLocalAsset(req, userHash, asset);
    if (result.error) {
      console.error(`[Whitelist] Asset ${id} failed:`, result.error);
      return res.json({ asset: result.asset, error: result.error });
    }
    console.log(`[Whitelist] Asset ${id} ready: ${result.asset.asset_id}`);
    res.json({ asset: result.asset });
  } catch (err) {
    res.status(err.message === "API Key is required" ? 401 : 500).json({ error: err.message });
  }
});

// Delete an asset
app.delete("/api/assets/:id", (req, res) => {
  try {
    const userHash = getUserHash(req);
    const id = parseInt(req.params.id, 10);
    dbDeleteAsset(id, userHash);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message === "API Key is required" ? 401 : 500).json({ error: err.message });
  }
});

// Derive a readable default name from a storage URL (last path segment, decoded, truncated)
function deriveNameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const raw = pathname.split("/").filter(Boolean).pop() || "image";
    return decodeURIComponent(raw).slice(0, 60);
  } catch {
    return "image";
  }
}

// Bulk whitelist — for PrivacyInformation auto-retry
app.post("/api/assets/bulk-whitelist", async (req, res) => {
  try {
    const userHash = getUserHash(req);
    const { storageUrls, items, forceRecreate } = req.body;
    if (!Array.isArray(storageUrls)) return res.status(400).json({ error: "storageUrls array required" });
    const meta = new Map();
    if (Array.isArray(items)) {
      for (const it of items) {
        if (it && typeof it.url === "string") meta.set(it.url, it);
      }
    }
    // forceRecreate: list of storageUrls whose existing 'ready' status is known
    // to be stale (caller already saw upstream report them as orphans). Bypass
    // the reuse short-circuits so we hit Volc CreateAsset and get a fresh id.
    const force = new Set(Array.isArray(forceRecreate) ? forceRecreate : []);
    const results = {};
    const errors = {};
    for (const url of storageUrls) {
      const hint = meta.get(url) || {};
      const originalUrl = url;
      const mirroredForZh = shouldMirrorCosToTos(req, originalUrl);
      let storageUrl = await mirrorCosAssetToTosIfNeeded(req, originalUrl, hint.contentHash);
      const existing = findAssetByUrl(userHash, storageUrl) || findAssetByUrl(userHash, originalUrl);
      if (existing?.asset_status === "ready" && existing.asset_id && !force.has(originalUrl) && !mirroredForZh) {
        results[originalUrl] = existing.asset_id;
        continue;
      }
      const name = existing?.name || hint.name || deriveNameFromUrl(url);
      const contentHash = normalizeContentHash(hint.contentHash) || deriveContentHashFromStorageUrl(storageUrl) || deriveContentHashFromStorageUrl(originalUrl);
      const hintType = hint.type || "image";
      const row = upsertKnownAsset({
        userHash,
        name,
        type: existing?.type || hintType,
        storageUrl,
        contentHash,
        assetUrl: existing?.asset_id || "",
        assetStatus: existing?.asset_status || "",
      }) || existing || insertAsset({ userHash, name, type: hintType, storageUrl, thumbUrl: "", contentHash });
      // insertAsset may have returned an older record (hash-matched) that's already whitelisted.
      // Reuse its asset_id instead of burning another Volc call (unless caller forced recreate).
      if (row.asset_status === "ready" && row.asset_id && !force.has(originalUrl) && !mirroredForZh) {
        results[originalUrl] = row.asset_id;
        continue;
      }
      const result = await whitelistLocalAsset(req, userHash, row, {
        force: force.has(originalUrl) || mirroredForZh,
        name,
        type: row.type || hintType,
      });
      if (result.error) {
        console.warn("[BulkWhitelist] Failed for", originalUrl, result.error);
        results[originalUrl] = null;
        errors[originalUrl] = result.error;
      } else {
        const updated = upsertKnownAsset({
          userHash,
          name: result.asset.name || name,
          type: result.asset.type || row.type || hintType,
          storageUrl: result.asset.storage_url || storageUrl,
          contentHash: result.asset.content_hash || contentHash,
          assetUrl: result.asset.asset_id,
          assetStatus: "ready",
        }) || result.asset;
        results[originalUrl] = updated.asset_id;
      }
    }
    res.json({ results, errors });
  } catch (err) {
    res.status(err.message === "API Key is required" ? 401 : 500).json({ error: err.message });
  }
});

// ── User Preferences API ──
app.get("/api/prefs", (req, res) => {
  try {
    const userHash = getUserHash(req);
    res.json(getPrefs(userHash));
  } catch (err) {
    res.status(err.message === "API Key is required" ? 401 : 500).json({ error: err.message });
  }
});

app.put("/api/prefs", (req, res) => {
  try {
    const userHash = getUserHash(req);
    setPrefs(userHash, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message === "API Key is required" ? 401 : 500).json({ error: err.message });
  }
});

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Front-end version probe. Clients poll this and reload when their bundle hash
// no longer matches what the server is serving. This is how we make sure that
// a server-side fix (eg orphan-asset rebuild) actually reaches old browser tabs
// without waiting for users to refresh.
app.get("/api/version", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    js: ASSET_HASHES["/static/app.js"],
    jsZh: ASSET_HASHES["/static/app.zh.js"],
    css: ASSET_HASHES["/static/app.css"],
  });
});

const PORT = process.env.PORT || 10100;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`http://0.0.0.0:${PORT}`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  console.error("Uncaught:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
