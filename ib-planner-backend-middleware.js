"use strict";
const { ApiError, unauthorized, tooMany } = require("./lib/errors");
const tokens = require("./lib/tokens");
const { db } = require("./db");

/** Wraps async route handlers so rejections reach the error handler. */
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Small in-process rate limiter (per IP + bucket). Swap for a Redis store when you scale out. */
function rateLimit({ windowMs = 60000, max = 30, bucket = "default", keyBy = (req) => req.ip } = {}) {
  const hits = new Map();
  setInterval(() => {
    const cut = Date.now() - windowMs;
    for (const [k, v] of hits) if (v.start < cut) hits.delete(k);
  }, windowMs).unref?.();

  return function (req, res, next) {
    const key = `${bucket}:${keyBy(req)}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) entry = { start: now, count: 0 }, hits.set(key, entry);
    entry.count += 1;
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, max - entry.count));
    if (entry.count > max) {
      res.setHeader("Retry-After", Math.ceil((entry.start + windowMs - now) / 1000));
      return next(tooMany());
    }
    next();
  };
}

/** Loads the authenticated user row from the access token. */
const loadUser = db.prepare("SELECT * FROM users WHERE id = ?");

function requireAuth(req, res, next) {
  try {
    const header = req.get("authorization") || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const cookieTok = req.cookies && req.cookies.ibp_access;
    const token = bearer || cookieTok;
    if (!token) throw unauthorized("Please log in to continue.");
    const payload = tokens.verifyAccess(token);
    const user = loadUser.get(payload.sub);
    if (!user) throw unauthorized("Your account is no longer available.");
    req.user = publicUser(user);
    next();
  } catch (e) {
    next(e);
  }
}

/** Shape sent to the client — never includes password_hash. */
function publicUser(row) {
  return {
    id: row.id, email: row.email, name: row.name, year: row.year,
    onboarded: !!row.onboarded, revision: row.revision, createdAt: row.created_at
  };
}

function notFoundHandler(req, res, next) {
  if (req.path.startsWith("/api/")) return next(new ApiError(404, "not_found", `No API route for ${req.method} ${req.path}`));
  next();
}

/** Single place where errors become responses; internal details never leak in production. */
function errorHandler(cfg) {
  // eslint-disable-next-line no-unused-vars
  return function (err, req, res, next) {
    const isApi = new ApiError(0, "", "");
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details || undefined } });
    }
    if (err && err.type === "entity.parse.failed") {
      return res.status(400).json({ error: { code: "bad_json", message: "Request body is not valid JSON." } });
    }
    if (err && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: { code: "conflict", message: "That record already exists." } });
    }
    console.error("[ibplanner] unhandled error:", err && err.stack ? err.stack : err);
    res.status(500).json({
      error: {
        code: "server_error",
        message: "Something went wrong on our side. Please try again.",
        details: cfg.isProd ? undefined : String((err && err.message) || err)
      }
    });
  };
}

module.exports = { asyncH, requireAuth, rateLimit, notFoundHandler, errorHandler, publicUser };