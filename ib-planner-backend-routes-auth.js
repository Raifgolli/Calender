"use strict";
const express = require("express");
const cfg = require("../config");
const { db, prepare, tx } = require("../db");
const { asyncH, requireAuth, rateLimit, publicUser } = require("../middleware");
const { ApiError, bad, unauthorized, conflict, notFound } = require("../lib/errors");
const { check } = require("../lib/validate");
const { hashPassword, verifyPassword, newId, randomToken } = require("../lib/password");
const tokens = require("../lib/tokens");

const router = express.Router();

const ACCESS_COOKIE = "ibp_access";
const REFRESH_COOKIE = "ibp_refresh";
const COOKIE_BASE = { httpOnly: true, sameSite: "lax", secure: cfg.cookieSecure, path: "/" };
// Split hosting (different origins): use { sameSite: "none", secure: true } for both cookies.

function issueSession(res, user, req) {
  const access = tokens.signAccess(user);
  const refresh = tokens.issueRefresh(user.id, req.get("user-agent"));
  res.cookie(ACCESS_COOKIE, access, { ...COOKIE_BASE, maxAge: 15 * 60000 });
  res.cookie(REFRESH_COOKIE, refresh.token, { ...COOKIE_BASE, maxAge: cfg.refreshDays * 864e5 });
  return access;
}
const clearSession = (res) => {
  res.clearCookie(ACCESS_COOKIE, { ...COOKIE_BASE });
  res.clearCookie(REFRESH_COOKIE, { ...COOKIE_BASE });
};

const q = {
  byEmail: prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE"),
  byId: prepare("SELECT * FROM users WHERE id = ?"),
  insert: prepare("INSERT INTO users (id,email,name,year,password_hash,onboarded) VALUES (?,?,?,?,?,?)"),
  settings: prepare(`INSERT INTO settings (user_id, availability_json, plan_json)
    VALUES (?, ?, NULL)
    ON CONFLICT(user_id) DO NOTHING`),
  ee: prepare("INSERT INTO ee_projects (user_id, research_question, supervisor, subject, progress, notes) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id) DO NOTHING"),
  touch: prepare("UPDATE users SET revision = revision + 1, updated_at = datetime('now') WHERE id = ?"),
  update: prepare("UPDATE users SET name = ?, year = ?, updated_at = datetime('now') WHERE id = ?"),
  email: prepare("UPDATE users SET email = ?, updated_at = datetime('now') WHERE id = ?"),
  pass: prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?"),
  del: prepare("DELETE FROM users WHERE id = ?")
};

const DEFAULT_AVAILABILITY = () => {
  const days = {};
  for (let i = 0; i < 7; i++) days[i] = { enabled: i !== 0 && i !== 6, start: "16:30", end: "20:30" };
  days[6] = { enabled: true, start: "10:00", end: "16:00" };
  return days;
};

/** Called after a successful register so a new account has complete default rows. */
function seedAccount(userId) {
  q.settings.run(userId, JSON.stringify(DEFAULT_AVAILABILITY()));
  q.ee.run(userId, "", "", "", 0, "");
}

/* ---------------------------------------------------------------- register */
router.post(
  "/register",
  rateLimit({ bucket: "register", windowMs: 15 * 60000, max: 10 }),
  asyncH(async (req, res) => {
    const body = check(req.body, {
      name: { type: "string", required: true, min: 2, max: 80 },
      email: { type: "email", required: true },
      password: { type: "string", required: true, min: 8, max: 200 },
      year: { type: "string", enum: ["DP1", "DP2"], default: "DP1" },
      sample: { type: "bool", default: false }
    });

    if (q.byEmail.get(body.email)) throw conflict("An account with that email already exists. Try logging in instead.");

    const id = newId();
    const passwordHash = await hashPassword(body.password);
    const user = tx(() => {
      q.insert.run(id, body.email, body.name, body.year, passwordHash, 0);
      seedAccount(id);
      return q.byId.get(id);
    })();

    // `sample` is honoured client-side (the sample IB dataset lives in the frontend); the client
    // pushes it through PUT /api/state right after registering.
    const accessToken = issueSession(res, user, req);
    res.status(201).json({ user: publicUser(user), accessToken, wantsSample: body.sample });
  })
);

/* ------------------------------------------------------------------- login */
router.post(
  "/login",
  rateLimit({ bucket: "login", windowMs: 15 * 60000, max: 20 }),
  asyncH(async (req, res) => {
    const body = check(req.body, {
      email: { type: "email", required: true },
      password: { type: "string", required: true, max: 200 }
    });
    const user = q.byEmail.get(body.email);
    const ok = user ? await verifyPassword(body.password, user.password_hash) : false;
    if (!ok) throw unauthorized("Incorrect email or password.");
    const accessToken = issueSession(res, user, req);
    res.json({ user: publicUser(user), accessToken });
  })
);

/* ----------------------------------------------------------------- refresh */
router.post(
  "/refresh",
  rateLimit({ bucket: "refresh", windowMs: 15 * 60000, max: 120 }),
  asyncH(async (req, res) => {
    const presented = req.cookies ? req.cookies[REFRESH_COOKIE] : null;
    const { userId, token } = tokens.rotateRefresh(presented, req.get("user-agent"));
    const user = q.byId.get(userId);
    if (!user) throw unauthorized("Your account is no longer available.");
    const access = tokens.signAccess(user);
    res.cookie(ACCESS_COOKIE, access, { ...COOKIE_BASE, maxAge: 15 * 60000 });
    res.cookie(REFRESH_COOKIE, token, { ...COOKIE_BASE, maxAge: cfg.refreshDays * 864e5 });
    res.json({ user: publicUser(user), accessToken: access });
  })
);

/* ------------------------------------------------------------------ logout */
router.post("/logout", asyncH(async (req, res) => {
  tokens.revokeRefresh(req.cookies ? req.cookies[REFRESH_COOKIE] : null);
  clearSession(res);
  res.json({ ok: true });
}));

/* ---------------------------------------------------------------------- me */
router.get("/me", requireAuth, asyncH(async (req, res) => {
  const row = q.byId.get(req.user.id);
  res.json({ user: publicUser(row) });
}));

/* --------------------------------------------------------- forgot password */
router.post(
  "/forgot-password",
  rateLimit({ bucket: "forgot", windowMs: 15 * 60000, max: 5 }),
  asyncH(async (req, res) => {
    const body = check(req.body, { email: { type: "email", required: true } });
    const user = q.byEmail.get(body.email);

    // Always the same response — never reveal whether an account exists.
    const generic = { ok: true, message: "If an account exists for that address, a reset link has been sent." };
    if (!user) return res.json(generic);

    const { token, expiresAt } = tokens.createResetToken(user.id);
    const link = `${cfg.appUrl.replace(/\/$/, "")}/?reset=${encodeURIComponent(token)}`;
    let delivered = false;
    try {
      if (cfg.smtp.host) {
        const nodemailer = require("nodemailer");
        const transport = nodemailer.createTransport({
          host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure,
          auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined
        });
        await transport.sendMail({
          from: cfg.mailFrom, to: user.email, subject: "Reset your IB Planner password",
          text: `Hi ${user.name},\n\nUse this link within 30 minutes to set a new password:\n${link}\n\nIf you did not request this, you can ignore this email.`,
          html: `<p>Hi ${user.name},</p><p>Use this link within 30 minutes to set a new password:</p><p><a href="${link}">Reset my password</a></p><p>If you did not request this, you can ignore this email.</p>`
        });
        delivered = true;
      }
    } catch (err) {
      console.error("[ibplanner] reset email failed:", err.message);
    }
    if (!delivered) console.log(`[ibplanner] password reset link for ${user.email}: ${link} (expires ${expiresAt})`);

    // Dev convenience only — never expose the token when mail is configured or in production.
    const expose = cfg.devExposeResetToken && !cfg.isProd && !delivered;
    res.json(expose ? { ...generic, devResetLink: link, devResetToken: token } : generic);
  })
);

/* ---------------------------------------------------------- reset password */
router.post(
  "/reset-password",
  rateLimit({ bucket: "reset", windowMs: 15 * 60000, max: 10 }),
  asyncH(async (req, res) => {
    const body = check(req.body, {
      token: { type: "string", required: true, min: 10, max: 200 },
      password: { type: "string", required: true, min: 8, max: 200 }
    });
    const userId = tokens.consumeResetToken(body.token); // throws on invalid/used/expired
    const hash = await hashPassword(body.password);
    const user = tx(() => {
      q.pass.run(hash, userId);
      const u = q.byId.get(userId);
      tokens.revokeAllForUser(userId); // force re-login everywhere
      return u;
    })();
    res.json({ ok: true, message: "Password updated. Please log in with your new password.", email: user.email });
  })
);

/* --------------------------------------------------------- update profile */
router.patch("/profile", requireAuth, asyncH(async (req, res) => {
  const body = check(req.body, {
    name: { type: "string", min: 2, max: 80 },
    year: { type: "string", enum: ["DP1", "DP2"] },
    email: { type: "email" },
    currentPassword: { type: "string", max: 200 },
    newPassword: { type: "string", min: 8, max: 200 }
  }, { partial: true });

  const row = q.byId.get(req.user.id);
  if (body.newPassword) {
    if (!body.currentPassword) throw bad("Enter your current password to set a new one.", { currentPassword: "Required." });
    if (!(await verifyPassword(body.currentPassword, row.password_hash))) throw unauthorized("Your current password is incorrect.");
  }
  if (body.email && body.email !== row.email && q.byEmail.get(body.email)) throw conflict("That email is already in use.");

  const updated = tx(() => {
    if (body.name || body.year) q.update.run(body.name || row.name, body.year || row.year, row.id);
    if (body.email) q.email.run(body.email, row.id);
    if (body.newPassword) {
      q.pass.run(require("crypto").createHash("sha256").update("placeholder").digest("hex"), row.id); // replaced below
    }
    return q.byId.get(row.id);
  })();

  if (body.newPassword) {
    const hash = await hashPassword(body.newPassword); // hashing stays outside the sync transaction
    q.pass.run(hash, row.id);
    tokens.revokeAllForUser(row.id);
  }
  res.json({ user: publicUser(q.byId.get(row.id) || updated) });
}));

/* -------------------------------------------------------------- delete me */
router.delete("/account", requireAuth, asyncH(async (req, res) => {
  const body = check(req.body, { password: { type: "string", required: true } });
  const row = q.byId.get(req.user.id);
  if (!(await verifyPassword(body.password, row.password_hash))) throw unauthorized("Password is incorrect.");
  tx(() => {
    q.del.run(row.id); // ON DELETE CASCADE removes every row owned by this user
  })();
  clearSession(res);
  res.json({ ok: true, message: "Your account and all associated data have been deleted." });
}));

module.exports = { router, COOKIE_ACCESS: ACCESS_COOKIE, COOKIE_REFRESH: REFRESH_COOKIE };