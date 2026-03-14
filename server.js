import express from "express";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "50mb" }));

// Only serve index.html, not the whole directory (protects .env)
app.get("/", (_req, res) => res.sendFile(join(__dirname, "index.html")));

const API_BASE = process.env.API_BASE_URL || "https://www.example.com";

function getKey(req) {
  const key = req.headers["x-api-key"];
  if (!key) throw new Error("API Key is required");
  return key;
}

function getBase(req) {
  return req.headers["x-api-base"] || API_BASE;
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

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3456;
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
