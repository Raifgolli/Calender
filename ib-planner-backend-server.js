"use strict";
const path = require("path");
const fs = require("fs");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const cfg = require("./config");
require("./db"); // opens SQLite + applies schema.sql
const { errorHandler, notFoundHandler } = require("./middleware");
const auth = require("./routes/auth");
const data = require("./routes/data");
const tokens = require("./lib/tokens");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

/* ------------------------------------------------------------------ security */
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'"], // the app ships one inline script; drop this once you move it to /js/app.js
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "blob:"],
      "connect-src": ["'self'"].concat(cfg.corsOrigins),
      "font-src": ["'self'", "data:"],
      "object-src": ["'none'"],
      "frame-ancestors": ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

if (cfg.corsOrigins.length) {
  app.use(cors({
    origin: (origin, cb) => (!origin || cfg.corsOrigins.includes(origin)) ? cb(null, true) : cb(new Error("Origin not allowed")),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400
  }));
}

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

/* -------------------------------------------------------------------- routes */
app.get("/api/health", (req, res) => res.json({ ok: true, service: "ib-planner", env: cfg.env, time: new Date().toISOString() }));
app.use("/api/auth", auth.router);
data.mount(app);

/* ------------------------------------------------------------ static frontend */
if (fs.existsSync(cfg.publicDir)) {
  app.use(express.static(cfg.publicDir, { extensions: ["html"], maxAge: cfg.isProd ? "1h" : 0 }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(cfg.publicDir, "index.html")));
} else {
  console.warn(`[ibplanner] frontend not found at ${cfg.publicDir} — API only.`);
}

app.use(notFoundHandler);
app.use(errorHandler(cfg));

/* --------------------------------------------------------------------- boot */
tokens.purgeExpired();
setInterval(() => tokens.purgeExpired(), 6 * 3600 * 1000).unref?.();

const server = app.listen(cfg.port, () => {
  console.log(`\n  IB Planner API  →  http://localhost:${cfg.port}`);
  console.log(`  env: ${cfg.env}   db: ${cfg.databaseFile}`);
  console.log(`  frontend: ${fs.existsSync(cfg.publicDir) ? cfg.publicDir : "(not found)"}\n`);
});

const shutdown = (sig) => () => {
  console.log(`[ibplanner] ${sig} received — closing server.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGINT", shutdown("SIGINT"));
process.on("SIGTERM", shutdown("SIGTERM"));

module.exports = app;