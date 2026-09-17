// ===== backend/src/lib/errors.js =====
"use strict";
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const bad = (m, d) => new ApiError(400, "bad_request", m, d);
const unauthorized = (m = "Authentication required.") => new ApiError(401, "unauthorized", m);
const forbidden = (m = "Not allowed.") => new ApiError(403, "forbidden", m);
const notFound = (m = "Not found.") => new ApiError(404, "not_found", m);
const conflict = (m, d) => new ApiError(409, "conflict", m, d);
const tooMany = (m = "Too many requests. Please try again later.") => new ApiError(429, "rate_limited", m);

module.exports = { ApiError, bad, unauthorized, forbidden, notFound, conflict, tooMany };

// ===== backend/src/lib/password.js =====
"use strict";
const crypto = require("crypto");
const { promisify } = require("util");
const scrypt = promisify(crypto.scrypt);

const N = 16384, r = 8, p = 1, KEYLEN = 64, SALTLEN = 16;

/** Hash a plaintext password. Never store or log the input. */
async function hashPassword(plain) {
  if (typeof plain !== "string" || plain.length < 8) throw new Error("Password must be at least 8 characters.");
  const salt = crypto.randomBytes(SALTLEN);
  const key = await scrypt(plain, salt, KEYLEN, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", N, r, p, salt.toString("base64"), key.toString("base64")].join("$");
}

/** Constant-time verify. Returns false for malformed/unknown hashes. */
async function verifyPassword(plain, stored) {
  try {
    if (typeof plain !== "string" || typeof stored !== "string") return false;
    const [scheme, n, rr, pp, saltB64, hashB64] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = await scrypt(plain, salt, expected.length, {
      N: Number(n), r: Number(rr), p: Number(pp), maxmem: 64 * 1024 * 1024
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Random opaque token (returned once to the client, never stored raw). */
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
/** Deterministic SHA-256 used for at-rest storage and indexed lookup of tokens. */
const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const newId = () => crypto.randomBytes(12).toString("base64url");

module.exports = { hashPassword, verifyPassword, randomToken, hashToken, newId };

// ===== backend/src/lib/tokens.js =====
"use strict";
const jwt = require("jsonwebtoken");
const cfg = require("../config");
const { randomToken, hashToken, newId } = require("./password");
const { unauthorized, notFound } = require("./errors");
const { db, prepare } = require("../db");

const q = {
  insertRefresh: prepare(
    "INSERT INTO refresh_tokens (id,user_id,token_hash,user_agent,expires_at) VALUES (?,?,?,?,?)"
  ),
  findRefresh: prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?"),
  revoke: prepare("UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE id = ?"),
  revokeUser: prepare("UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL"),
  purgeExpired: prepare("DELETE FROM refresh_tokens WHERE expires_at < datetime('now') OR revoked_at IS NOT NULL")
};

function signAccess(user) {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name, year: user.year }, cfg.jwtSecret, {
    expiresIn: cfg.jwtExpiresIn,
    issuer: "ib-planner"
  });
}

function verifyAccess(token) {
  try {
    return jwt.verify(token, cfg.jwtSecret, { issuer: "ib-planner" });
  } catch {
    throw unauthorized("Your session has expired. Please log in again.");
  }
}

/** Issues a refresh token; only its hash is persisted. */
function issueRefresh(userId, userAgent) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + cfg.refreshDays * 864e5).toISOString().replace("T", " ").slice(0, 19);
  q.insertRefresh.run(newId(), userId, hashToken(token), String(userAgent || "").slice(0, 200), expires);
  return { token, expiresAt: expires };
}

/** Verifies + rotates: the presented token is revoked and a fresh one returned. */
function rotateRefresh(presented, userAgent) {
  if (!presented) throw unauthorized("Missing refresh token.");
  const row = q.findRefresh.get(hashToken(presented));
  if (!row || row.revoked_at) {
    if (row && row.revoked_at) q.revokeUser.run(row.user_id); // reuse detected -> kill the chain
    throw unauthorized("Refresh token is no longer valid.");
  }
  if (new Date(row.expires_at.replace(" ", "T") + "Z") < new Date()) {
    q.revoke.run(row.id);
    throw unauthorized("Refresh token has expired.");
  }
  q.revoke.run(row.id);
  const next = issueRefresh(row.user_id, userAgent);
  return { userId: row.user_id, ...next };
}

function revokeRefresh(presented) {
  if (!presented) return;
  const row = q.findRefresh.get(hashToken(presented));
  if (row) q.revoke.run(row.id);
}

function revokeAllForUser(userId) {
  q.revokeUser.run(userId);
}

function createResetToken(userId, minutes = 30) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + minutes * 60000).toISOString().replace("T", " ").slice(0, 19);
  prepare("INSERT INTO password_resets (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)").run(
    newId(), userId, hashToken(token), expires
  );
  return { token, expiresAt: expires };
}

function consumeResetToken(token) {
  const row = prepare("SELECT * FROM password_resets WHERE token_hash = ?").get(hashToken(token || ""));
  if (!row || row.used_at) throw notFound("This reset link is invalid or has already been used.");
  if (new Date(row.expires_at.replace(" ", "T") + "Z") < new Date()) throw notFound("This reset link has expired. Request a new one.");
  prepare("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?").run(row.id);
  // invalidating all sessions after a reset is the safe default
  revokeAllForUser(row.user_id);
  return row.user_id;
}

module.exports = {
  signAccess, verifyAccess, issueRefresh, rotateRefresh, revokeRefresh, revokeAllForUser,
  createResetToken, consumeResetToken, purgeExpired: () => q.purgeExpired.run()
};

// ===== backend/src/lib/validate.js =====
"use strict";
const { bad } = require("./errors");

const EMAIL = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

/**
 * Minimal declarative validator.
 * spec: { field: {type:'string'|'email'|'date'|'time'|'int'|'number'|'bool'|'enum'|'id', required, min, max, enum, default} }
 */
function check(input, spec, { partial = false } = {}) {
  const src = input && typeof input === "object" ? input : {};
  const out = {};
  const errors = {};

  for (const [key, rule] of Object.entries(spec)) {
    const present = Object.prototype.hasOwnProperty.call(src, key);
    let value = present ? src[key] : undefined;

    if (value === undefined || value === null || value === "") {
      if (present && value === null && rule.nullable) { out[key] = null; continue; }
      if (partial && !present) continue;
      if (rule.required && !partial) { errors[key] = "This field is required."; continue; }
      if (rule.default !== undefined && present === false) { out[key] = rule.default; continue; }
      if (present) { out[key] = rule.nullable ? null : rule.type === "bool" ? false : undefined; }
      continue;
    }

    switch (rule.type) {
      case "string": {
        if (typeof value !== "string") { errors[key] = "Must be text."; break; }
        value = value.trim();
        if (rule.max && value.length > rule.max) { errors[key] = `Must be at most ${rule.max} characters.`; break; }
        if (rule.min && value.length < rule.min) { errors[key] = `Must be at least ${rule.min} characters.`; break; }
        if (rule.enum && !rule.enum.includes(value)) { errors[key] = "Unsupported value."; break; }
        out[key] = value;
        break;
      }
      case "email": {
        if (typeof value !== "string" || !EMAIL.test(value.trim())) { errors[key] = "Enter a valid email address."; break; }
        out[key] = value.trim().toLowerCase();
        break;
      }
      case "date":
        if (!DATE.test(String(value))) { errors[key] = "Use the format YYYY-MM-DD."; break; }
        out[key] = String(value); break;
      case "time":
        if (!TIME.test(String(value))) { errors[key] = "Use the format HH:MM."; break; }
        out[key] = String(value); break;
      case "id":
        if (typeof value !== "string" || !ID.test(value)) { errors[key] = "Invalid identifier."; break; }
        out[key] = value; break;
      case "int":
      case "number": {
        const n = Number(value);
        if (!Number.isFinite(n)) { errors[key] = "Must be a number."; break; }
        if (rule.type === "int" && !Number.isInteger(n)) { errors[key] = "Must be a whole number."; break; }
        if (rule.min !== undefined && n < rule.min) { errors[key] = `Must be at least ${rule.min}.`; break; }
        if (rule.max !== undefined && n > rule.max) { errors[key] = `Must be at most ${rule.max}.`; break; }
        out[key] = n; break;
      }
      case "bool":
        out[key] = value === true || value === 1 || value === "1" || value === "true"; break;
      default:
        out[key] = value;
    }
  }

  const missing = Object.keys(spec).filter((k) => spec[k].required && !partial && out[k] === undefined);
  if (Object.keys(errors).length || missing.length) throw bad("Please check the highlighted fields.", { ...errors, ...(missing.length ? { _missing: missing } : {}) });
  return out;
}

module.exports = { check, EMAIL, ID, DATE, TIME };