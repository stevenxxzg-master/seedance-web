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
  deleteAsset as dbDeleteAsset, getPrefs, setPrefs,
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Api-Key,X-Storage,Authorization");
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
    const body = await verifyAndRehealAssetIds(req, req.body);
    const resp = await fetch(`${getBase(req)}/v1/video/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getKey(req)}`,
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res
      .status(err.message === "API Key is required" ? 401 : 502)
      .json({ error: err.message });
  }
});

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
  return TOS_ORIGINS.some(h => origin.includes(h) || referer.includes(h))
    || req.body?.storage === "tos" || req.query?.storage === "tos" || req.headers["x-storage"] === "tos";
}

// Get presigned upload URL — auto-routes COS or TOS based on origin
app.post("/api/presign", (req, res, next) => { req.url = "/api/cos/presign"; next(); });
app.post("/api/cos/presign", (req, res) => {
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
    const storageKey = `uploads/${Date.now()}_${outName}`;
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
  if (!req.file) return res.status(400).json({ error: "No file provided" });
  const useTos = req.body?.storage === "tos" || req.query?.storage === "tos" || req.headers["x-storage"] === "tos";
  try {
    let fileUrl;
    if (useTos) {
      if (!TOS_AK || !TOS_SK) throw new Error("TOS not configured");
      const ext = (req.file.originalname || "bin").split(".").pop() || "bin";
      const key = `uploads/${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
      const presign = tosPresignPut(key, req.file.mimetype);
      const body = readFileSync(req.file.path);
      const upResp = await fetch(presign.uploadUrl, { method: "PUT", headers: { "Content-Type": req.file.mimetype }, body });
      if (!upResp.ok) throw new Error(`TOS upload failed: ${upResp.status}`);
      fileUrl = presign.fileUrl;
    } else {
      const ext = (req.file.originalname || "bin").split(".").pop() || "bin";
      const cosKey = `uploads/${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
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

// TOS presign — browser uploads directly to TOS
app.post("/api/tos/presign", (req, res) => {
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
    const storageKey = `uploads/${Date.now()}_${outName}`;
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

// Proxy does not implement GetAsset. Use ListAssets with Filter.Ids instead;
// note GroupType is required by upstream Volc schema.
async function pollAssetStatus(req, assetId) {
  const list = await volcAssetCall(req, "ListAssets", {
    Filter: { Ids: [assetId], GroupType: "AIGC" },
    PageNumber: 1, PageSize: 5,
  });
  const item = (list.Items || []).find((a) => a.Id === assetId);
  return item || null;
}

async function serverCreateAsset(req, url, name, assetType = "Image") {
  const groupId = await serverEnsureAssetGroup(req);
  const result = await volcAssetCall(req, "CreateAsset", {
    GroupId: groupId, URL: url, AssetType: assetType, Name: (name || assetType.toLowerCase()).slice(0, 60),
  });
  const cacheKey = getBase(req) + "|" + getKey(req);
  const entry = _groupCache.get(cacheKey);
  if (entry) entry.count++;
  const assetId = result.Id;
  // Poll ListAssets until Active (or Failed) — max 60s
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const item = await pollAssetStatus(req, assetId);
      if (!item) {
        console.log(`[Asset ${assetId}] not visible yet via ListAssets, retrying`);
        continue;
      }
      const status = item.Status;
      console.log(`[Asset ${assetId}] Status: ${status}`);
      if (status === "Active") return assetId;
      if (status === "Failed" || status === "failed") {
        throw new Error("Asset whitelisting failed: " + (item.FailReason || "unknown"));
      }
    } catch (e) {
      if (e.message?.includes("Asset whitelisting failed")) throw e;
      console.warn(`[Asset ${assetId}] Poll error:`, e.message);
    }
  }
  throw new Error("Asset whitelisting timeout (60s)");
}

// Process-wide cache of asset_ids we've already confirmed exist upstream.
// Once an id is in here we never re-verify it for the lifetime of this process.
// Restarting the server forces re-verification, which is cheap and acceptable.
const _verifiedAssetIds = new Set();

// Walk a generate-body content array and yield every asset:// URL with a setter to swap it.
function* walkAssetUrls(body) {
  if (!body || !Array.isArray(body.content)) return;
  for (const c of body.content) {
    for (const key of ["image_url", "video_url", "audio_url"]) {
      const slot = c?.[key];
      if (slot && typeof slot.url === "string" && slot.url.startsWith("asset://")) {
        yield {
          url: slot.url,
          set: (newUrl) => { slot.url = newUrl; },
        };
      }
    }
  }
}

// Before forwarding to /v1/video/generations, make sure every asset:// id in the
// body is actually live upstream. Volc CreateAsset can return Active for an id
// that later vanishes / fails moderation, which makes the generation request
// blow up with input-image-sensitive style errors. We list the ids, downgrade
// any missing ones in our DB, re-create them via the normal whitelist flow,
// and rewrite the body with the new ids.
//
// The result is cached in _verifiedAssetIds so a given id is only ever checked once.
async function verifyAndRehealAssetIds(req, originalBody) {
  // Deep-clone shallowly enough that we can mutate slot.url via walkAssetUrls.
  const body = JSON.parse(JSON.stringify(originalBody || {}));
  const slots = [...walkAssetUrls(body)];
  if (slots.length === 0) return body;

  // Volc id is the part after "asset://". Group slots by id (same id can appear twice).
  const idToSlots = new Map();
  for (const s of slots) {
    const id = s.url.slice("asset://".length);
    if (!id) continue;
    if (!idToSlots.has(id)) idToSlots.set(id, []);
    idToSlots.get(id).push(s);
  }

  const idsToCheck = [...idToSlots.keys()].filter((id) => !_verifiedAssetIds.has(id));
  if (idsToCheck.length === 0) return body;

  // Filter.Ids is the upstream-supported lookup. PageSize covers all ids we asked about.
  let liveIds = new Set();
  try {
    const list = await volcAssetCall(req, "ListAssets", {
      Filter: { Ids: idsToCheck, GroupType: "AIGC" },
      PageNumber: 1, PageSize: Math.max(idsToCheck.length, 10),
    });
    for (const item of list.Items || []) {
      if (item.Status === "Active" && item.Id) liveIds.add(item.Id);
    }
  } catch (e) {
    // If the verify call itself fails we proceed optimistically — the upstream
    // generate call will surface the real error and PrivacyInformation retry
    // can still rescue it. Don't let one flaky request block submission.
    console.warn("[VerifyAssets] ListAssets check failed:", e.message);
    return body;
  }

  const userHash = getUserHash(req);
  for (const id of idsToCheck) {
    if (liveIds.has(id)) {
      _verifiedAssetIds.add(id);
      continue;
    }
    // Missing upstream — downgrade local row and re-whitelist with the same storage_url.
    const oldAssetUrl = "asset://" + id;
    const local = findAssetByAssetId(userHash, oldAssetUrl);
    if (!local || !local.storage_url) {
      // No local record to recover from; leave the body alone and let upstream complain.
      console.warn(`[VerifyAssets] ${id} missing upstream + no local row to re-create`);
      continue;
    }
    console.log(`[VerifyAssets] ${id} missing upstream, re-creating from ${local.storage_url}`);
    updateAssetStatus(local.id, userHash, { assetId: null, assetStatus: "pending" });
    try {
      const assetType = local.type === "video" ? "Video" : local.type === "audio" ? "Audio" : "Image";
      const newVolcId = await serverCreateAsset(req, local.storage_url, local.name, assetType);
      const newAssetUrl = "asset://" + newVolcId;
      updateAssetStatus(local.id, userHash, { assetId: newAssetUrl, assetStatus: "ready" });
      _verifiedAssetIds.add(newVolcId);
      for (const s of idToSlots.get(id)) s.set(newAssetUrl);
      console.log(`[VerifyAssets] ${id} → ${newAssetUrl}`);
    } catch (e) {
      console.warn(`[VerifyAssets] Re-create failed for ${id}:`, e.message);
      updateAssetStatus(local.id, userHash, { assetId: null, assetStatus: "failed" });
      // Fall back to raw storage_url so PrivacyInformation auto-retry can pick it up.
      for (const s of idToSlots.get(id)) s.set(local.storage_url);
    }
  }
  return body;
}

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
    await execFileAsync("ffmpeg", [
      "-y", "-ss", "0", "-i", inputPath,
      "-frames:v", "1", "-q:v", "3", "-vf", "scale='min(640,iw)':-2",
      outputPath,
    ], { timeout: 30000 });

    const useTos = sourceUrl.includes(".volces.com");
    const key = `thumbs/${asset.id}_${Date.now()}.jpg`;
    let thumbUrl;
    if (useTos && TOS_AK && TOS_SK) {
      const presign = tosPresignPut(key, "image/jpeg");
      const body = readFileSync(outputPath);
      const upResp = await fetch(presign.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body });
      if (!upResp.ok) throw new Error(`TOS thumb upload ${upResp.status}`);
      thumbUrl = presign.fileUrl;
    } else {
      await new Promise((resolve, reject) => {
        cos.putObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: key, Body: createReadStream(outputPath), ContentType: "image/jpeg" }, (err) => err ? reject(err) : resolve());
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
    console.log(`[AssetSync] Upstream=${upstreamByUrl.size} reconciled=${reconciled}`);
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

// Register a new asset
app.post("/api/assets", (req, res) => {
  try {
    const userHash = getUserHash(req);
    const { name, type, storageUrl, thumbUrl, contentHash } = req.body;
    if (!storageUrl) return res.status(400).json({ error: "storageUrl required" });
    const asset = insertAsset({ userHash, name, type, storageUrl, thumbUrl, contentHash });
    res.json({ asset });
  } catch (err) {
    res.status(err.message === "API Key is required" ? 401 : 500).json({ error: err.message });
  }
});

// Lookup asset by content hash (for dedup before upload)
app.get("/api/assets/by-hash/:hash", (req, res) => {
  try {
    const userHash = getUserHash(req);
    const asset = findAssetByHash(userHash, req.params.hash);
    // Treat stale uploads/ URLs as invalid (daily cleanup wipes them)
    if (asset && asset.storage_url && asset.storage_url.includes("/uploads/")) {
      return res.json({ asset: null });
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
    updateAssetStatus(id, userHash, { assetId: null, assetStatus: "pending" });
    try {
      const assetType = asset.type === "video" ? "Video" : asset.type === "audio" ? "Audio" : "Image";
      const volcId = await serverCreateAsset(req, asset.storage_url, asset.name, assetType);
      const updated = updateAssetStatus(id, userHash, {
        assetId: "asset://" + volcId, assetStatus: "ready",
      });
      console.log(`[Whitelist] Asset ${id} ready: asset://${volcId}`);
      res.json({ asset: updated });
    } catch (volcErr) {
      console.error(`[Whitelist] Asset ${id} failed:`, volcErr.message);
      const updated = updateAssetStatus(id, userHash, {
        assetId: null, assetStatus: "failed",
      });
      res.json({ asset: updated, error: volcErr.message });
    }
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
    const { storageUrls, items } = req.body;
    if (!Array.isArray(storageUrls)) return res.status(400).json({ error: "storageUrls array required" });
    const meta = new Map();
    if (Array.isArray(items)) {
      for (const it of items) {
        if (it && typeof it.url === "string") meta.set(it.url, it);
      }
    }
    const results = {};
    const errors = {};
    for (const url of storageUrls) {
      const existing = findAssetByUrl(userHash, url);
      if (existing?.asset_status === "ready" && existing.asset_id) {
        results[url] = existing.asset_id;
        continue;
      }
      const hint = meta.get(url) || {};
      const name = existing?.name || hint.name || deriveNameFromUrl(url);
      const contentHash = hint.contentHash || undefined;
      const hintType = hint.type || "image";
      const row = existing || insertAsset({ userHash, name, type: hintType, storageUrl: url, thumbUrl: "", contentHash });
      // insertAsset may have returned an older record (hash-matched) that's already whitelisted.
      // Reuse its asset_id instead of burning another Volc call.
      if (row.asset_status === "ready" && row.asset_id) {
        results[url] = row.asset_id;
        continue;
      }
      const assetType = (row.type || hintType) === "video" ? "Video" : (row.type || hintType) === "audio" ? "Audio" : "Image";
      try {
        const volcId = await serverCreateAsset(req, url, name, assetType);
        updateAssetStatus(row.id, userHash, { assetId: "asset://" + volcId, assetStatus: "ready" });
        results[url] = "asset://" + volcId;
      } catch (e) {
        console.warn("[BulkWhitelist] Failed for", url, e.message);
        updateAssetStatus(row.id, userHash, { assetId: null, assetStatus: "failed" });
        results[url] = null;
        errors[url] = e.message;
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

// ── Daily Cleanup: 4am Beijing time (20:00 UTC previous day) ──
function clearBucket() {
  console.log("[COS Cleanup] Starting bucket cleanup...");
  cos.getBucket(
    { Bucket: COS_BUCKET, Region: COS_REGION, Prefix: "uploads/", MaxKeys: 1000 },
    (err, data) => {
      if (err) {
        console.error("[COS Cleanup] List error:", err);
        return;
      }
      const objects = (data.Contents || []).map((item) => ({ Key: item.Key }));
      if (objects.length === 0) {
        console.log("[COS Cleanup] Bucket already empty.");
        return;
      }
      cos.deleteMultipleObject(
        {
          Bucket: COS_BUCKET,
          Region: COS_REGION,
          Objects: objects,
        },
        (delErr) => {
          if (delErr) {
            console.error("[COS Cleanup] Delete error:", delErr);
          } else {
            console.log(`[COS Cleanup] Deleted ${objects.length} objects.`);
            // If there were 1000 objects, there might be more — run again
            if (objects.length >= 1000) clearBucket();
          }
        }
      );
    }
  );
}

function scheduleDailyCleanup() {
  const now = new Date();
  // 4:00 AM Beijing = UTC+8, so 20:00 UTC previous day
  const target = new Date(now);
  target.setUTCHours(20, 0, 0, 0); // 20:00 UTC = 04:00 Beijing next day
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);

  const delay = target - now;
  console.log(`[COS Cleanup] Next cleanup in ${Math.round(delay / 60000)} minutes`);

  setTimeout(() => {
    clearBucket();
    // After first run, repeat every 24 hours
    setInterval(clearBucket, 24 * 60 * 60 * 1000);
  }, delay);
}

scheduleDailyCleanup();

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

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
