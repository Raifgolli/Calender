// ===== backend/src/config.js =====
"use strict";
require("dotenv").config();
const path = require("path");

const bool = (v, d) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => (v === undefined || v === "" ? d : Number.parseInt(v, 10) || d);

const cfg = {
  env: process.env.NODE_ENV || "development",
  port: int(process.env.PORT, 4000),
  publicDir: path.resolve(__dirname, "..", process.env.PUBLIC_DIR || "../frontend/public"),
  databaseFile: path.resolve(__dirname, "..", process.env.DATABASE_FILE || "./data/ibplanner.db"),
  jwtSecret: process.env.JWT_SECRET || "",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "15m",
  refreshDays: int(process.env.REFRESH_DAYS, 30),
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  corsOrigins: (process.env.CORS_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean),
  appUrl: process.env.APP_URL || "http://localhost:4000",
  mailFrom: process.env.MAIL_FROM || "IB Planner <no-reply@ibplanner.local>",
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || ""
  },
  devExposeResetToken: bool(process.env.DEV_EXPOSE_RESET_TOKEN, false)
};

cfg.isProd = cfg.env === "production";

// fail fast on misconfiguration rather than running with a guessable secret
if (!cfg.jwtSecret || cfg.jwtSecret.length < 32) {
  if (cfg.isProd) throw new Error("JWT_SECRET must be set to at least 32 characters in production.");
  cfg.jwtSecret = "dev-only-insecure-secret-please-set-JWT_SECRET-env-var";
  console.warn("[ibplanner] JWT_SECRET missing/short — using an insecure development fallback.");
}
if (cfg.isProd && !cfg.cookieSecure) console.warn("[ibplanner] COOKIE_SECURE=false in production — set it to true when serving over HTTPS.");

module.exports = cfg;

// ===== backend/src/db/schema.sql =====
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  year          TEXT NOT NULL DEFAULT 'DP1' CHECK (year IN ('DP1','DP2')),
  password_hash TEXT NOT NULL,
  onboarded     INTEGER NOT NULL DEFAULT 0,
  revision      INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS password_resets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reset_user ON password_resets(user_id);

CREATE TABLE IF NOT EXISTS subjects (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  group_no   INTEGER,
  level      TEXT CHECK (level IN ('HL','SL') OR level IS NULL),
  teacher    TEXT,
  class_times TEXT,
  color      TEXT,
  position   INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS tasks (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id           TEXT NOT NULL,
  title        TEXT NOT NULL,
  type         TEXT,
  subject_id   TEXT,
  due          TEXT,
  est          INTEGER,
  priority     TEXT,
  difficulty   INTEGER,
  notes        TEXT,
  done         INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  ia_id        TEXT,
  ee_plan      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(user_id, due);

CREATE TABLE IF NOT EXISTS events (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  title      TEXT NOT NULL,
  type       TEXT,
  subject_id TEXT,
  task_id    TEXT,
  date       TEXT NOT NULL,
  start_time TEXT,
  end_time   TEXT,
  auto       INTEGER NOT NULL DEFAULT 0,
  locked     INTEGER NOT NULL DEFAULT 0,
  manual     INTEGER NOT NULL DEFAULT 0,
  done       INTEGER NOT NULL DEFAULT 0,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(user_id, date);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(user_id, task_id);

CREATE TABLE IF NOT EXISTS ia_projects (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id               TEXT NOT NULL,
  title            TEXT NOT NULL,
  subject_id       TEXT,
  research_question TEXT,
  due              TEXT,
  progress         INTEGER DEFAULT 0,
  status           TEXT,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS ee_projects (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  research_question TEXT,
  supervisor TEXT,
  subject    TEXT,
  progress   INTEGER DEFAULT 0,
  notes      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ee_milestones (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id      TEXT NOT NULL,
  title   TEXT NOT NULL,
  due     TEXT,
  done    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS cas_activities (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  category   TEXT NOT NULL CHECK (category IN ('Creativity','Activity','Service')),
  title      TEXT NOT NULL,
  date       TEXT,
  hours      REAL DEFAULT 0,
  reflection TEXT,
  status     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS settings (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme              TEXT NOT NULL DEFAULT 'dark',
  week_start         INTEGER NOT NULL DEFAULT 1,
  default_cal_view   TEXT NOT NULL DEFAULT 'month',
  notify_deadlines   INTEGER NOT NULL DEFAULT 1,
  notify_planner     INTEGER NOT NULL DEFAULT 1,
  dense              INTEGER NOT NULL DEFAULT 0,
  max_hours_per_day  REAL NOT NULL DEFAULT 3,
  session_length     INTEGER NOT NULL DEFAULT 50,
  break_length       INTEGER NOT NULL DEFAULT 10,
  preferred          TEXT NOT NULL DEFAULT 'any',
  exam_buffer        INTEGER NOT NULL DEFAULT 5,
  project_buffer     INTEGER NOT NULL DEFAULT 10,
  horizon            INTEGER NOT NULL DEFAULT 35,
  start_time         TEXT NOT NULL DEFAULT '16:30',
  availability_json  TEXT,
  plan_json          TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS planner_plans (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sessions   INTEGER NOT NULL DEFAULT 0,
  minutes    INTEGER NOT NULL DEFAULT 0,
  payload    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_plans_user ON planner_plans(user_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);

// ===== backend/src/db/index.js =====
"use strict";
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const cfg = require("../config");

const dir = path.dirname(cfg.databaseFile);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(cfg.databaseFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(sql);
  // forward-only migrations go here, e.g.
  // if (!columnExists("users", "email_verified")) db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  return true;
}
migrate();

const tx = (fn) => db.transaction(fn);
const prepare = (sql) => db.prepare(sql);

module.exports = { db, prepare, tx, migrate, dir };