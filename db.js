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
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_hash);
  CREATE INDEX IF NOT EXISTS idx_assets_url ON assets(storage_url);
`);

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

const stmtInsert = db.prepare(`
  INSERT INTO assets (user_hash, name, type, storage_url, thumb_url)
  VALUES (?, ?, ?, ?, ?)
`);
const stmtGetById = db.prepare("SELECT * FROM assets WHERE id = ?");
export function insertAsset({ userHash, name, type, storageUrl, thumbUrl }) {
  const existing = findAssetByUrl(userHash, storageUrl);
  if (existing) return existing;
  const info = stmtInsert.run(userHash, name || "", type || "image", storageUrl, thumbUrl || "");
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
