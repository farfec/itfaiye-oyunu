// İtfaiye Şefi sunucusu: oyunu yayınlar, oyuncu hesabı ve bulut kaydı tutar, liderlik tablosu verir.
const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");

const CITIES = ["ankara", "istanbul", "izmir"];
const PORT = process.env.PORT || 3000;
const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error("DATABASE_URL tanımlı değil. README.md dosyasındaki 2. adıma bakın.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DB,
  ssl: /localhost|127\.0\.0\.1/.test(DB) ? false : { rejectUnauthorized: false },
});

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));

// Mobil uygulama (Capacitor) farklı bir kökenden istek atacağı için API'ye CORS izni.
// Kimlik doğrulama çerezle değil Authorization başlığıyla yapıldığından bu güvenlidir.
app.use("/api", (req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");

// Basit hız sınırı (bellek içi)
const hits = new Map();
function limit(key, max, ms) {
  const now = Date.now();
  const a = (hits.get(key) || []).filter((t) => now - t < ms);
  if (a.length >= max) { hits.set(key, a); return false; }
  a.push(now); hits.set(key, a); return true;
}
setInterval(() => hits.clear(), 3600 * 1000);

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS players(
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    state JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
}

const auth = async (req, res, next) => {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!t) return res.status(401).json({ error: "token" });
  const r = await pool.query("SELECT id,name,state,updated_at FROM players WHERE token_hash=$1", [sha(t)]);
  if (!r.rows.length) return res.status(401).json({ error: "token" });
  req.player = r.rows[0];
  next();
};

// Gelen kaydı temizler ve makul sınırlar içinde tutar.
// Not: oyun şimdilik istemcide çalışıyor, bu yüzden bu sadece kaba bir hile önlemidir.
function clean(old, inc, elapsed) {
  const first = Object.keys(old).length === 0;
  const maxUp = first ? 200 : Math.floor(elapsed / 1.5) + 10;
  const num = (v, lo, hi, d) => {
    v = Math.floor(Number(v));
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  };
  const out = {};
  for (const id of CITIES) {
    const o = old[id] || {};
    const n = inc[id];
    if (!n && !o.done) continue;
    const prevDone = num(o.done, 0, 1e6, 0);
    const wantDone = num(n && n.done, 0, 1e6, prevDone);
    out[id] = {
      gold: num(n && n.gold, 0, 1e7, o.gold || 0),
      done: Math.max(prevDone, Math.min(wantDone, prevDone + maxUp)),
      cmd: num(n && n.cmd, 1, 4, 1),
      pump: num(n && n.pump, 0, 50, 0),
      eng: num(n && n.eng, 0, 50, 0),
      nt: num(n && n.nt, 1, 30, 1),
    };
  }
  return out;
}

app.get("/api/ping", (req, res) => res.json({ ok: true }));

app.post("/api/register", ah(async (req, res) => {
  if (!limit("reg:" + req.ip, 5, 3600 * 1000)) return res.status(429).json({ error: "cok fazla" });
  const name = String((req.body || {}).name || "").replace(/[<>&]/g, "").trim().slice(0, 16);
  if (name.length < 2) return res.status(400).json({ error: "isim" });
  const token = crypto.randomBytes(24).toString("hex");
  await pool.query("INSERT INTO players(name,token_hash) VALUES($1,$2)", [name, sha(token)]);
  res.json({ token, name });
}));

app.get("/api/me", ah(auth), (req, res) => {
  res.json({ name: req.player.name, state: req.player.state });
});

app.put("/api/save", ah(auth), ah(async (req, res) => {
  if (!limit("sv:" + req.player.id, 20, 60 * 1000)) return res.status(429).json({ error: "hiz" });
  const elapsed = Math.min(86400, (Date.now() - new Date(req.player.updated_at).getTime()) / 1000);
  const state = clean(req.player.state || {}, (req.body || {}).state || {}, elapsed);
  await pool.query("UPDATE players SET state=$1, updated_at=now() WHERE id=$2", [state, req.player.id]);
  res.json({ ok: true });
}));

app.get("/api/leaderboard", ah(auth), ah(async (req, res) => {
  const city = CITIES.includes(req.query.city) ? req.query.city : "ankara";
  const r = await pool.query(
    `SELECT id, name, (state->$1::text->>'done')::int AS done
     FROM players WHERE (state->$1::text->>'done')::int > 0
     ORDER BY done DESC LIMIT 20`, [city]);
  res.json({ rows: r.rows.map((x) => ({ name: x.name, done: x.done, me: x.id === req.player.id })) });
}));

app.use(express.static(path.join(__dirname, "public")));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "sunucu" });
});

init()
  .then(() => app.listen(PORT, () => console.log("İtfaiye Şefi sunucusu çalışıyor, port " + PORT)))
  .catch((e) => { console.error(e); process.exit(1); });
