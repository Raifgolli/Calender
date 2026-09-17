"use strict";
const express = require("express");
const { db, prepare, tx } = require("../db");
const { asyncH, requireAuth } = require("../middleware");
const { bad, notFound, conflict } = require("../lib/errors");
const { check } = require("../lib/validate");
const { newId } = require("../lib/password");

/* ------------------------------------------------------------------ registry
 * Each collection maps API field names (camelCase, matching the frontend) to
 * snake_case columns. CRUD routers are generated from this single definition. */
const COLLECTIONS = {
  subjects: {
    table: "subjects",
    fields: { id: "id", name: "name", group: "group_no", level: "level", teacher: "teacher", times: "class_times", color: "color", position: "position" },
    numbers: ["group", "position"], bools: [],
    filterable: ["level", "group"],
    spec: {
      id: { type: "id" }, name: { type: "string", required: true, min: 1, max: 120 },
      group: { type: "int", min: 1, max: 6, nullable: true }, level: { type: "string", enum: ["HL", "SL"], nullable: true },
      teacher: { type: "string", max: 120, nullable: true }, times: { type: "string", max: 120, nullable: true },
      color: { type: "string", max: 24, nullable: true }, position: { type: "int", min: 0, max: 99, nullable: true }
    }
  },
  tasks: {
    table: "tasks",
    fields: { id: "id", title: "title", type: "type", subjectId: "subject_id", due: "due", est: "est", priority: "priority", difficulty: "difficulty", notes: "notes", done: "done", completedAt: "completed_at", iaId: "ia_id", eePlan: "ee_plan" },
    numbers: ["est", "difficulty"], bools: ["done", "eePlan"],
    filterable: ["type", "subjectId", "done"], rangeField: "due",
    spec: {
      id: { type: "id" }, title: { type: "string", required: true, min: 1, max: 300 },
      type: { type: "string", max: 40, nullable: true }, subjectId: { type: "string", max: 64, nullable: true },
      due: { type: "date", nullable: true }, est: { type: "int", min: 0, max: 100000, nullable: true },
      priority: { type: "string", enum: ["high", "medium", "low"], nullable: true },
      difficulty: { type: "int", min: 1, max: 5, nullable: true }, notes: { type: "string", max: 4000, nullable: true },
      done: { type: "bool" }, completedAt: { type: "string", max: 40, nullable: true },
      iaId: { type: "string", max: 64, nullable: true }, eePlan: { type: "bool" }
    }
  },
  events: {
    table: "events",
    fields: { id: "id", title: "title", type: "type", subjectId: "subject_id", taskId: "task_id", date: "date", start: "start_time", end: "end_time", auto: "auto", locked: "locked", manual: "manual", done: "done", notes: "notes" },
    numbers: [], bools: ["auto", "locked", "manual", "done"],
    filterable: ["type", "subjectId", "taskId", "date"], rangeField: "date",
    spec: {
      id: { type: "id" }, title: { type: "string", required: true, min: 1, max: 300 },
      type: { type: "string", max: 40, nullable: true }, subjectId: { type: "string", max: 64, nullable: true },
      taskId: { type: "string", max: 64, nullable: true }, date: { type: "date", required: true },
      start: { type: "time", nullable: true }, end: { type: "time", nullable: true },
      auto: { type: "bool" }, locked: { type: "bool" }, manual: { type: "bool" }, done: { type: "bool" },
      notes: { type: "string", max: 4000, nullable: true }
    }
  },
  ia: {
    table: "ia_projects",
    fields: { id: "id", title: "title", subjectId: "subject_id", rq: "research_question", due: "due", progress: "progress", status: "status", notes: "notes" },
    numbers: ["progress"], bools: [], filterable: ["subjectId", "status"], rangeField: "due",
    spec: {
      id: { type: "id" }, title: { type: "string", required: true, min: 1, max: 300 },
      subjectId: { type: "string", max: 64, nullable: true }, rq: { type: "string", max: 1000, nullable: true },
      due: { type: "date", nullable: true }, progress: { type: "int", min: 0, max: 100, nullable: true },
      status: { type: "string", max: 40, nullable: true }, notes: { type: "string", max: 4000, nullable: true }
    }
  },
  cas: {
    table: "cas_activities",
    fields: { id: "id", category: "category", title: "title", date: "date", hours: "hours", reflection: "reflection", status: "status" },
    numbers: ["hours"], bools: [], filterable: ["category", "status"], rangeField: "date",
    spec: {
      id: { type: "id" }, category: { type: "string", required: true, enum: ["Creativity", "Activity", "Service"] },
      title: { type: "string", required: true, min: 1, max: 300 }, date: { type: "date", nullable: true },
      hours: { type: "number", min: 0, max: 5000, nullable: true }, reflection: { type: "string", max: 4000, nullable: true },
      status: { type: "string", enum: ["Planned", "Ongoing", "Completed"], nullable: true }
    }
  },
  notifications: {
    table: "notifications",
    fields: { id: "id", title: "title", text: "body", at: "created_at", read: "read" },
    numbers: [], bools: ["read"], filterable: ["read"],
    spec: { id: { type: "id" }, title: { type: "string", required: true, min: 1, max: 200 }, text: { type: "string", max: 1000, nullable: true }, at: { type: "string", max: 40, nullable: true }, read: { type: "bool" } }
  }
};

/* ------------------------------------------------------------- row mapping */
function rowToApi(spec, row) {
  const out = {};
  for (const [apiKey, col] of Object.entries(spec.fields)) {
    let v = row[col];
    if (spec.bools.includes(apiKey)) v = !!v;
    else if (spec.numbers.includes(apiKey)) v = v === null || v === undefined ? null : Number(v);
    out[apiKey] = v === undefined ? null : v;
  }
  return out;
}
function apiToRow(spec, input, partial) {
  const row = {};
  for (const [apiKey, col] of Object.entries(spec.fields)) {
    if (apiKey === "id") continue;
    if (partial && !Object.prototype.hasOwnProperty.call(input, apiKey)) continue;
    let v = input[apiKey];
    if (spec.bools.includes(apiKey)) v = v ? 1 : 0;
    else if (spec.numbers.includes(apiKey) && v !== null) v = Number(v);
    row[col] = v === undefined ? null : v;
  }
  return row;
}
function buildWhere(spec, userId, query) {
  const where = ["user_id = ?"];
  const params = [userId];
  for (const key of spec.filterable || []) {
    if (query[key] === undefined || query[key] === "") continue;
    const col = spec.fields[key];
    if (!col) continue;
    let value = query[key];
    if (spec.bools.includes(key)) value = /^(1|true|yes)$/i.test(String(value)) ? 1 : 0;
    where.push(`${col} = ?`);
    params.push(value);
  }
  if (spec.rangeField) {
    const col = spec.fields[spec.rangeField];
    if (query.from) { where.push(`${col} >= ?`); params.push(query.from); }
    if (query.to) { where.push(`${col} <= ?`); params.push(query.to); }
  }
  return { clause: where.join(" AND "), params };
}

/* --------------------------------------------- generated CRUD collection */
function collectionRouter(name) {
  const spec = COLLECTIONS[name];
  const r = express.Router();

  r.get("/", asyncH((req, res) => {
    const { clause, params } = buildWhere(spec, req.user.id, req.query);
    const order = req.query.sort === "due" ? ` ORDER BY due IS NULL, due ASC` : ` ORDER BY rowid DESC`;
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const rows = prepare(`SELECT * FROM ${spec.table} WHERE ${clause}${order} LIMIT ${limit}`).all(...params);
    res.json({ items: rows.map((row) => rowToApi(spec, row)), count: rows.length });
  }));

  r.post("/", asyncH((req, res) => {
    const body = check(req.body, spec.spec);
    const id = body.id || newId();
    const row = apiToRow(spec, body, false);
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${spec.table} (user_id, id, ${cols.join(",")}) VALUES (?,?,${cols.map(() => "?").join(",")})`;
    prepare(sql).run(req.user.id, id, ...cols.map((c) => row[c]));
    res.status(201).json({ item: rowToApi(spec, prepare(`SELECT * FROM ${spec.table} WHERE user_id=? AND id=?`).get(req.user.id, id)) });
  }));

  r.get("/:id", asyncH((req, res) => {
    const row = prepare(`SELECT * FROM ${spec.table} WHERE user_id=? AND id=?`).get(req.user.id, req.params.id);
    if (!row) throw notFound("That record does not exist.");
    res.json({ item: rowToApi(spec, row) });
  }));

  r.patch("/:id", asyncH((req, res) => {
    const body = check(req.body, spec.spec, { partial: true });
    const row = apiToRow(spec, body, true);
    const cols = Object.keys(row);
    if (!cols.length) throw bad("No valid fields to update.");
    const sql = `UPDATE ${spec.table} SET ${cols.map((c) => `${c}=?`).join(",")}, updated_at=datetime('now')
                 WHERE user_id=? AND id=?`;
    const info = prepare(sql).run(...cols.map((c) => row[c]), req.user.id, req.params.id);
    if (!info.changes) throw notFound("That record does not exist.");
    const updated = prepare(`SELECT * FROM ${spec.table} WHERE user_id=? AND id=?`).get(req.user.id, req.params.id);
    res.json({ item: rowToApi(spec, updated) });
  }));

  r.delete("/:id", asyncH((req, res) => {
    const info = prepare(`DELETE FROM ${spec.table} WHERE user_id=? AND id=?`).run(req.user.id, req.params.id);
    if (!info.changes) throw notFound("That record does not exist.");
    res.json({ ok: true, deleted: req.params.id });
  }));

  r.delete("/", asyncH((req, res) => {
    const info = prepare(`DELETE FROM ${spec.table} WHERE user_id=?`).run(req.user.id);
    res.json({ ok: true, deletedCount: info.changes });
  }));

  return r;
}

/* --------------------------------------------------------- EE (singleton) */
const eeRouter = express.Router();
function eeShape(userId) {
  const e = prepare("SELECT * FROM ee_projects WHERE user_id=?").get(userId) || {};
  const ms = prepare("SELECT * FROM ee_milestones WHERE user_id=? ORDER BY due IS NULL, due ASC").all(userId);
  return {
    rq: e.research_question || "", supervisor: e.supervisor || "", subject: e.subject || "",
    progress: Number(e.progress || 0), notes: e.notes || "",
    milestones: ms.map((m) => ({ id: m.id, title: m.title, due: m.due, done: !!m.done }))
  };
}
function writeEE(userId, ee) {
  prepare(`INSERT INTO ee_projects (user_id,research_question,supervisor,subject,progress,notes,updated_at)
           VALUES (?,?,?,?,?,?,datetime('now'))
           ON CONFLICT(user_id) DO UPDATE SET research_question=excluded.research_question, supervisor=excluded.supervisor,
             subject=excluded.subject, progress=excluded.progress, notes=excluded.notes, updated_at=datetime('now')`)
    .run(userId, ee.rq || "", ee.supervisor || "", ee.subject || "", Number(ee.progress || 0), ee.notes || "");
  prepare("DELETE FROM ee_milestones WHERE user_id=?").run(userId);
  const ins = prepare("INSERT INTO ee_milestones (user_id,id,title,due,done) VALUES (?,?,?,?,?)");
  (ee.milestones || []).forEach((m, i) => ins.run(userId, m.id || newId(), String(m.title || "Milestone " + (i + 1)), m.due || null, m.done ? 1 : 0));
}
eeRouter.get("/", asyncH((req, res) => res.json({ ee: eeShape(req.user.id) })));
eeRouter.put("/", asyncH((req, res) => {
  const body = check(req.body, {
    rq: { type: "string", max: 1000, nullable: true }, supervisor: { type: "string", max: 120, nullable: true },
    subject: { type: "string", max: 120, nullable: true }, progress: { type: "int", min: 0, max: 100, nullable: true },
    notes: { type: "string", max: 6000, nullable: true },
    milestones: { type: "string", nullable: true } // validated manually below
  }, { partial: true }).valueOf();
  const payload = { rq: body.rq, supervisor: body.supervisor, subject: body.subject, progress: body.progress, notes: body.notes, milestones: req.body.milestones || [] };
  tx(() => writeEE(req.user.id, payload))();
  res.json({ ee: eeShape(req.user.id) });
}));
eeRouter.post("/milestones", asyncH((req, res) => {
  const b = check(req.body, { id: { type: "id" }, title: { type: "string", required: true, min: 1, max: 300 }, due: { type: "date", nullable: true }, done: { type: "bool" } });
  const id = b.id || newId();
  prepare("INSERT INTO ee_milestones (user_id,id,title,due,done) VALUES (?,?,?,?,?)").run(req.user.id, id, b.title, b.due || null, b.done ? 1 : 0);
  res.status(201).json({ ee: eeShape(req.user.id) });
}));
eeRouter.patch("/milestones/:id", asyncH((req, res) => {
  const b = check(req.body, { title: { type: "string", min: 1, max: 300 }, due: { type: "date", nullable: true }, done: { type: "bool" } }, { partial: true });
  const sets = [], vals = [];
  if (b.title !== undefined) { sets.push("title=?"); vals.push(b.title); }
  if (b.due !== undefined) { sets.push("due=?"); vals.push(b.due); }
  if (b.done !== undefined) { sets.push("done=?"); vals.push(b.done ? 1 : 0); }
  if (!sets.length) throw bad("No valid fields to update.");
  const info = prepare(`UPDATE ee_milestones SET ${sets.join(",")} WHERE user_id=? AND id=?`).run(...vals, req.user.id, req.params.id);
  if (!info.changes) throw notFound("That milestone does not exist.");
  res.json({ ee: eeShape(req.user.id) });
}));
eeRouter.delete("/milestones/:id", asyncH((req, res) => {
  const info = prepare("DELETE FROM ee_milestones WHERE user_id=? AND id=?").run(req.user.id, req.params.id);
  if (!info.changes) throw notFound("That milestone does not exist.");
  res.json({ ee: eeShape(req.user.id) });
}));

/* --------------------------------------------------------------- settings */
const DEFAULTS = {
  theme: "dark", weekStart: 1, defaultCalView: "month", notifyDeadlines: true, notifyPlanner: true, dense: false,
  maxHoursPerDay: 3, sessionLength: 50, breakLength: 10, preferred: "any", examBuffer: 5, projectBuffer: 10,
  horizon: 35, startTime: "16:30"
};
function settingsShape(userId) {
  const s = prepare("SELECT * FROM settings WHERE user_id=?").get(userId);
  if (!s) return { settings: { theme: DEFAULTS.theme, weekStart: DEFAULTS.weekStart, defaultCalView: DEFAULTS.defaultCalView, notifyDeadlines: true, notifyPlanner: true, dense: false }, availability: { days: {}, ...DEFAULTS }, plan: null };
  return {
    settings: {
      theme: s.theme, weekStart: Number(s.week_start), defaultCalView: s.default_cal_view,
      notifyDeadlines: !!s.notify_deadlines, notifyPlanner: !!s.notify_planner, dense: !!s.dense
    },
    availability: {
      days: s.availability_json ? JSON.parse(s.availability_json) : {},
      maxHoursPerDay: Number(s.max_hours_per_day), sessionLength: Number(s.session_length), breakLength: Number(s.break_length),
      preferred: s.preferred, examBuffer: Number(s.exam_buffer), projectBuffer: Number(s.project_buffer),
      horizon: Number(s.horizon), startTime: s.start_time
    },
    plan: s.plan_json ? JSON.parse(s.plan_json) : null
  };
}
function writeSettings(userId, settings, availability, plan) {
  const st = { ...DEFAULTS, ...(settings || {}) }, av = { ...DEFAULTS, days: {}, ...(availability || {}) };
  prepare(`INSERT INTO settings (user_id,theme,week_start,default_cal_view,notify_deadlines,notify_planner,dense,
            max_hours_per_day,session_length,break_length,preferred,exam_buffer,project_buffer,horizon,start_time,availability_json,plan_json,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
           ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme, week_start=excluded.week_start, default_cal_view=excluded.default_cal_view,
             notify_deadlines=excluded.notify_deadlines, notify_planner=excluded.notify_planner, dense=excluded.dense,
             max_hours_per_day=excluded.max_hours_per_day, session_length=excluded.session_length, break_length=excluded.break_length,
             preferred=excluded.preferred, exam_buffer=excluded.exam_buffer, project_buffer=excluded.project_buffer,
             horizon=excluded.horizon, start_time=excluded.start_time, availability_json=excluded.availability_json,
             plan_json=excluded.plan_json, updated_at=datetime('now')`)
    .run(userId, st.theme === "light" ? "light" : "dark", Number(st.weekStart ?? 1), String(st.defaultCalView || "month"),
      st.notifyDeadlines ? 1 : 0, st.notifyPlanner ? 1 : 0, st.dense ? 1 : 0,
      Number(st.maxHoursPerDay ?? av.maxHoursPerDay ?? 3), Number(av.sessionLength ?? 50), Number(av.breakLength ?? 10),
      String(av.preferred || "any"), Number(av.examBuffer ?? 5), Number(av.projectBuffer ?? 10), Number(av.horizon ?? 35),
      String(av.startTime || "16:30"), JSON.stringify(av.days || {}), plan ? JSON.stringify(plan) : null);
}
const settingsRouter = express.Router();
settingsRouter.get("/", asyncH((req, res) => res.json(settingsShape(req.user.id))));
settingsRouter.put("/", asyncH((req, res) => {
  tx(() => writeSettings(req.user.id, req.body.settings, req.body.availability, req.body.plan))();
  res.json(settingsShape(req.user.id));
}));

/* ------------------------------------------------------- planner plan runs */
const plannerRouter = express.Router();
plannerRouter.get("/plans", asyncH((req, res) => {
  const rows = prepare("SELECT id,sessions,minutes,created_at FROM planner_plans WHERE user_id=? ORDER BY created_at DESC LIMIT 20").all(req.user.id);
  res.json({ plans: rows.map((r) => ({ id: r.id, sessions: r.sessions, minutes: r.minutes, createdAt: r.created_at })) });
}));
plannerRouter.post("/plan", asyncH((req, res) => {
  const b = check(req.body, { sessions: { type: "int", required: true, min: 0, max: 10000 }, minutes: { type: "int", min: 0, max: 1000000 } });
  const id = newId();
  prepare("INSERT INTO planner_plans (id,user_id,sessions,minutes,payload) VALUES (?,?,?,?,?)")
    .run(id, req.user.id, b.sessions, b.minutes || 0, JSON.stringify(req.body.payload || null));
  prepare("DELETE FROM planner_plans WHERE user_id=? AND id NOT IN (SELECT id FROM planner_plans WHERE user_id=? ORDER BY created_at DESC LIMIT 20)").run(req.user.id, req.user.id);
  res.status(201).json({ ok: true, id });
}));

/* ------------------------------------------------ full-state sync (used by the app) */
const stateRouter = express.Router();

function readState(userId) {
  const out = { subjects: [], tasks: [], events: [], ia: [], cas: [] };
  for (const [name, spec] of Object.entries(COLLECTIONS)) {
    if (name === "notifications") continue;
    out[name] = prepare(`SELECT * FROM ${spec.table} WHERE user_id=? ORDER BY rowid`).all(userId).map((row) => rowToApi(spec, row));
  }
  const notifs = prepare("SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 40").all(userId);
  const s = settingsShape(userId);
  return {
    state: {
      subjects: out.subjects, tasks: out.tasks, events: out.events, ia: out.ia, cas: out.cas,
      notifications: notifs.map((n) => rowToApi(COLLECTIONS.notifications, n)),
      ee: eeShape(userId), settings: s.settings, availability: s.availability, plan: s.plan
    },
    revision: 0
  };
}

stateRouter.get("/", asyncH((req, res) => {
  const u = prepare("SELECT revision, onboarded FROM users WHERE id=?").get(req.user.id);
  const snap = readState(req.user.id);
  res.json({ revision: Number(u.revision), onboarded: !!u.onboarded, ...snap.state, _embedded: undefined });
}));

function replaceCollection(userId, spec, items) {
  prepare(`DELETE FROM ${spec.table} WHERE user_id=?`).run(userId);
  if (!Array.isArray(items) || !items.length) return 0;
  const cols = Object.keys(spec.fields).filter((k) => k !== "id").map((k) => spec.fields[k]);
  const sql = `INSERT INTO ${spec.table} (user_id, id, ${cols.join(",")}) VALUES (?,?,${cols.map(() => "?").join(",")})`;
  const ins = prepare(sql);
  let n = 0;
  for (const raw of items) {
    const row = apiToRow(spec, raw, false);
    const id = raw.id || newId();
    try {
      ins.run(userId, id, ...cols.map((c) => row[c]));
      n++;
    } catch (err) {
      // one malformed record must not abort the whole plan — log and continue
      console.warn(`[ibplanner] skipped ${spec.table} record ${id}: ${err.message}`);
    }
  }
  return n;
}

stateRouter.put("/", asyncH((req, res) => {
  const { baseRevision, state, onboarded } = req.body || {};
  if (!state || typeof state !== "object") throw bad("A full state snapshot is required.");
  const current = prepare("SELECT revision, onboarded FROM users WHERE id=?").get(req.user.id);
  const currentRev = Number(current.revision);

  if (baseRevision !== undefined && Number(baseRevision) !== currentRev) {
    const snap = readState(req.user.id);
    throw conflict("This account was updated on another device.", { revision: currentRev, ...snap.state });
  }

  const counts = tx(() => {
    const result = {};
    for (const [name, spec] of Object.entries(COLLECTIONS)) {
      if (name === "notifications") continue;
      result[name] = replaceCollection(req.user.id, spec, state[name] || []);
    }
    result.notifications = replaceCollection(req.user.id, COLLECTIONS.notifications, state.notifications || []);
    writeEE(req.user.id, state.ee || {});
    writeSettings(req.user.id, state.settings, state.availability, state.plan);
    const nextOnboarded = onboarded === undefined ? current.onboarded : onboarded ? 1 : 0;
    prepare("UPDATE users SET revision = revision + 1, onboarded = ?, updated_at = datetime('now') WHERE id=?").run(nextOnboarded, req.user.id);
    return result;
  })();

  const u = prepare("SELECT revision, onboarded FROM users WHERE id=?").get(req.user.id);
  res.json({ ok: true, revision: Number(u.revision), onboarded: !!u.onboarded, counts });
}));

/* ------------------------------------------------------------------ mount */
function mount(app) {
  for (const name of Object.keys(COLLECTIONS)) app.use(`/api/${name}`, requireAuth, collectionRouter(name));
  app.use("/api/ee", requireAuth, eeRouter);
  app.use("/api/settings", requireAuth, settingsRouter);
  app.use("/api/planner", requireAuth, plannerRouter);
  app.use("/api/state", requireAuth, stateRouter);
  // exams are events with type='exam'
  app.get("/api/exams", requireAuth, asyncH((req, res) => {
    const rows = prepare("SELECT * FROM events WHERE user_id=? AND type='exam' ORDER BY date IS NULL, date ASC").all(req.user.id);
    res.json({ items: rows.map((r) => rowToApi(COLLECTIONS.events, r)), count: rows.length });
  }));
}

module.exports = { mount, COLLECTIONS };