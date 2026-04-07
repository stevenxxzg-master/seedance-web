import express from "express";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import COS from "cos-nodejs-sdk-v5";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { createReadStream, readFileSync, unlinkSync, mkdirSync } from "fs";
import { createRequire } from "module";
import multer from "multer";
import os from "os";

const require = createRequire(import.meta.url);

const execFileAsync = promisify(execFile);

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (origin.includes("anyfast.com.cn") || origin.includes("anyfast.ai"))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Api-Key,X-Storage,Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: "50mb" }));

// Only serve index.html, not the whole directory (protects .env)
app.get("/", (_req, res) => res.sendFile(join(__dirname, "index.html")));
app.get("/zh", (_req, res) => res.sendFile(join(__dirname, "index-zh.html")));

const API_BASE = process.env.API_BASE_URL || "https://www.example.com";

function getKey(req) {
  const key = req.headers["x-api-key"];
  if (!key) throw new Error("API Key is required");
  return key;
}

function getBase(req) {
  const base = req.headers["x-api-base"] || API_BASE;
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
    const resp = await fetch(`${getBase(req)}/v1/video/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getKey(req)}`,
      },
      body: JSON.stringify(req.body),
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

// Get presigned upload URL — frontend uploads directly to COS
// /api/presign — alias that also supports X-Storage: tos
app.post("/api/presign", (req, res, next) => { req.url = "/api/cos/presign"; next(); });
app.post("/api/cos/presign", (req, res) => {
  const { filename, contentType, prefix } = req.body;
  if (!filename || !contentType) {
    return res.status(400).json({ error: "filename and contentType required" });
  }

  const pfx = prefix || "uploads";
  const ext = filename.split(".").pop() || "bin";
  const key = `${pfx}/${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;

  // TOS mode via X-Storage header
  if (req.headers["x-storage"] === "tos" && TOS_AK && TOS_SK) {
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
    const useTos = req.headers["x-storage"] === "tos";
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
  const useTos = req.headers["x-storage"] === "tos";
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

// ── Volcengine Asset API (server-side AK/SK from env) ──
const VOLC_VERSION = "2024-01-01";
const VOLC_AK = process.env.VOLC_AK;
const VOLC_SK = process.env.VOLC_SK;

const volcService = VOLC_AK && VOLC_SK
  ? new (require("@volcengine/openapi").Service)({
      host: "open.volcengineapi.com",
      serviceName: "ark",
      region: "cn-beijing",
      accessKeyId: VOLC_AK,
      secretKey: VOLC_SK,
      defaultVersion: VOLC_VERSION,
    })
  : null;

const ALLOWED_ASSET_ACTIONS = new Set([
  "CreateAssetGroup", "CreateAsset", "ListAssetGroups", "ListAssets",
  "GetAsset", "GetAssetGroup", "UpdateAssetGroup", "UpdateAsset",
]);

app.post("/api/asset/:action", async (req, res) => {
  if (!volcService) return res.status(503).json({ error: "Asset API not configured" });

  const { action } = req.params;
  if (!ALLOWED_ASSET_ACTIONS.has(action)) {
    return res.status(400).json({ error: "Invalid action" });
  }

  try {
    const api = volcService.createJSONAPI(action, { Version: VOLC_VERSION, method: "POST" });
    const data = await api(req.body);
    if (data?.ResponseMetadata?.Error) {
      return res.status(400).json(data);
    }
    res.json(data);
  } catch (err) {
    console.error(`Asset API ${action} error:`, err);
    res.status(502).json({ error: err.message });
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
