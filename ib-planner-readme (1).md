# IB Planner — full-stack (Express + SQLite + JWT)

Smart study planner for IB Diploma students. Vanilla HTML/CSS/JS frontend, Node/Express backend,
SQLite storage. Multi-device: log in anywhere and your subjects, tasks, events, IA, EE, CAS,
Auto Planner settings and generated study sessions follow you.

## Project structure

```
ib-planner/
├─ backend/
│  ├─ package.json
│  ├─ .env.example
│  ├─ .gitignore
│  └─ src/
│     ├─ server.js            # express app, static frontend, error handling
│     ├─ config.js            # env parsing + validation
│     ├─ middleware.js        # requireAuth, rate limit, error handler
│     ├─ db/
│     │  ├─ schema.sql        # tables + indexes (migrations)
│     │  └─ index.js          # connection, WAL, transactions
│     ├─ lib/
│     │  ├─ password.js       # scrypt hash/verify, token hashing
│     │  ├─ tokens.js         # JWT access + rotating refresh + reset tokens
│     │  ├─ errors.js         # ApiError
│     │  └─ validate.js       # tiny schema validator
│     └─ routes/
│        ├─ auth.js           # register/login/refresh/logout/me/reset/profile
│        └─ data.js           # generic CRUD + /state sync + ee/settings/planner
└─ frontend/
   └─ public/
      ├─ index.html           # the app (unchanged + 2 script tags)
      └─ js/
         ├─ api.js            # fetch wrapper, token handling
         └─ sync.js           # adapter: patches save()/auth globals, pushes to API
```

The backend serves `frontend/public` as static files, so one origin, one deploy — cookies and
relative `/api` URLs just work.

## Quick start

```bash
cd backend
cp .env.example .env
node -e "console.log('JWT_SECRET='+require('crypto').randomBytes(48).toString('hex'))"   # paste into .env
npm install
npm run dev            # http://localhost:4000
```

`DATABASE_FILE` defaults to `./data/ibplanner.db`; the schema is applied automatically on boot
(`CREATE TABLE IF NOT EXISTS`, plus forward-only `ALTER` migrations you can add to `db/index.js`).

## Environment variables

| var | purpose |
|---|---|
| `PORT` | HTTP port (default 4000) |
| `DATABASE_FILE` | SQLite file path (relative to `backend/`) |
| `JWT_SECRET` | **required**, ≥32 chars, signs access tokens |
| `JWT_EXPIRES_IN` | access token TTL, default `15m` |
| `REFRESH_DAYS` | refresh token lifetime, default `30` |
| `CORS_ORIGIN` | comma-separated allowed origins (only needed if the frontend is hosted separately) |
| `COOKIE_SECURE` | `true` behind HTTPS |
| `PUBLIC_DIR` | static frontend dir, default `../frontend/public` |
| `DEV_EXPOSE_RESET_TOKEN` | dev only: return the reset token in the API response when SMTP is not configured |
| `SMTP_*`, `MAIL_FROM`, `APP_URL` | password-reset email delivery (nodemailer) — optional |

Never commit `.env`. No credential, secret or salt is ever hard-coded and no password is ever stored
in plain text (see *Security* below).

## Data model

`users`, `refresh_tokens`, `password_resets`, `subjects`, `tasks`, `events` (includes exams, classes
and Auto-Planned study sessions), `ia_projects`, `ee_projects`, `ee_milestones`, `cas_activities`,
`settings` (calendar + Auto Planner prefs + availability JSON), `planner_plans`, `notifications`.

Every row carries `user_id`, and **every** query is scoped by it — a token for user A can never read
or write user B's rows (verified with `WHERE id=? AND user_id=?` on writes, and a 404 — not a 403 —
so ids aren't enumerable).

## API reference

All endpoints require `Authorization: Bearer <accessToken>` except the four `/api/auth/*` entry points.
Errors are `{ "error": { "code", "message", "details" } }` with proper status codes.

### Auth

| method | path | body / notes |
|---|---|---|
| POST | `/api/auth/register` | `{name,email,password,year,sample?}` → `{user, accessToken}` + sets refresh cookie |
| POST | `/api/auth/login` | `{email,password}` → `{user, accessToken}` |
| POST | `/api/auth/refresh` | uses httpOnly refresh cookie, rotates it → `{accessToken}` |
| POST | `/api/auth/logout` | revokes the refresh token, clears cookie |
| GET | `/api/auth/me` | current user + full state snapshot |
| POST | `/api/auth/forgot-password` | `{email}` → always generic 200 (no account enumeration) |
| POST | `/api/auth/reset-password` | `{token,password}` → consumes the single-use token |
| PATCH | `/api/auth/profile` | `{name?,year?,email?,currentPassword?,newPassword?}` |
| DELETE | `/api/auth/account` | `{password}` → cascades all user data |

### Collections (identical CRUD shape)

`subjects` · `tasks` · `events` · `ia` · `cas` · `notifications`

| method | path | notes |
|---|---|---|
| GET | `/api/<collection>` | filters: `?type=&subjectId=&due=&from=&to=&done=` |
| POST | `/api/<collection>` | client may supply `id`; `{id}` is echoed back |
| GET | `/api/<collection>/:id` | single record |
| PATCH | `/api/<collection>/:id` | partial update |
| DELETE | `/api/<collection>/:id` | delete one |
| DELETE | `/api/<collection>` | delete all of that collection for the user |

Convenience: `GET /api/exams` → `events` where `type='exam'`.

### Domain-specific

| method | path | notes |
|---|---|---|
| GET/PUT | `/api/ee` | Extended Essay singleton: `{rq,supervisor,subject,progress,notes,milestones[]}` |
| POST/PATCH/DELETE | `/api/ee/milestones[/:id]` | milestones stored in `ee_milestones` |
| GET/PUT | `/api/settings` | theme, week start, calendar prefs, availability + Auto Planner config |
| GET | `/api/planner/plans` | last 20 plan runs (`POST /api/planner/plan` to record one) |
| GET | `/api/state` | full snapshot + `revision` |
| PUT | `/api/state` | transactional snapshot write: `{baseRevision, state, onboarded}` |

### How the frontend syncs

`sync.js` pushes the whole in-memory state (`subjects`, `tasks`, `events`, `ia`, `cas`, `ee`,
`settings`, `availability`, `plan`, `notifications`) to `PUT /api/state` 800 ms after any mutation —
the app's `save()` is patched, so no feature needed rewriting. The server applies it in one
transaction (delete + insert per table), which makes deletions correct automatically.

Writes are monotonic (`revision`), and the client also polls `GET /api/state` every 60 s and on tab
focus, so a second device converges within a minute. If two devices edit the same user concurrently,
the last writer wins per snapshot (the client re-rebases and retries on `409`); conflicts are
surfaced as a toast instead of silently dropping work. If you later want per-field merging, swap the
`PUT /api/state` call for the collection endpoints — they are already there and independent.

## Security

- **scrypt** (`node:crypto`, N=16384, r=8, p=1, 64-byte key, 16-byte random salt) with
  `timingSafeEqual`. Stored as `scrypt$N$r$p$salt$hash` — no plain text, ever. Argon2id is a
  drop-in upgrade if you prefer.
- **Access JWT** 15 min in memory/`sessionStorage`; **refresh token** is an opaque 32-byte random
  value, stored **hashed** (SHA-256) with expiry + `revoked_at`, delivered as an `httpOnly`,
  `SameSite=Lax`, `Secure` (prod) cookie, and **rotated on every refresh** (reuse revokes the chain).
- **Password reset** tokens: 32 random bytes, SHA-256-hashed at rest, 30-minute expiry, single use,
  and the endpoint responds identically whether or not the email exists.
- Helmet, JSON body limit, CORS allow-list with credentials, per-IP rate limits on auth routes
  (express-rate-limit semantics, in-process store), generic 500s that never leak internals.
- The frontend no longer treats `localStorage` as a source of truth: a stale prototype session is
  ignored, `localStorage` is only a render cache, and it is cleared when a different account signs in.

## Deploy

**Single host (recommended, simplest):** push the repo, `npm ci --omit=dev` in `backend/`,
`NODE_ENV=production`, set env vars, mount a persistent volume at `backend/data/` (SQLite needs
durable disk — Render disks, Fly volumes, a VPS/VPS block store). `npm start`. Health check: `GET /api/health`.

**Split hosting:** keep `frontend/public` on any static host, set `window.IB_API_BASE = "https://api.example.com"`,
add `CORS_ORIGIN=https://app.example.com`, `COOKIE_SECURE=true`, and `SameSite=None; Secure` on the
refresh cookie (see the comment in `routes/auth.js`).

**PostgreSQL:** the SQL layer is thin (`better-sqlite3` prepared statements in `routes/data.js`).
Swap `db/index.js` for `pg` + a `query()` helper, change `INTEGER PRIMARY KEY`/`AUTOINCREMENT` to
`SERIAL`/`BIGSERIAL`, `TEXT` stays, and `RETURNING *` replaces `.run().lastInsertRowid`. Everything
else — middleware, routes, sync semantics — is unchanged.

## Frontend patches (3 small edits)

1. After the app's main `</script>`, load the adapter:
   `<script src="/js/api.js"></script><script src="/js/sync.js"></script>`
2. Make the login handler `async` and `await loginUser(...)`.
3. Same for the register handler.

Nothing else in the UI changes: the Auto Planner, calendar views, drag-and-drop, trackers, search,
toasts and settings all keep working, now backed by the database.