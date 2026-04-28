import Database from "better-sqlite3";
import crypto from "crypto";
import { mkdirSync } from "fs";
import { dirname } from "path";

const DB_PATH = process.env.DB_PATH || "./data/assets.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_hash TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'image',
    storage_url TEXT NOT NULL,
    asset_id TEXT DEFAULT NULL,
    asset_status TEXT NOT NULL DEFAULT 'none',
    thumb_url TEXT DEFAULT '',
    content_hash TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_hash);
  CREATE INDEX IF NOT EXISTS idx_assets_url ON assets(storage_url);
`);

// Migrate existing tables to add content_hash column
try {
  const cols = db.prepare("PRAGMA table_info(assets)").all();
  if (!cols.some((c) => c.name === "content_hash")) {
    db.exec("ALTER TABLE assets ADD COLUMN content_hash TEXT DEFAULT NULL");
  }
} catch (e) {
  console.warn("[DB] Migration check failed:", e.message);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(user_hash, content_hash)");

export function hashApiKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

const stmtList = db.prepare(
  "SELECT * FROM assets WHERE user_hash = ? ORDER BY created_at DESC"
);
export function listAssets(userHash) {
  return stmtList.all(userHash);
}

const stmtFindByUrl = db.prepare(
  "SELECT * FROM assets WHERE user_hash = ? AND storage_url = ? LIMIT 1"
);
export function findAssetByUrl(userHash, storageUrl) {
  return stmtFindByUrl.get(userHash, storageUrl) || null;
}

const stmtFindByHash = db.prepare(
  "SELECT * FROM assets WHERE user_hash = ? AND content_hash = ? LIMIT 1"
);
export function findAssetByHash(userHash, contentHash) {
  if (!contentHash) return null;
  return stmtFindByHash.get(userHash, contentHash) || null;
}

const stmtFindByAssetId = db.prepare(
  "SELECT * FROM assets WHERE user_hash = ? AND asset_id = ? LIMIT 1"
);
export function findAssetByAssetId(userHash, assetId) {
  if (!assetId) return null;
  return stmtFindByAssetId.get(userHash, assetId) || null;
}

const stmtInsert = db.prepare(`
  INSERT INTO assets (user_hash, name, type, storage_url, thumb_url, content_hash)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const stmtUpdateUrl = db.prepare(`
  UPDATE assets SET storage_url = ?, name = ?, updated_at = unixepoch()
  WHERE id = ? AND user_hash = ?
`);
const stmtGetById = db.prepare("SELECT * FROM assets WHERE id = ?");
export function insertAsset({ userHash, name, type, storageUrl, thumbUrl, contentHash }) {
  // 1. Hash-based dedup (preferred)
  if (contentHash) {
    const existing = findAssetByHash(userHash, contentHash);
    if (existing) {
      // If stored URL is stale (points to /uploads/ which gets cleaned daily),
      // refresh it with the new storage_url
      if (existing.storage_url && existing.storage_url.includes("/uploads/")) {
        stmtUpdateUrl.run(storageUrl, name || existing.name, existing.id, userHash);
        return stmtGetById.get(existing.id);
      }
      return existing;
    }
  }
  // 2. URL-based dedup (fallback for legacy records without hash)
  const byUrl = findAssetByUrl(userHash, storageUrl);
  if (byUrl) return byUrl;
  // 3. Insert new
  const info = stmtInsert.run(
    userHash, name || "", type || "image", storageUrl, thumbUrl || "", contentHash || null
  );
  return stmtGetById.get(info.lastInsertRowid);
}

const stmtUpdateStatus = db.prepare(`
  UPDATE assets SET asset_id = ?, asset_status = ?, updated_at = unixepoch()
  WHERE id = ? AND user_hash = ?
`);
export function updateAssetStatus(id, userHash, { assetId, assetStatus }) {
  stmtUpdateStatus.run(assetId || null, assetStatus, id, userHash);
  return stmtGetById.get(id);
}

const stmtUpdateThumb = db.prepare(`
  UPDATE assets SET thumb_url = ?, updated_at = unixepoch() WHERE id = ?
`);
export function updateAssetThumb(id, thumbUrl) {
  stmtUpdateThumb.run(thumbUrl, id);
  return stmtGetById.get(id);
}

export function getAssetById(id) {
  return stmtGetById.get(id);
}

const stmtDelete = db.prepare(
  "DELETE FROM assets WHERE id = ? AND user_hash = ?"
);
export function deleteAsset(id, userHash) {
  return stmtDelete.run(id, userHash);
}

// ── User Preferences ──
db.exec(`
  CREATE TABLE IF NOT EXISTS user_prefs (
    user_hash TEXT PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

const stmtGetPrefs = db.prepare("SELECT data FROM user_prefs WHERE user_hash = ?");
export function getPrefs(userHash) {
  const row = stmtGetPrefs.get(userHash);
  if (!row) return {};
  try { return JSON.parse(row.data); } catch { return {}; }
}

const stmtUpsertPrefs = db.prepare(`
  INSERT INTO user_prefs (user_hash, data, updated_at) VALUES (?, ?, unixepoch())
  ON CONFLICT(user_hash) DO UPDATE SET data = excluded.data, updated_at = unixepoch()
`);
export function setPrefs(userHash, prefs) {
  stmtUpsertPrefs.run(userHash, JSON.stringify(prefs));
}

export default db;
