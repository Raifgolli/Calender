/* ============================================================================
 * IB Planner — backend sync adapter.
 *
 * The app in index.html is a self-contained classic script, so every top-level
 * `function foo(){}` / `var foo` is a property of `window`. Instead of rewriting
 * 40+ mutation sites, this adapter patches the four globals that matter:
 *
 *   window.registerUser / loginUser / logoutUser  -> real API calls
 *   window.save()                                 -> push snapshot to the API
 *   window.enterApp()                             -> attach the sync engine
 *
 * Everything else in the UI (calendar, Auto Planner, trackers, search, toasts)
 * keeps working untouched and now persists server-side.
 * ==========================================================================*/
(function () {
  "use strict";

  if (!window.IBAPI) {
    console.warn("[ibplanner] /js/api.js not loaded — running in local-only mode.");
    return;
  }
  var API = window.IBAPI;
  var PUSH_DELAY = 800;
  var POLL_MS = 60000;

  var state = { revision: null, timer: null, pushing: false, queued: false, lastErrorAt: 0, pollTimer: null, user: null };

  function localUserKey() { try { return localStorage.getItem("ibplanner.currentUser"); } catch (e) { return null; } }
  function setLocalUserKey(id) { try { id ? localStorage.setItem("ibplanner.currentUser", id) : localStorage.removeItem("ibplanner.currentUser"); } catch (e) {} }

  /** Snapshot of the in-memory app state, in the shape PUT /api/state expects. */
  function snapshot() {
    var d = window.CU && window.CU.data;
    if (!d) return null;
    return {
      onboarded: !!d.onboarded,
      state: {
        subjects: d.subjects || [],
        tasks: d.tasks || [],
        events: d.events || [],
        ia: d.ia || [],
        cas: d.cas || [],
        notifications: d.notifications || [],
        ee: d.ee || {},
        settings: d.settings || {},
        availability: d.availability || {},
        plan: d.plan || null
      }
    };
  }

  /** Wipes the localStorage mirror when a different account signs in on this device. */
  function resetLocalMirrorFor(userId) {
    var prev = localUserKey();
    if (prev && prev !== userId) {
      try {
        if (window.DB && window.DB.clearSession) window.DB.clearSession();
        if (window.DB && window.DB.saveUsers) window.DB.saveUsers([]);
      } catch (e) {}
    }
    setLocalUserKey(userId);
  }

  /** Merges a server snapshot into the running app and re-renders. */
  function applyState(payload, opts) {
    if (!window.CU) return;
    var d = window.CU.data;
    d.subjects = payload.subjects || [];
    d.tasks = payload.tasks || [];
    d.events = payload.events || [];
    d.ia = payload.ia || [];
    d.cas = payload.cas || [];
    d.notifications = payload.notifications || [];
    d.ee = payload.ee || d.ee || {};
    d.settings = Object.assign({}, d.settings || {}, payload.settings || {});
    d.availability = Object.assign({}, d.availability || {}, payload.availability || {});
    d.plan = payload.plan || null;
    if (payload.onboarded !== undefined) d.onboarded = !!payload.onboarded;
    if (payload.revision !== undefined && payload.revision !== null) state.revision = payload.revision;
    try { if (window.save) window.ORIG_SAVE && window.ORIG_SAVE(); } catch (e) {}
    if (opts && opts.render === false) return;
    try {
      if (window.renderShell) window.renderShell();
      if (window.navigate) window.navigate(window.State ? window.State.view : "dashboard");
      else if (window.renderDashboard) window.renderDashboard();
    } catch (e) { console.warn("[ibplanner] re-render after sync failed:", e); }
  }

  /** Push the current snapshot; retries once on a revision conflict. */
  function push(immediate) {
    var snap = snapshot();
    if (!snap || !window.CU) return Promise.resolve(false);
    if (state.pushing) { state.queued = true; return Promise.resolve(false); }

    if (!immediate) {
      clearTimeout(state.timer);
      state.timer = setTimeout(function () { push(true); }, PUSH_DELAY);
      return Promise.resolve(false);
    }

    state.pushing = true;
    var body = Object.assign({ baseRevision: state.revision }, snap);

    return API.put("/api/state", body).then(function (res) {
      state.revision = res.revision;
      if (window.CU) window.CU.data.onboarded = res.onboarded;
      return true;
    }).catch(function (err) {
      if (err.status === 409) {
        // Another device wrote first. Local wins by default, then we re-base and retry once,
        // and tell the student rather than dropping their edit silently.
        state.revision = err.payload && err.payload.error && err.payload.error.details
          ? err.payload.error.details.revision : null;
        if (window.toast) window.toast("Your changes were saved on top of a newer version from another device.", "wn");
        return API.put("/api/state", Object.assign({ baseRevision: state.revision }, snap))
          .then(function (res) { state.revision = res.revision; return true; })
          .catch(function () { return false; });
      }
      if (err.status === 401) { hardLogout("Your session expired. Please log in again."); return false; }
      var now = Date.now();
      if (now - state.lastErrorAt > 6000) {
        state.lastErrorAt = now;
        if (window.toast) window.toast("Could not sync with the server — your work is kept locally and will retry.", "wn", 5000);
      }
      return false;
    }).then(function (ok) {
      state.pushing = false;
      if (state.queued) { state.queued = false; return push(true); }
      return ok;
    });
  }

  /** Pull authoritative state from the server. */
  function pull(render) {
    return API.get("/api/state").then(function (payload) {
      applyState(payload, { render: render !== false });
      return true;
    }).catch(function (err) {
      if (err.status === 401) hardLogout("Your session expired. Please log in again.");
      return false;
    });
  }

  function userFromApi(apiUser, statePayload) {
    return {
      id: apiUser.id,
      name: apiUser.name,
      email: apiUser.email,
      year: apiUser.year,
      createdAt: apiUser.createdAt,
      data: Object.assign(window.newData ? window.newData() : {}, {
        onboarded: statePayload ? !!statePayload.onboarded : !!apiUser.onboarded,
        subjects: statePayload ? statePayload.subjects : [],
        tasks: statePayload ? statePayload.tasks : [],
        events: statePayload ? statePayload.events : [],
        ia: statePayload ? statePayload.ia : [],
        cas: statePayload ? statePayload.cas : [],
        notifications: statePayload ? statePayload.notifications : [],
        ee: statePayload ? statePayload.ee : {},
        settings: Object.assign({}, statePayload ? statePayload.settings : {}),
        availability: Object.assign({}, statePayload ? statePayload.availability : {}),
        plan: statePayload ? statePayload.plan : null
      })
    };
  }

  function hardLogout(msg) {
    API.clearAccess();
    setLocalUserKey(null);
    try { if (window.DB && window.DB.clearSession) window.DB.clearSession(); } catch (e) {}
    if (msg && window.toast) window.toast(msg, "wn");
    if (window.showScreen) window.showScreen("auth");
  }

  function startEngine() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(function () {
      if (document.hidden) return;
      pull(false);
    }, POLL_MS);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) pull(false);
    });
    window.addEventListener("beforeunload", function () {
      // best-effort flush so a quick tab close does not lose the last edit
      clearTimeout(state.timer);
      push(true);
    });
  }

  /* ------------------------------------------------------- patch: save() */
  var origSave = window.save;
  window.ORIG_SAVE = function () { try { return origSave && origSave.apply(window, arguments); } catch (e) {} };
  window.save = function () {
    window.ORIG_SAVE();          // keep the localStorage mirror for instant offline rendering
    return push(false);          // then persist to the database (debounced)
  };

  /* ------------------------------------------------- patch: enterApp(user) */
  var origEnterApp = window.enterApp;
  window.enterApp = function (user) {
    if (user) resetLocalMirrorFor(user.id);
    state.user = user || null;
    origEnterApp(user);
    startEngine();
    if (window.__IB_PUSH_AFTER_ENTER) { window.__IB_PUSH_AFTER_ENTER = false; push(true); }
  };

  /* --------------------------------------------------- patch: registerUser */
  window.registerUser = function (form) {
    return API.post("/api/auth/register", {
      name: form.name, email: form.email, password: form.password, year: form.year, sample: !!form.sample
    }).then(function (res) {
      API.setAccess(res.accessToken);
      var user = userFromApi(res.user, null);
      if (form.sample && window.sampleSubjects && window.samplePayload) {
        // reuse the frontend's own sample IB dataset, then persist it server-side
        var subjects = window.sampleSubjects();
        var payload = window.samplePayload(subjects);
        user.data = Object.assign(user.data, payload, { onboarded: true });
        window.__IB_PUSH_AFTER_ENTER = true;
      }
      return { user: user };
    }).catch(function (err) {
      return { err: API.errorMessage(err) };
    });
  };

  /* ------------------------------------------------------ patch: loginUser */
  window.loginUser = function (email, password) {
    return API.post("/api/auth/login", { email: email, password: password }).then(function (res) {
      API.setAccess(res.accessToken);
      return API.get("/api/state").then(function (snap) {
        state.revision = snap.revision;
        return { user: userFromApi(res.user, snap) };
      }, function () {
        return { user: userFromApi(res.user, null) };
      });
    }).catch(function (err) {
      return { err: API.errorMessage(err) };
    });
  };

  /* ----------------------------------------------------- patch: logoutUser */
  window.logoutUser = function () {
    return API.post("/api/auth/logout", {}).catch(function () {}).then(function () {
      API.clearAccess();
      setLocalUserKey(null);
      try { if (window.DB && window.DB.clearSession) window.DB.clearSession(); } catch (e) {}
      if (window.CU) window.CU = null;
      if (window.showScreen) window.showScreen("auth");
      if (window.toast) window.toast("You have been logged out.", "inf");
    });
  };

  /* ------------------------------------------------- password reset UI glue */
  function installForgotLink() {
    var form = document.getElementById("fLogin");
    if (!form || form.querySelector("[data-act='forgot']")) return;
    var btn = form.querySelector("button[type=submit]");
    if (!btn) return;
    btn.insertAdjacentHTML("afterend",
      '<p class="sm ct" style="margin-top:10px"><a href="#" data-act="forgot">Forgot your password?</a></p>');
  }

  function openForgotModal() {
    if (!window.formModal) return;
    window.formModal({
      title: "Reset your password",
      fields: [{ name: "email", label: "Account email", type: "email", required: true, full: true, placeholder: "you@school.edu" }],
      submitLabel: "Send reset link",
      onSubmit: function (d) {
        API.post("/api/auth/forgot-password", { email: d.email }).then(function (res) {
          if (window.toast) window.toast(res.message || "Check your inbox for the reset link.", "ok", 6000);
          if (res.devResetLink && window.openModal) {
            window.openModal({
              title: "Development mode — no SMTP configured",
              body: '<p class="sm mu">The reset email could not be sent, so here is the link directly. Configure <code>SMTP_*</code> in <code>.env</code> for real delivery.</p>' +
                    '<p><a href="' + res.devResetLink + '">' + res.devResetLink + "</a></p>",
              footer: '<button class="btn g" data-x="1">Close</button>'
            });
          }
        }).catch(function (err) { if (window.toast) window.toast(API.errorMessage(err), "er"); });
        return true;
      }
    });
  }

  function openResetModal(token) {
    if (!window.formModal) return;
    window.formModal({
      title: "Choose a new password",
      fields: [
        { name: "password", label: "New password", type: "password", required: true, full: true, hint: "at least 8 characters" },
        { name: "confirm", label: "Repeat password", type: "password", required: true, full: true }
      ],
      submitLabel: "Set new password",
      onSubmit: function (d) {
        if (d.password !== d.confirm) { window.toast("The two passwords do not match.", "wn"); return false; }
        API.post("/api/auth/reset-password", { token: token, password: d.password }).then(function (res) {
          window.toast(res.message || "Password updated. Please log in.", "ok", 6000);
          try { history.replaceState(null, "", location.pathname); } catch (e) {}
        }).catch(function (err) { window.toast(API.errorMessage(err), "er", 6000); });
        return true;
      }
    });
  }

  document.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("[data-act='forgot']")) {
      e.preventDefault();
      openForgotModal();
    }
  });

  /* ------------------------------------------------------------- bootstrap */
  var params = new URLSearchParams(location.search);
  var resetToken = params.get("reset");

  API.get("/api/auth/me").then(function (res) {
    // A valid refresh cookie means this device is still signed in: adopt the server state.
    return pull(true).then(function () {
      var u = userFromApi(res.user, null);
      window.__IB_PUSH_AFTER_ENTER = false;
      window.enterApp(u);
      if (resetToken) openResetModal(resetToken);
      if (window.toast) window.toast("Synced with your account — " + (window.CU ? window.CU.data.subjects.length : 0) + " subjects loaded.", "inf");
    });
  }).catch(function () {
    // No session (or backend unreachable): the app keeps its local-only behaviour.
    installForgotLink();
    if (resetToken) {
      if (window.showScreen) window.showScreen("auth");
      openResetModal(resetToken);
    }
    if (window.CU) { window.CU = null; }
    if (window.showScreen) window.showScreen("auth");
  });

  window.Sync = {
    push: push,
    pull: pull,
    start: startEngine,
    stop: function () { clearInterval(state.pollTimer); },
    revision: function () { return state.revision; }
  };
})();