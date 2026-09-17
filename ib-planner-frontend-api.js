/* ============================================================================
 * IB Planner — API client (vanilla JS, no dependencies)
 * Loaded AFTER the app script so it can back the app's global auth/save hooks.
 * ==========================================================================*/
(function () {
  "use strict";

  var BASE = (typeof window.IB_API_BASE === "string" ? window.IB_API_BASE : "").replace(/\/$/, "");
  var ACCESS_KEY = "ibplanner.access";
  var memoryAccess = null;

  function loadAccess() {
    if (memoryAccess) return memoryAccess;
    try { memoryAccess = sessionStorage.getItem(ACCESS_KEY) || null; } catch (e) { memoryAccess = null; }
    return memoryAccess;
  }
  function setAccess(token) {
    memoryAccess = token || null;
    try { token ? sessionStorage.setItem(ACCESS_KEY, token) : sessionStorage.removeItem(ACCESS_KEY); } catch (e) {}
  }

  function parse(res, text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return { error: { code: "bad_response", message: text.slice(0, 300) } }; }
  }

  var refreshing = null;

  /** Low-level request with one automatic refresh-and-retry on 401. */
  function request(path, options, isRetry) {
    var opts = options || {};
    var headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    var token = loadAccess();
    if (token && !opts.noAuth) headers.Authorization = "Bearer " + token;

    return fetch(BASE + path, {
      method: opts.method || "GET",
      headers: headers,
      credentials: "include",
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = parse(res, text);
        if (res.ok) return data;
        // expired access token -> rotate the refresh token, then retry once
        if (res.status === 401 && !isRetry && !opts.noAuth && token) {
          return refresh().then(function (ok) {
            if (ok) return request(path, Object.assign({}, opts, { noAuth: false }), true);
            throw normalize(res.status, data);
          }, function () { throw normalize(res.status, data); });
        }
        throw normalize(res.status, data);
      });
    }, function (netErr) {
      var e = new Error("Cannot reach the IB Planner server. Check that the backend is running.");
      e.code = "offline";
      e.status = 0;
      e.cause = netErr;
      throw e;
    });
  }

  function normalize(status, data) {
    var info = (data && data.error) || {};
    var err = new Error(info.message || (status === 401 ? "Please log in again." : "Request failed (" + status + ")."));
    err.status = status;
    err.code = info.code || "http_" + status;
    err.details = info.details || null;
    err.payload = data;
    return err;
  }

  /** Rotates the refresh cookie (which is httpOnly, so JS never sees the token). */
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = fetch(BASE + "/api/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: "{}"
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = parse(res, text);
        if (!res.ok) { setAccess(null); throw normalize(res.status, data); }
        if (data && data.accessToken) setAccess(data.accessToken);
        return true;
      });
    }).finally(function () { refreshing = null; });
    return refreshing;
  }

  window.IBAPI = {
    base: BASE,
    request: request,
    get: function (p, o) { return request(p, Object.assign({ method: "GET" }, o)); },
    post: function (p, body, o) { return request(p, Object.assign({ method: "POST", body: body }, o)); },
    put: function (p, body, o) { return request(p, Object.assign({ method: "PUT", body: body }, o)); },
    patch: function (p, body, o) { return request(p, Object.assign({ method: "PATCH", body: body }, o)); },
    del: function (p, body, o) { return request(p, Object.assign({ method: "DELETE", body: body }, o)); },
    refresh: refresh,
    setAccess: setAccess,
    getAccess: loadAccess,
    clearAccess: function () { setAccess(null); },
    errorMessage: function (err) {
      if (!err) return "Something went wrong.";
      if (err.code === "offline") return err.message;
      if (err.details && typeof err.details === "object") {
        var first = Object.keys(err.details).filter(function (k) { return k !== "_missing" })[0];
        if (first && typeof err.details[first] === "string") return err.details[first];
      }
      return err.message || "Something went wrong.";
    }
  };
})();