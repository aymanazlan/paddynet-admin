/* PaddyNet Admin dashboard. Reads shared scans from Supabase (admins only) and shows them. */
(() => {
  "use strict";

  const CFG = window.PADDYNET_CONFIG || {};
  const { t } = window.I18N;
  const LABELS = ["Bacterial Leaf Blight", "Blast", "Brown Spot", "Normal"];
  const COLOR_VAR = {
    "Bacterial Leaf Blight": "--c-blb",
    "Blast": "--c-blast",
    "Brown Spot": "--c-brown",
    "Normal": "--c-normal",
  };
  const PAGES = ["overview", "trends", "map", "alerts", "scans", "model", "profile"];
  const SCAN_COLUMNS =
    "id,device_id,label,confidence,used_tta,inference_ms,scanned_at,received_at,area,latitude,longitude,app_version,model_version";
  const PAGE_SIZE = 25;
  const LOW_CONFIDENCE = 0.6;
  const DAY = 24 * 60 * 60 * 1000;
  const IDLE_WARNING_S = 60;
  const DEFAULT_SPOT = { name: "Sekinchan, Selangor", lat: 3.503, lng: 101.103 };

  const configured =
    typeof CFG.supabaseUrl === "string" && CFG.supabaseUrl.startsWith("https://") &&
    !CFG.supabaseUrl.includes("YOUR-") && typeof CFG.supabaseKey === "string" &&
    !CFG.supabaseKey.startsWith("YOUR_");
  const db = configured ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey) : null;

  const state = {
    user: null,
    scans: [],
    models: [],
    alerts: [],
    alertRule: { min: 3, radius: 1, days: 14 },
    page: "overview",
    scanPage: 0,
    hiddenOnMap: new Set(),
    cmMode: "tta",
    loadedAt: null,
    fresh: new Set(),
    realtime: false,
    weather: null,        // { key, at, data, place }
  };
  let trendChart = null;
  let dailyChart = null;
  let map = null;
  let mapLayer = null;
  let pollTimer = null;
  let rtChannel = null;
  let lastActivity = Date.now();
  let idleWarning = null;

  const $ = (id) => document.getElementById(id);

  // ---------- preferences (saved in this browser) ----------
  const prefs = Object.assign(
    { theme: "system", motion: "on", refresh: 60, period: 30, idle: 30, folded: false },
    readJson("pn-prefs"),
  );
  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (e) { return {}; }
  }
  function savePrefs() {
    try { localStorage.setItem("pn-prefs", JSON.stringify(prefs)); } catch (e) { /* private mode */ }
  }

  // ---------- helpers ----------
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }
  const loc = () => window.I18N.locale;
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const colorOf = (label) => cssVar(COLOR_VAR[label] || "--muted");
  const labelName = (label) => (LABELS.includes(label) ? t(`label.${label}`) : label);
  const swatch = (label) => `<span class="swatch" style="background:${colorOf(label)}"></span>`;
  const fmtInt = (n) => Number(n).toLocaleString(loc());
  const fmtPct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;
  const fmtDate = (d) => new Date(d).toLocaleDateString(loc(), { day: "numeric", month: "short", year: "numeric" });
  const fmtDateTime = (d) => new Date(d).toLocaleString(loc(), {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const fmtTime = (d) => new Date(d).toLocaleTimeString(loc(), { hour: "2-digit", minute: "2-digit" });
  function timeAgo(d) {
    const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return t("ago.now");
    if (s < 3600) return t("ago.min", { n: Math.floor(s / 60) });
    if (s < 86400) return t("ago.h", { n: Math.floor(s / 3600) });
    if (s < 2 * 86400) return t("ago.yesterday");
    if (s < 7 * 86400) return t("ago.days", { n: Math.floor(s / 86400) });
    return fmtDate(d);
  }
  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
  }
  function rangeDays() { return Number($("range").value); }
  function inWindow(scans, fromMs, toMs) {
    return scans.filter((s) => {
      const x = new Date(s.scanned_at).getTime();
      return x >= fromMs && x < toMs;
    });
  }
  function scansInRange() {
    const days = rangeDays();
    if (!days) return state.scans;
    return inWindow(state.scans, Date.now() - days * DAY, Infinity);
  }
  function countBy(items, key) {
    const out = new Map();
    for (const item of items) {
      const k = typeof key === "function" ? key(item) : item[key];
      out.set(k, (out.get(k) || 0) + 1);
    }
    return out;
  }
  const isDiseased = (s) => s.label !== "Normal";
  const median = (values) => {
    if (!values.length) return null;
    const v = [...values].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  };
  const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  const areaKey = (s) => (s.area ? s.area.trim().toLowerCase() : null);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function displayName(user = state.user) {
    if (!user) return "";
    const name = user.user_metadata && user.user_metadata.full_name;
    if (name && name.trim()) return name.trim();
    const local = (user.email || "").split("@")[0].replace(/[._\d]+/g, " ").trim();
    return local ? local.charAt(0).toUpperCase() + local.slice(1) : user.email;
  }
  function initials(name) {
    const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }
  function greeting(date = new Date()) {
    const h = date.getHours();
    if (h < 12) return t("greet.morning");
    if (window.I18N.lang === "ms") {
      if (h < 14) return t("greet.noon");
      if (h < 19) return t("greet.afternoon");
      return t("greet.evening");
    }
    return h < 18 ? t("greet.afternoon") : t("greet.evening");
  }

  // ---------- theme and motion ----------
  const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const reducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function currentTheme() {
    if (prefs.theme === "light" || prefs.theme === "dark") return prefs.theme;
    return darkQuery && darkQuery.matches ? "dark" : "light";
  }
  function applyTheme() {
    const theme = currentTheme();
    document.documentElement.setAttribute("data-theme", theme);
    $("theme-icon").setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
    const label = theme === "dark" ? t("top.light") : t("top.dark");
    $("theme-button").title = label;
    $("theme-button").setAttribute("aria-label", label);
  }
  function applyMotion() {
    document.body.classList.toggle("no-motion", prefs.motion === "off");
  }

  // ---------- clock ----------
  function tickClock() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat(loc(), { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })
      .formatToParts(now);
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
    if (!$("login-view").hidden) {
      $("login-time").textContent = `${get("hour")}:${get("minute")}`;
      $("login-seconds").textContent = `:${get("second")} ${get("dayPeriod")}`.trimEnd();
      $("login-date").textContent = now.toLocaleDateString(loc(), { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      $("login-greet").textContent = greeting(now);
    }
    if (!$("app-view").hidden) {
      $("clock-time").textContent = now.toLocaleTimeString(loc(), { hour: "numeric", minute: "2-digit", second: "2-digit" });
      $("clock-date").textContent = now.toLocaleDateString(loc(), { weekday: "short", day: "numeric", month: "short", year: "numeric" });
      $("top-greet").textContent = `${greeting(now)}, ${displayName()}`;
    }
  }

  // ---------- popup ----------
  let modalOnClose = null;
  function openModal({ title, body, actions = [], wide = false, onClose = null }) {
    $("modal-title").textContent = title;
    $("modal-body").innerHTML = body;
    const box = $("modal-actions");
    box.innerHTML = "";
    for (const a of actions) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `btn ${a.cls || ""}`;
      b.textContent = a.label;
      b.addEventListener("click", a.onClick || closeModal);
      box.appendChild(b);
    }
    document.querySelector(".modal-card").classList.toggle("wide", wide);
    modalOnClose = onClose;
    $("modal").hidden = false;
    const focus = box.querySelector(".btn-primary, .btn-danger-solid") || box.querySelector("button") || $("modal-x");
    focus.focus();
  }
  function closeModal() {
    if ($("modal").hidden) return;
    $("modal").hidden = true;
    const cb = modalOnClose;
    modalOnClose = null;
    if (cb) cb();
  }
  function confirmBox({ title, body, okLabel, onOk, danger = true, icon = "#i-logout" }) {
    openModal({
      title,
      body: `${danger ? `<div class="modal-icon"><svg class="icon"><use href="${icon}"/></svg></div>` : ""}<p class="muted">${escapeHtml(body)}</p>`,
      actions: [
        { label: t("cancel"), cls: "" },
        { label: okLabel, cls: danger ? "btn-danger-solid" : "btn-primary", onClick: () => { closeModal(); onOk(); } },
      ],
    });
  }

  // ---------- dropdown menus ----------
  function setMenu(buttonId, menuId, open) {
    $(menuId).hidden = !open;
    $(buttonId).setAttribute("aria-expanded", String(open));
  }
  function closeMenus() {
    setMenu("bell-button", "bell-menu", false);
    setMenu("user-button", "user-menu", false);
  }

  // ---------- login ----------
  function clearLoginForm() {
    $("login-form").reset();
    $("login-email").value = "";
    $("login-password").value = "";
    $("login-password").type = "password";
    $("pw-toggle").classList.remove("on");
    // Read-only until clicked, so the browser does not fill in saved details by itself
    $("login-email").setAttribute("readonly", "");
    $("login-password").setAttribute("readonly", "");
  }
  function setLoginBusy(busy) {
    $("login-button").disabled = busy;
    $("login-button").classList.toggle("busy", busy);
    $("login-button-text").textContent = busy ? t("login.checking") : t("login.button");
  }
  function showLogin(message, info) {
    stopLive();
    closeModal();
    closeMenus();
    $("app-view").hidden = true;
    $("boot").hidden = true;
    $("login-view").hidden = false;
    $("login-form").classList.remove("leaving");
    clearLoginForm();
    setLoginBusy(false);
    playLoginVideo(true);
    $("login-error").hidden = !message;
    $("login-error").textContent = message || "";
    $("login-info").hidden = !info;
    $("login-info").textContent = info || "";
    if (!configured) {
      $("config-warning").hidden = false;
      $("login-button").disabled = true;
    }
    tickClock();
  }

  // Background video only plays while the login page is showing (saves battery and CPU)
  function playLoginVideo(on) {
    const video = $("login-video");
    if (!video) return;
    if (on && !reducedMotion()) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  // ---------- loading screen ----------
  function setBootStep(step) {
    document.querySelectorAll("#boot-steps li").forEach((li) => {
      const n = Number(li.dataset.step);
      li.classList.toggle("done", n < step);
      li.classList.toggle("now", n === step);
    });
    $("boot-bar").style.width = `${Math.min(100, ((step - 1) / 4) * 100)}%`;
  }

  async function checkAdmin() {
    const { data: isAdmin, error } = await db.rpc("is_admin");
    if (error) return t("login.checkFail", { msg: error.message });
    if (!isAdmin) return t("login.notAdmin");
    return null;
  }

  async function startApp(session) {
    const started = Date.now();
    state.user = session.user;
    $("boot-title").textContent = t("boot.welcome", { name: displayName() });
    $("boot").classList.remove("fade");
    $("boot").hidden = false;
    $("login-form").classList.add("leaving");
    setBootStep(2);

    const problem = await checkAdmin();
    if (problem) {
      await db.auth.signOut();
      showLogin(problem);
      return;
    }
    setBootStep(3);
    await loadData({ silent: true });
    setBootStep(4);

    // Show the app behind the loading screen, then fade the loading screen away
    $("login-view").hidden = true;
    playLoginVideo(false);
    clearLoginForm();
    $("app-view").hidden = false;
    renderUser();
    tickClock();
    goTo(location.hash.slice(1) || "overview");
    await sleep(Math.max(250, 1900 - (Date.now() - started)));
    setBootStep(5);
    await sleep(350);
    $("boot").classList.add("fade");
    setTimeout(() => { $("boot").hidden = true; }, 500);

    lastActivity = Date.now();
    startLive();
  }

  async function signOut({ scope = "local", info = t("login.signedOut") } = {}) {
    stopLive();
    try { await db.auth.signOut({ scope }); } catch (e) { /* signed out locally anyway */ }
    state.user = null;
    state.scans = [];
    state.alerts = [];
    state.weather = null;
    state.loadedAt = null;
    state.fresh.clear();
    history.replaceState(null, "", location.pathname);
    showLogin(null, info);
  }

  function initAuth() {
    $("login-email").addEventListener("focus", (e) => e.target.removeAttribute("readonly"));
    $("login-password").addEventListener("focus", (e) => e.target.removeAttribute("readonly"));
    $("pw-toggle").addEventListener("click", () => {
      const input = $("login-password");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      $("pw-toggle").classList.toggle("on", show);
    });
    $("login-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!db) return;
      setLoginBusy(true);
      $("login-error").hidden = true;
      $("login-info").hidden = true;
      const { data, error } = await db.auth.signInWithPassword({
        email: $("login-email").value.trim(),
        password: $("login-password").value,
      });
      if (error) {
        setLoginBusy(false);
        $("login-error").textContent = error.message === "Invalid login credentials" ? t("login.wrong") : error.message;
        $("login-error").hidden = false;
        $("login-password").value = "";
        return;
      }
      setBootStep(1);
      await startApp(data.session);
    });
    $("logout-button").addEventListener("click", () => {
      closeMenus();
      confirmBox({ title: t("so.title"), body: t("so.body"), okLabel: t("so.ok"), onOk: () => signOut() });
    });
    $("signout-all").addEventListener("click", () => {
      confirmBox({ title: t("soAll.title"), body: t("soAll.body"), okLabel: t("p.signoutAll"), onOk: () => signOut({ scope: "global" }) });
    });

    if (!db) { showLogin(); return; }
    db.auth.getSession().then(({ data }) => {
      if (data.session) {
        setBootStep(1);
        startApp(data.session);
      } else {
        showLogin();
      }
    });
  }

  // ---------- data ----------
  async function fetchAllScans() {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("scans").select(SCAN_COLUMNS)
        .order("scanned_at", { ascending: false }).range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000 || out.length >= 100000) break;
    }
    return out;
  }

  async function fetchAlerts() {
    const r = state.alertRule;
    const { data, error } = await db.rpc("outbreak_alerts", {
      min_scans: r.min, radius_km: r.radius, window_days: r.days,
    });
    if (error) throw error;
    state.alerts = data || [];
  }

  async function loadData({ silent = false } = {}) {
    if (loadData.busy) return;
    loadData.busy = true;
    $("refresh-button").disabled = true;
    if (!silent) $("load-error").hidden = true;
    try {
      const [scans, models] = await Promise.all([
        fetchAllScans(),
        db.from("model_versions").select("*").order("released_at", { ascending: false }),
        fetchAlerts(),
      ]);
      if (models.error) throw models.error;
      if (state.loadedAt && state.scans.length) {
        const known = new Set(state.scans.map((s) => s.id));
        for (const s of scans) if (!known.has(s.id)) markFresh(s.id);
      }
      state.scans = scans;
      state.models = models.data || [];
      state.loadedAt = new Date();
      $("load-error").hidden = true;
    } catch (error) {
      $("load-error").textContent = t("load.fail", { msg: error.message || error });
      $("load-error").hidden = false;
    } finally {
      loadData.busy = false;
      $("refresh-button").disabled = false;
    }
    updateAlertBadges();
    updateLive();
    renderPage();
  }

  function markFresh(id) {
    state.fresh.add(id);
    setTimeout(() => state.fresh.delete(id), 6000);
  }

  // ---------- live updates ----------
  function startLive() {
    stopLive();
    if (prefs.refresh > 0) {
      pollTimer = setInterval(() => {
        if ($("app-view").hidden || document.hidden || !navigator.onLine) return;
        loadData({ silent: true });
      }, prefs.refresh * 1000);
    }
    if (db && db.channel) {
      rtChannel = db.channel("scans-live")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "scans" }, (payload) => onScanInserted(payload.new))
        .on("postgres_changes", { event: "DELETE", schema: "public", table: "scans" }, (payload) => onScanDeleted(payload.old))
        .subscribe((status) => {
          state.realtime = status === "SUBSCRIBED";
          updateLive();
        });
    }
    updateLive();
  }
  function stopLive() {
    clearInterval(pollTimer);
    pollTimer = null;
    if (rtChannel && db) db.removeChannel(rtChannel);
    rtChannel = null;
    state.realtime = false;
  }

  function onScanInserted(scan) {
    if (!scan || !scan.id || state.scans.some((s) => s.id === scan.id)) return;
    state.scans.unshift(scan);
    state.scans.sort((a, b) => (a.scanned_at < b.scanned_at ? 1 : -1));
    markFresh(scan.id);
    toast(t("rt.new", { label: labelName(scan.label), area: scan.area || t("ov.noArea") }));
    scheduleRender(true);
  }
  function onScanDeleted(old) {
    if (!old || !old.id) return;
    state.scans = state.scans.filter((s) => s.id !== old.id);
    scheduleRender(false);
  }
  // Group bursts of changes into one redraw, and re-check outbreak alerts after new scans
  function scheduleRender(recheckAlerts) {
    clearTimeout(scheduleRender.timer);
    scheduleRender.recheck = scheduleRender.recheck || recheckAlerts;
    scheduleRender.timer = setTimeout(async () => {
      if (scheduleRender.recheck) {
        scheduleRender.recheck = false;
        try { await fetchAlerts(); } catch (e) { /* keep the old alerts */ }
        updateAlertBadges();
      }
      state.loadedAt = new Date();
      updateLive();
      renderPage();
    }, 600);
  }

  function updateLive() {
    const el = $("live");
    let mode;
    if (!navigator.onLine) mode = "off";
    else if (state.realtime) mode = "on";
    else if (prefs.refresh > 0) mode = "poll";
    else mode = "paused";
    el.className = `live ${mode}`;
    $("live-text").textContent = t({ on: "top.live", poll: "top.auto", paused: "top.paused", off: "top.offline" }[mode]);
    const time = state.loadedAt ? fmtTime(state.loadedAt) : "–";
    el.title = t({ on: "top.liveTip", poll: "top.autoTip", paused: "top.pausedTip", off: "top.offlineTip" }[mode], { time, s: prefs.refresh });
  }

  function updateAlertBadges() {
    const n = state.alerts.length;
    $("nav-alert-count").hidden = n === 0;
    $("nav-alert-count").textContent = n;
    $("bell-count").hidden = n === 0;
    $("bell-count").textContent = n > 9 ? "9+" : n;
    $("bell-list").innerHTML = n === 0
      ? `<li class="muted small">${escapeHtml(t("top.noAlerts"))}</li>`
      : state.alerts.slice(0, 6).map((a, i) => `<li class="alert-item" data-alert="${i}">
          ${swatch(a.label)}<b>${escapeHtml(labelName(a.label))}</b><br>
          <span class="sub">${escapeHtml(a.area || "–")} · ${t("map.within", { n: fmtInt(a.scan_count), km: state.alertRule.radius })} · ${timeAgo(a.last_seen)}</span>
        </li>`).join("");
  }
  function showAlertOnMap(i) {
    const a = state.alerts[i];
    if (!a) return;
    closeMenus();
    goTo("map");
    map.fitPending = false;
    map.setView([a.center_lat, a.center_lng], 14);
  }

  // ---------- idle sign-out ----------
  function noteActivity() {
    lastActivity = Date.now();
    if (idleWarning) {
      clearInterval(idleWarning);
      idleWarning = null;
      closeModal();
    }
  }
  function checkIdle() {
    if (!prefs.idle || $("app-view").hidden) return;
    const limit = prefs.idle * 60 * 1000;
    const idleFor = Date.now() - lastActivity;
    if (idleFor >= limit) {
      clearInterval(idleWarning);
      idleWarning = null;
      signOut({ info: t("login.idle") });
    } else if (idleFor >= limit - IDLE_WARNING_S * 1000 && !idleWarning) {
      const body = () => `<p class="muted">${escapeHtml(t("idle.body", { s: Math.max(0, Math.ceil((limit - (Date.now() - lastActivity)) / 1000)) }))}</p>`;
      openModal({
        title: t("idle.title"),
        body: body(),
        actions: [{ label: t("idle.stay"), cls: "btn-primary", onClick: noteActivity }],
        onClose: () => { lastActivity = Date.now(); clearInterval(idleWarning); idleWarning = null; },
      });
      idleWarning = setInterval(() => {
        $("modal-body").innerHTML = body();
        checkIdle();
      }, 1000);
    }
  }

  // ---------- navigation ----------
  const isMobile = () => window.matchMedia("(max-width: 820px)").matches;
  function goTo(page) {
    if (!PAGES.includes(page)) page = "overview";
    state.page = page;
    for (const name of PAGES) $(`page-${name}`).hidden = name !== page;
    for (const a of document.querySelectorAll("#nav a")) a.classList.toggle("active", a.dataset.page === page);
    $("page-title").textContent = t(`nav.${page}`);
    $("filters").hidden = page === "profile";
    $("print-button").hidden = page !== "overview";
    if (location.hash.slice(1) !== page) history.replaceState(null, "", `#${page}`);
    $("app-view").classList.remove("nav-open");
    closeMenus();
    renderPage();
  }

  function renderPage() {
    if ($("app-view").hidden) return;
    ({
      overview: renderOverview, trends: renderTrends, map: renderMap,
      alerts: renderAlerts, scans: renderScans, model: renderModel, profile: renderProfile,
    })[state.page]();
  }

  function applyFold() {
    $("app-view").classList.toggle("folded", !!prefs.folded);
    const key = prefs.folded ? "nav.unfold" : "nav.fold";
    $("fold-button").title = t(key);
    $("fold-button").setAttribute("aria-label", t(key));
    // Show page names as tooltips when only icons are visible
    document.querySelectorAll("#nav a").forEach((a) => { a.title = prefs.folded ? t(`nav.${a.dataset.page}`) : ""; });
    setTimeout(() => {
      if (map) map.invalidateSize();
      if (trendChart) trendChart.resize();
      if (dailyChart) dailyChart.resize();
    }, 300);
  }

  function renderUser() {
    const name = displayName();
    const ini = initials(name);
    for (const id of ["avatar", "menu-avatar", "profile-avatar"]) $(id).textContent = ini;
    $("user-name").textContent = name;
    $("menu-name").textContent = name;
    $("menu-email").textContent = state.user ? state.user.email : "";
  }

  // ---------- overview ----------
  function delta(el, cur, prev, { goodWhenUp = true, points = false } = {}) {
    const days = rangeDays();
    if (!days || prev == null) { el.innerHTML = ""; el.className = "tile-delta"; return; }
    const vs = `<span class="vs">${escapeHtml(t("delta.vs", { days }))}</span>`;
    let text;
    let dir;
    if (points) {
      const d = Math.round((cur - prev) * 100);
      dir = Math.sign(d);
      text = d === 0 ? t("delta.same") : `${d > 0 ? "▲" : "▼"} ${Math.abs(d)} ${t("delta.pts")}`;
    } else if (prev === 0) {
      dir = cur > 0 ? 1 : 0;
      text = cur > 0 ? `▲ ${t("delta.new")}` : t("delta.same");
    } else {
      const d = Math.round(((cur - prev) / prev) * 100);
      dir = Math.sign(d);
      text = d === 0 ? t("delta.same") : `${d > 0 ? "▲" : "▼"} ${Math.abs(d)}%`;
    }
    el.className = `tile-delta ${dir === 0 ? "flat" : (dir > 0) === goodWhenUp ? "good" : "bad"}`;
    el.innerHTML = `${escapeHtml(text)} ${vs}`;
  }

  function renderOverview() {
    const days = rangeDays();
    const scans = scansInRange();
    const prev = days ? inWindow(state.scans, Date.now() - 2 * days * DAY, Date.now() - days * DAY) : null;
    const total = scans.length;
    const diseased = scans.filter(isDiseased).length;
    const areas = new Set(scans.map(areaKey).filter(Boolean));
    const noArea = scans.filter((s) => !s.area).length;
    const devices = new Set(scans.map((s) => s.device_id)).size;

    $("t-total").textContent = fmtInt(total);
    $("t-total-sub").textContent = t("sub.allTime", { n: fmtInt(state.scans.length) });
    $("t-diseased").textContent = total ? fmtPct(diseased / total, 0) : "–";
    $("t-diseased-sub").textContent = t("sub.ofScans", { a: fmtInt(diseased), b: fmtInt(total) });
    $("t-devices").textContent = fmtInt(devices);
    $("t-areas").textContent = fmtInt(areas.size);
    $("t-areas-sub").textContent = noArea ? t("sub.noArea", { n: fmtInt(noArea) }) : t("sub.allArea");
    $("t-alerts").textContent = fmtInt(state.alerts.length);
    $("t-alerts").classList.toggle("has-alerts", state.alerts.length > 0);
    $("t-alerts-sub").textContent = t("tile.alertsSub", { days: state.alertRule.days });

    if (prev) {
      const prevDiseased = prev.filter(isDiseased).length;
      delta($("t-total-delta"), total, prev.length);
      delta($("t-diseased-delta"), total ? diseased / total : 0, prev.length ? prevDiseased / prev.length : null, { goodWhenUp: false, points: true });
      delta($("t-devices-delta"), devices, new Set(prev.map((s) => s.device_id)).size);
      delta($("t-areas-delta"), areas.size, new Set(prev.map(areaKey).filter(Boolean)).size);
    } else {
      for (const id of ["t-total-delta", "t-diseased-delta", "t-devices-delta", "t-areas-delta"]) delta($(id), 0, null);
    }

    renderDailyChart(scans);
    renderWeather();

    const counts = countBy(scans, "label");
    $("split-bars").innerHTML = total === 0
      ? `<p class="empty">${escapeHtml(t("ov.noScansPeriod"))}</p>`
      : LABELS.map((label) => {
          const n = counts.get(label) || 0;
          const share = n / total;
          return `<div>
            <div class="hbar-top"><span>${swatch(label)}${escapeHtml(labelName(label))}</span>
              <span class="num">${fmtInt(n)} · ${fmtPct(share, 0)}</span></div>
            <div class="hbar-track"><div class="hbar-fill" style="width:${(share * 100).toFixed(1)}%;background:${colorOf(label)}"></div></div>
          </div>`;
        }).join("");

    const latest = state.scans.slice(0, 6);
    $("latest-list").innerHTML = latest.length === 0
      ? `<li class="empty">${escapeHtml(t("ov.noScans"))}</li>`
      : latest.map((s) => `<li data-scan="${escapeHtml(s.id)}" class="${state.fresh.has(s.id) ? "fresh" : ""}">
          <span>${swatch(s.label)}<b>${escapeHtml(labelName(s.label))}</b> <span class="sub">${fmtPct(s.confidence)}</span><br>
            <span class="sub">${escapeHtml(s.area || t("ov.noArea"))}</span></span>
          <span class="sub">${timeAgo(s.scanned_at)}</span>
        </li>`).join("");

    $("ov-alerts").innerHTML = state.alerts.length === 0
      ? `<li class="empty">${escapeHtml(t("al.empty"))}</li>`
      : state.alerts.slice(0, 5).map((a, i) => `<li data-alert="${i}">
          <span>${swatch(a.label)}<b>${escapeHtml(labelName(a.label))}</b><br>
            <span class="sub">${escapeHtml(a.area || "–")} · ${t("map.within", { n: fmtInt(a.scan_count), km: state.alertRule.radius })}</span></span>
          <span class="sub">${timeAgo(a.last_seen)}</span>
        </li>`).join("");
  }

  /** Daily (or weekly) totals: all scans and scans with disease. */
  function renderDailyChart(scans) {
    const days = rangeDays();
    const daily = days > 0 && days <= 90;
    const bucketOf = daily ? startOfDay : startOfWeek;
    $("daily-title").textContent = daily ? t("ov.daily") : t("ov.weekly");
    const { buckets, index } = makeBuckets(scans, days, bucketOf, daily);
    const all = new Array(buckets.length).fill(0);
    const sick = new Array(buckets.length).fill(0);
    for (const s of scans) {
      const i = index.get(bucketOf(new Date(s.scanned_at)).getTime());
      if (i === undefined) continue;
      all[i] += 1;
      if (isDiseased(s)) sick[i] += 1;
    }
    const primary = cssVar("--primary");
    const red = cssVar("--c-blast");
    $("daily-legend").innerHTML =
      `<span><span class="legend-line" style="background:${primary}"></span>${escapeHtml(t("ov.all"))}</span>` +
      `<span><span class="legend-line" style="background:${red}"></span>${escapeHtml(t("ov.withDisease"))}</span>`;
    $("daily-chart").setAttribute("aria-label", $("daily-title").textContent);
    const labels = buckets.map((b) => new Date(b).toLocaleDateString(loc(), { day: "numeric", month: "short" }));
    const datasets = [
      { label: t("ov.all"), data: all, borderColor: primary, backgroundColor: `${primary}29`, fill: true },
      { label: t("ov.withDisease"), data: sick, borderColor: red, backgroundColor: "transparent", fill: false },
    ].map((d) => ({ ...d, cubicInterpolationMode: "monotone", borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 4 }));
    if (dailyChart) {
      dailyChart.data.labels = labels;
      dailyChart.data.datasets = datasets;
      dailyChart.options.scales.x.ticks.color = cssVar("--muted");
      dailyChart.options.scales.y.ticks.color = cssVar("--muted");
      dailyChart.options.scales.y.grid.color = cssVar("--grid");
      dailyChart.update("none");
      return;
    }
    dailyChart = new Chart($("daily-chart"), {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: cssVar("--muted"), font: { family: "Nunito" }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
          y: { beginAtZero: true, grid: { color: cssVar("--grid") }, border: { display: false },
               ticks: { color: cssVar("--muted"), precision: 0, font: { family: "Nunito" } } },
        },
      },
    });
  }

  // ---------- weather and disease risk ----------
  function weatherSpot() {
    const located = scansInRange().filter((s) => s.latitude != null && s.longitude != null);
    if (!located.length) return { ...DEFAULT_SPOT, isDefault: true };
    // The area with the most scans that have a location
    const groups = new Map();
    for (const s of located) {
      const key = areaKey(s) || `${s.latitude.toFixed(1)},${s.longitude.toFixed(1)}`;
      if (!groups.has(key)) groups.set(key, { name: s.area ? s.area.trim() : null, pts: [] });
      groups.get(key).pts.push(s);
    }
    const best = [...groups.values()].sort((a, b) => b.pts.length - a.pts.length)[0];
    const lat = average(best.pts.map((s) => s.latitude));
    const lng = average(best.pts.map((s) => s.longitude));
    return { name: best.name || `${lat.toFixed(2)}, ${lng.toFixed(2)}`, lat, lng, isDefault: false };
  }

  async function renderWeather() {
    const spot = weatherSpot();
    const key = `${spot.lat.toFixed(2)},${spot.lng.toFixed(2)}`;
    const w = state.weather;
    if (w && w.key === key && Date.now() - w.at < 30 * 60 * 1000) {
      drawWeather(spot, w.data);
      return;
    }
    if (renderWeather.loading === key) return;
    renderWeather.loading = key;
    if (!w || w.key !== key) $("weather-body").innerHTML = `<p class="muted">${escapeHtml(t("w.loading"))}</p>`;
    try {
      const url = "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
        latitude: spot.lat.toFixed(3),
        longitude: spot.lng.toFixed(3),
        current: "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
        hourly: "relative_humidity_2m",
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
        timezone: "Asia/Kuala_Lumpur",
        forecast_days: "3",
      });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.weather = { key, at: Date.now(), data };
      if (state.page === "overview") drawWeather(spot, data);
    } catch (e) {
      if (!state.weather || state.weather.key !== key) {
        $("weather-body").innerHTML = `<p class="muted">${escapeHtml(t("w.fail"))}</p>`;
      }
    } finally {
      renderWeather.loading = null;
    }
  }

  function weatherText(code) {
    if (code === 0) return t("wc.clear");
    if (code <= 2) return t("wc.partly");
    if (code === 3) return t("wc.cloudy");
    if (code === 45 || code === 48) return t("wc.fog");
    if (code >= 51 && code <= 57) return t("wc.drizzle");
    if (code >= 80 && code <= 82) return t("wc.showers");
    if (code >= 95) return t("wc.thunder");
    if (code >= 61) return t("wc.rain");
    return t("wc.cloudy");
  }

  /** A rough, explainable guide from the forecast. Not a diagnosis. */
  function weatherRisks(data) {
    const d = data.daily;
    const humid = (data.hourly && data.hourly.relative_humidity_2m) || [];
    const wetHours = humid.filter((h) => h >= 90).length;
    const nightMin = average(d.temperature_2m_min) ?? 0;
    const dayMax = Math.max(...d.temperature_2m_max);
    const rainMax = Math.max(...d.precipitation_sum);
    const windMax = Math.max(...d.wind_speed_10m_max);
    const level = (high, med) => (high ? "high" : med ? "med" : "low");
    return [
      { label: "Blast", level: level(wetHours >= 24 && nightMin >= 18 && nightMin <= 26, wetHours >= 10 && nightMin >= 16 && nightMin <= 28),
        why: t("w.why.blast", { n: wetHours, t: nightMin.toFixed(0) }) },
      { label: "Bacterial Leaf Blight", level: level(rainMax >= 40 || (windMax >= 35 && rainMax >= 10), rainMax >= 15 || windMax >= 25),
        why: t("w.why.blb", { mm: rainMax.toFixed(0), kmh: windMax.toFixed(0) }) },
      { label: "Brown Spot", level: level(dayMax >= 30 && wetHours >= 24, dayMax >= 28 && wetHours >= 10),
        why: t("w.why.brown", { t: dayMax.toFixed(0), n: wetHours }) },
    ];
  }

  function drawWeather(spot, data) {
    const c = data.current || {};
    const d = data.daily;
    const place = spot.isDefault ? t("w.default", { place: spot.name }) : spot.name;
    const days = d.time.map((day, i) => `<div class="weather-day">
        <b>${escapeHtml(new Date(`${day}T12:00:00`).toLocaleDateString(loc(), { weekday: "short" }))}</b>
        ${escapeHtml(weatherText(d.weather_code[i]))}<br>
        ${Math.round(d.temperature_2m_max[i])}° / ${Math.round(d.temperature_2m_min[i])}°<br>
        <span class="muted">${d.precipitation_sum[i].toFixed(0)} mm</span>
      </div>`).join("");
    const risks = weatherRisks(data).map((r) => `<div class="risk"><span>${swatch(r.label)}${escapeHtml(labelName(r.label))}</span>
        <span class="risk-pill risk-${r.level}">${escapeHtml(t(`w.${r.level}`))}</span></div>
        <p class="risk-why">${escapeHtml(r.why)}</p>`).join("");
    $("weather-body").innerHTML = `
      <p class="weather-place">${escapeHtml(t("w.for", { place }))}</p>
      <div class="weather-now">
        <span class="weather-temp">${c.temperature_2m != null ? Math.round(c.temperature_2m) : "–"}°C</span>
        <div><b>${escapeHtml(weatherText(c.weather_code))}</b>
          <div class="weather-meta">
            <span>${escapeHtml(t("w.humid"))} ${c.relative_humidity_2m ?? "–"}%</span>
            <span>${escapeHtml(t("w.wind"))} ${c.wind_speed_10m != null ? Math.round(c.wind_speed_10m) : "–"} km/h</span>
          </div></div>
      </div>
      <div class="weather-days">${days}</div>
      <p class="risk-title">${escapeHtml(t("w.risk"))}</p>
      ${risks}
      <p class="weather-note">${escapeHtml(t("w.note"))}</p>`;
  }

  // ---------- trends ----------
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function startOfWeek(d) {
    const x = startOfDay(d);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
    return x;
  }
  // Every bucket in the period, so empty days or weeks show as gaps, not missing
  function makeBuckets(scans, days, bucketOf, daily) {
    const end = bucketOf(new Date());
    let start;
    if (days) start = bucketOf(new Date(Date.now() - (days - 1) * DAY));
    else if (scans.length) start = bucketOf(new Date(Math.min(...scans.map((s) => new Date(s.scanned_at).getTime()))));
    else start = end;
    const buckets = [];
    for (let x = new Date(start); x <= end; x.setDate(x.getDate() + (daily ? 1 : 7))) buckets.push(new Date(x).getTime());
    return { buckets, index: new Map(buckets.map((b, i) => [b, i])) };
  }

  function isTopOfStack(ctx) {
    const sets = ctx.chart.data.datasets;
    for (let d = sets.length - 1; d > ctx.datasetIndex; d--) {
      if (ctx.chart.isDatasetVisible(d) && sets[d].data[ctx.dataIndex] > 0) return false;
    }
    return true;
  }

  function renderTrends() {
    const scans = scansInRange();
    const days = rangeDays();
    const daily = days > 0 && days <= 30;
    const bucketOf = daily ? startOfDay : startOfWeek;
    $("trend-title").textContent = daily ? t("ov.daily") : t("ov.weekly");
    $("trend-chart").setAttribute("aria-label", $("trend-title").textContent);
    const { buckets, index } = makeBuckets(scans, days, bucketOf, daily);

    const series = Object.fromEntries(LABELS.map((l) => [l, new Array(buckets.length).fill(0)]));
    for (const s of scans) {
      const i = index.get(bucketOf(new Date(s.scanned_at)).getTime());
      if (i !== undefined && series[s.label]) series[s.label][i] += 1;
    }

    const labels = buckets.map((b) => new Date(b).toLocaleDateString(loc(), { day: "numeric", month: "short" }));
    const surface = cssVar("--surface");
    const text = cssVar("--muted");
    const grid = cssVar("--grid");

    $("trend-legend").innerHTML = LABELS.map((l) => `<span>${swatch(l)}${escapeHtml(labelName(l))}</span>`).join("");
    if (trendChart) trendChart.destroy();
    trendChart = new Chart($("trend-chart"), {
      type: "bar",
      data: {
        labels,
        datasets: LABELS.map((label) => ({
          label: labelName(label),
          data: series[label],
          backgroundColor: colorOf(label),
          borderColor: surface,
          borderWidth: { top: 2, bottom: 0, left: 0, right: 0 },
          borderSkipped: false,
          // Round only the top of each stack
          borderRadius: (ctx) => (isTopOfStack(ctx) ? { topLeft: 4, topRight: 4 } : 0),
          maxBarThickness: 36,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => (daily ? items[0].label : t("tr.weekOf", { d: items[0].label })),
              footer: (items) => t("tr.total", { n: items.reduce((a, i) => a + i.parsed.y, 0) }),
            },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: text, font: { family: "Nunito" }, maxRotation: 0, autoSkip: true } },
          y: { stacked: true, beginAtZero: true, grid: { color: grid }, border: { display: false },
               ticks: { color: text, precision: 0, font: { family: "Nunito" } } },
        },
      },
    });

    // Areas table
    const byArea = new Map();
    for (const s of scans) {
      const key = areaKey(s);
      if (!key) continue;
      if (!byArea.has(key)) byArea.set(key, { name: s.area.trim(), total: 0, diseased: 0, labels: new Map() });
      const a = byArea.get(key);
      a.total += 1;
      if (isDiseased(s)) {
        a.diseased += 1;
        a.labels.set(s.label, (a.labels.get(s.label) || 0) + 1);
      }
    }
    const rows = [...byArea.values()].sort((a, b) => b.diseased - a.diseased || b.total - a.total).slice(0, 10);
    $("area-table").querySelector("tbody").innerHTML = rows.length === 0
      ? `<tr><td colspan="4" class="empty">${escapeHtml(t("ar.empty"))}</td></tr>`
      : rows.map((a) => {
          const top = [...a.labels.entries()].sort((x, y) => y[1] - x[1])[0];
          return `<tr><td>${escapeHtml(a.name)}</td><td class="num">${fmtInt(a.total)}</td>
            <td class="num">${fmtInt(a.diseased)} (${fmtPct(a.diseased / a.total, 0)})</td>
            <td>${top ? `${swatch(top[0])}${escapeHtml(labelName(top[0]))}` : "–"}</td></tr>`;
        }).join("");
  }

  // ---------- map ----------
  function renderMap() {
    if (!map) {
      map = L.map("map", { scrollWheelZoom: true }).setView([4.2, 101.9], 6); // Malaysia
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
      mapLayer = L.layerGroup().addTo(map);
      map.fitPending = true;
    }
    setTimeout(() => map.invalidateSize(), 0);
    $("map-note").textContent = t("map.note", { km: state.alertRule.radius });

    $("map-legend").innerHTML = LABELS.map((l) => `<label>
        <input type="checkbox" data-label="${escapeHtml(l)}" ${state.hiddenOnMap.has(l) ? "" : "checked"}>
        ${swatch(l)}${escapeHtml(labelName(l))}</label>`).join("");
    $("map-legend").querySelectorAll("input").forEach((box) => box.addEventListener("change", () => {
      if (box.checked) state.hiddenOnMap.delete(box.dataset.label);
      else state.hiddenOnMap.add(box.dataset.label);
      drawMapMarkers();
    }));
    drawMapMarkers();
  }

  function drawMapMarkers() {
    mapLayer.clearLayers();
    const surface = cssVar("--surface");
    const points = scansInRange().filter((s) => s.latitude != null && s.longitude != null && !state.hiddenOnMap.has(s.label));
    const bounds = [];
    for (const s of points) {
      bounds.push([s.latitude, s.longitude]);
      L.circleMarker([s.latitude, s.longitude], {
        radius: 7, color: surface, weight: 2, fillColor: colorOf(s.label), fillOpacity: 0.9,
      }).bindPopup(`<b>${escapeHtml(labelName(s.label))}</b> (${fmtPct(s.confidence)})<br>
          ${escapeHtml(s.area || t("ov.noArea"))}<br>${fmtDateTime(s.scanned_at)}`).addTo(mapLayer);
    }
    for (const a of state.alerts) {
      L.circle([a.center_lat, a.center_lng], {
        radius: state.alertRule.radius * 1000, color: colorOf(a.label), weight: 2, dashArray: "6 6", fill: false,
      }).bindPopup(`<b>${escapeHtml(t("map.alert", { label: labelName(a.label) }))}</b><br>
          ${escapeHtml(t("map.within", { n: fmtInt(a.scan_count), km: state.alertRule.radius }))}<br>
          ${escapeHtml(a.area || "")}`).addTo(mapLayer);
    }
    if (map.fitPending && bounds.length) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
      map.fitPending = false;
    }
  }

  // ---------- alerts ----------
  function renderAlerts() {
    const r = state.alertRule;
    $("alert-rule").innerHTML = t("al.rule", { min: r.min, km: r.radius, days: r.days });
    const rows = state.alerts;
    $("alert-empty").hidden = rows.length > 0;
    $("alert-table").hidden = rows.length === 0;
    $("alert-table").querySelector("tbody").innerHTML = rows.map((a, i) => `<tr>
        <td>${swatch(a.label)}<b>${escapeHtml(labelName(a.label))}</b></td>
        <td>${escapeHtml(a.area || "–")}</td>
        <td class="num">${fmtInt(a.scan_count)}</td>
        <td>${fmtDate(a.first_seen)}</td>
        <td>${timeAgo(a.last_seen)}</td>
        <td><button class="btn btn-small" data-alert="${i}" type="button">${escapeHtml(t("al.show"))}</button></td>
      </tr>`).join("");
  }

  // ---------- scans ----------
  function filteredScans() {
    const label = $("s-label").value;
    const q = $("s-search").value.trim().toLowerCase();
    return scansInRange().filter((s) =>
      (!label || s.label === label) &&
      (!q || (s.area || "").toLowerCase().includes(q) || (s.app_version || "").toLowerCase().includes(q)));
  }

  function renderScans() {
    const rows = filteredScans();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    state.scanPage = Math.min(state.scanPage, pages - 1);
    const pageRows = rows.slice(state.scanPage * PAGE_SIZE, (state.scanPage + 1) * PAGE_SIZE);
    $("scan-table").querySelector("tbody").innerHTML = pageRows.length === 0
      ? `<tr><td colspan="8" class="empty">${escapeHtml(t("sc.none"))}</td></tr>`
      : pageRows.map((s) => `<tr data-scan="${escapeHtml(s.id)}">
          <td>${fmtDateTime(s.scanned_at)}</td>
          <td>${swatch(s.label)}${escapeHtml(labelName(s.label))}</td>
          <td class="num">${fmtPct(s.confidence)}</td>
          <td>${escapeHtml(s.area || "–")}</td>
          <td>${s.latitude != null ? `${s.latitude.toFixed(3)}, ${s.longitude.toFixed(3)}` : "–"}</td>
          <td>${s.used_tta ? t("yes") : t("no")}</td>
          <td>${escapeHtml(s.app_version || "–")}</td>
          <td><button class="btn btn-small btn-danger" data-delete="${escapeHtml(s.id)}" type="button">${escapeHtml(t("sc.delete"))}</button></td>
        </tr>`).join("");
    $("s-page").textContent = t("sc.page", { n: fmtInt(rows.length), p: state.scanPage + 1, pages });
    $("s-prev").disabled = state.scanPage === 0;
    $("s-next").disabled = state.scanPage >= pages - 1;
  }

  function deleteScan(id) {
    confirmBox({
      title: t("del.title"),
      body: t("del.body"),
      okLabel: t("del.ok"),
      icon: "#i-close",
      onOk: async () => {
        const { error } = await db.from("scans").delete().eq("id", id);
        if (error) { toast(t("del.fail", { msg: error.message })); return; }
        state.scans = state.scans.filter((s) => s.id !== id);
        toast(t("del.done"));
        renderPage();
      },
    });
  }

  function showScan(id) {
    const s = state.scans.find((x) => x.id === id);
    if (!s) return;
    const hasLoc = s.latitude != null && s.longitude != null;
    const rows = [
      [t("d.scanned"), `${fmtDateTime(s.scanned_at)} (${timeAgo(s.scanned_at)})`],
      [t("d.received"), s.received_at ? fmtDateTime(s.received_at) : "–"],
      [t("d.area"), escapeHtml(s.area || "–")],
      [t("d.location"), hasLoc ? `${s.latitude.toFixed(3)}, ${s.longitude.toFixed(3)}` : "–"],
      [t("d.tta"), s.used_tta ? t("yes") : t("no")],
      [t("d.speed"), s.inference_ms != null ? `${s.inference_ms} ms` : "–"],
      [t("d.app"), escapeHtml(s.app_version || "–")],
      [t("d.model"), escapeHtml(s.model_version || "–")],
      [t("d.phone"), `<code>${escapeHtml(String(s.device_id || "–").slice(0, 8))}</code>`],
      [t("d.id"), `<code>${escapeHtml(String(s.id).slice(0, 8))}</code>`],
    ];
    const actions = [{ label: t("close"), cls: "" }];
    if (hasLoc) {
      actions.unshift({
        label: t("d.showMap"), cls: "btn-primary",
        onClick: () => {
          closeModal();
          goTo("map");
          map.fitPending = false;
          map.setView([s.latitude, s.longitude], 15);
        },
      });
    }
    openModal({
      title: t("d.title"),
      wide: true,
      body: `<div class="detail-head">${swatch(s.label)}${escapeHtml(labelName(s.label))}<span class="conf">${fmtPct(s.confidence)}</span></div>
        ${s.confidence < LOW_CONFIDENCE ? `<p class="warning small">${escapeHtml(t("d.low"))}</p>` : ""}
        <dl class="facts">${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join("")}</dl>`,
      actions,
    });
  }

  function downloadCsv() {
    const rows = filteredScans();
    const head = ["scanned_at", "received_at", "label", "confidence", "used_tta", "inference_ms", "area",
      "latitude", "longitude", "app_version", "model_version", "device_id", "id"];
    const cell = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [head.join(",")].concat(rows.map((r) => head.map((h) => cell(r[h])).join(","))).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `paddynet-scans-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- model & system ----------
  function facts(entries) {
    return entries.filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join("");
  }

  function renderModel() {
    const current = state.models.find((m) => m.is_current) || state.models[0];
    if (current) {
      $("model-facts").innerHTML = facts([
        [t("m.version"), escapeHtml(current.version)],
        [t("m.model"), escapeHtml(current.architecture)],
        [t("m.classes"), `<div class="chips">${(current.classes || []).map((c) => `<span class="chip">${swatch(c)}${escapeHtml(labelName(c))}</span>`).join("")}</div>`],
        [t("m.input"), escapeHtml(current.input_size)],
        [t("m.trained"), escapeHtml(current.dataset)],
        [t("m.size"), current.file_size_mb ? `${current.file_size_mb} MB` : ""],
        [t("m.released"), current.released_at ? fmtDate(current.released_at) : ""],
        [t("m.notes"), escapeHtml(current.notes)],
      ]);
      const metric = (label, v) => `<div class="tile"><span class="tile-label">${escapeHtml(label)}</span>
          <span class="tile-value">${v != null ? fmtPct(v, 2) : "–"}</span></div>`;
      $("model-metrics").innerHTML =
        metric(t("m.val"), current.val_accuracy) +
        metric(t("m.test"), current.test_accuracy) +
        metric(t("m.tta"), current.tta_accuracy);
    } else {
      $("model-facts").innerHTML = `<p class="empty">${escapeHtml(t("m.none"))}</p>`;
      $("model-metrics").innerHTML = "";
    }

    renderConfusion(current);

    // In the field
    const scans = scansInRange();
    const conf = scans.map((s) => s.confidence);
    const tta = scans.filter((s) => s.used_tta && s.inference_ms != null).map((s) => s.inference_ms);
    const single = scans.filter((s) => !s.used_tta && s.inference_ms != null).map((s) => s.inference_ms);
    const perLabel = LABELS.map((l) => {
      const v = scans.filter((s) => s.label === l).map((s) => s.confidence);
      return v.length ? `${swatch(l)}${escapeHtml(labelName(l))}: ${fmtPct(average(v))} (${fmtInt(v.length)})` : null;
    }).filter(Boolean).join("<br>");
    $("field-facts").innerHTML = scans.length === 0
      ? `<p class="empty">${escapeHtml(t("ov.noScansPeriod"))}</p>`
      : facts([
          [t("tile.scans"), fmtInt(scans.length)],
          [t("m.avgConf"), fmtPct(average(conf))],
          [t("m.lowConf"), t("m.lowVal", { p: fmtPct(conf.filter((c) => c < LOW_CONFIDENCE).length / conf.length), t: LOW_CONFIDENCE * 100 })],
          [t("m.confBy"), perLabel],
          [t("m.ttaOn"), fmtPct(scans.filter((s) => s.used_tta).length / scans.length, 0)],
          [t("m.speedTta"), tta.length ? t("m.median", { ms: Math.round(median(tta)) }) : "–"],
          [t("m.speedSingle"), single.length ? t("m.median", { ms: Math.round(median(single)) }) : "–"],
        ]);

    // System
    const all = state.scans;
    const delays = all.filter((s) => s.received_at).map((s) => new Date(s.received_at) - new Date(s.scanned_at));
    const delay = median(delays);
    const lastReceived = all.reduce((m, s) => (s.received_at > m ? s.received_at : m), "");
    const firstScan = all.length ? all[all.length - 1].scanned_at : null;
    let host = "";
    try { host = new URL(CFG.supabaseUrl).host; } catch (e) { /* ignore */ }
    const updates = state.realtime ? t("m.updRealtime")
      : prefs.refresh > 0 ? t("m.updPoll", { s: prefs.refresh }) : t("m.updOff");
    $("system-facts").innerHTML = facts([
      [t("m.db"), `Supabase (PostgreSQL) · ${escapeHtml(host)}`],
      [t("m.stored"), fmtInt(all.length)],
      [t("m.phones"), fmtInt(new Set(all.map((s) => s.device_id)).size)],
      [t("m.first"), firstScan ? fmtDate(firstScan) : "–"],
      [t("m.lastRecv"), lastReceived ? `${fmtDateTime(lastReceived)} (${timeAgo(lastReceived)})` : "–"],
      [t("m.delay"), delay != null ? describeDelay(delay) : "–"],
      [t("m.updates"), updates],
      [t("m.dashboard"), `v${escapeHtml(CFG.dashboardVersion || "1.0")}`],
      [t("m.loaded"), state.loadedAt ? fmtDateTime(state.loadedAt) : "–"],
    ]);

    // App versions
    const byVersion = new Map();
    for (const s of all) {
      const v = s.app_version || t("m.unknown");
      if (!byVersion.has(v)) byVersion.set(v, { devices: new Set(), scans: 0, last: s.scanned_at });
      const e = byVersion.get(v);
      e.devices.add(s.device_id);
      e.scans += 1;
      if (s.scanned_at > e.last) e.last = s.scanned_at;
    }
    $("app-version-table").querySelector("tbody").innerHTML = byVersion.size === 0
      ? `<tr><td colspan="4" class="empty">${escapeHtml(t("ov.noScans"))}</td></tr>`
      : [...byVersion.entries()].sort((a, b) => (a[1].last < b[1].last ? 1 : -1)).map(([v, e]) => `<tr>
          <td>${escapeHtml(v)}</td><td class="num">${fmtInt(e.devices.size)}</td>
          <td class="num">${fmtInt(e.scans)}</td><td>${timeAgo(e.last)}</td></tr>`).join("");

    // Model versions
    const scansPerModel = countBy(all, "model_version");
    $("model-version-table").querySelector("tbody").innerHTML = state.models.length === 0
      ? `<tr><td colspan="5" class="empty">${escapeHtml(t("m.none"))}</td></tr>`
      : state.models.map((m) => `<tr>
          <td>${escapeHtml(m.version)}</td>
          <td class="num">${m.test_accuracy != null ? fmtPct(m.test_accuracy, 2) : "–"}</td>
          <td class="num">${m.tta_accuracy != null ? fmtPct(m.tta_accuracy, 2) : "–"}</td>
          <td class="num">${fmtInt(scansPerModel.get(m.version) || 0)}</td>
          <td>${m.is_current ? `<b>${escapeHtml(t("m.inApp"))}</b>` : escapeHtml(t("m.older"))}</td></tr>`).join("");
  }

  /** Confusion matrix as a shaded table, plus precision, recall and F1 per disease. */
  function renderConfusion(model) {
    const tta = state.cmMode === "tta";
    document.querySelectorAll(".seg-btn[data-cm]").forEach((b) => b.classList.toggle("active", b.dataset.cm === state.cmMode));
    $("cm-caption").textContent = t("m.cm", { mode: tta ? t("m.cmTta") : t("m.cmSingle") });
    const matrix = model && (tta ? model.confusion_matrix_tta : model.confusion_matrix);
    const valid = Array.isArray(matrix) && matrix.length === LABELS.length && matrix.every((r) => Array.isArray(r) && r.length === LABELS.length);
    $("cm-images").hidden = valid;
    $("cm-table").hidden = !valid;
    $("class-metrics").hidden = !valid;
    if (!valid) return;

    const n = LABELS.length;
    const rowSum = matrix.map((r) => r.reduce((a, b) => a + b, 0));
    const colSum = LABELS.map((_, j) => matrix.reduce((a, r) => a + r[j], 0));
    const total = rowSum.reduce((a, b) => a + b, 0);
    const correct = matrix.reduce((a, r, i) => a + r[i], 0);
    const short = (l) => t(`short.${l}`);

    let html = `<table class="cm-grid"><thead><tr><th></th>${LABELS.map((l) => `<th>${escapeHtml(short(l))}</th>`).join("")}</tr></thead><tbody>`;
    for (let i = 0; i < n; i++) {
      html += `<tr><th class="row-head">${escapeHtml(short(LABELS[i]))}</th>`;
      for (let j = 0; j < n; j++) {
        const v = matrix[i][j];
        const share = rowSum[i] ? v / rowSum[i] : 0; // shade by share of the true class
        const pct = Math.round(Math.max(share, v > 0 ? 0.06 : 0) * 100);
        const ink = share > 0.5 ? "var(--seq-ink)" : "var(--text)";
        const tip = t("m.cell", { t: labelName(LABELS[i]), p: labelName(LABELS[j]), v, n: rowSum[i], pct: fmtPct(share) });
        html += `<td class="${i === j ? "diag" : ""}" style="background:color-mix(in srgb, var(--seq) ${pct}%, transparent);color:${ink}"
          title="${escapeHtml(tip)}">${v}</td>`;
      }
      html += "</tr>";
    }
    html += `</tbody></table><p class="cm-axis">${escapeHtml(t("m.correct", { a: fmtInt(correct), b: fmtInt(total), p: fmtPct(correct / total, 2) }))}</p>`;
    $("cm-table").innerHTML = html;

    const rows = LABELS.map((label, i) => {
      const p = colSum[i] ? matrix[i][i] / colSum[i] : 0;
      const r = rowSum[i] ? matrix[i][i] / rowSum[i] : 0;
      const f1 = p + r ? (2 * p * r) / (p + r) : 0;
      return { label, p, r, f1, images: rowSum[i] };
    });
    const avg = (k) => rows.reduce((a, x) => a + x[k], 0) / rows.length;
    $("class-metrics").innerHTML = `<thead><tr><th>${escapeHtml(t("th.disease"))}</th><th class="num">${escapeHtml(t("m.precision"))}</th>
        <th class="num">${escapeHtml(t("m.recall"))}</th><th class="num">${escapeHtml(t("m.f1"))}</th><th class="num">${escapeHtml(t("m.images"))}</th></tr></thead>
      <tbody>${rows.map((x) => `<tr><td>${swatch(x.label)}${escapeHtml(labelName(x.label))}</td><td class="num">${fmtPct(x.p)}</td>
        <td class="num">${fmtPct(x.r)}</td><td class="num">${fmtPct(x.f1)}</td><td class="num">${fmtInt(x.images)}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>${escapeHtml(t("m.macro"))}</td><td class="num">${fmtPct(avg("p"))}</td><td class="num">${fmtPct(avg("r"))}</td>
        <td class="num">${fmtPct(avg("f1"))}</td><td class="num">${fmtInt(total)}</td></tr></tfoot>`;
  }

  function describeDelay(ms) {
    if (ms < 60 * 1000) return t("delay.min");
    if (ms < 3600 * 1000) return t("delay.mins", { n: Math.round(ms / 60000) });
    if (ms < DAY) return t("delay.hours", { n: (ms / 3600000).toFixed(1) });
    return t("delay.days", { n: (ms / DAY).toFixed(1) });
  }

  // ---------- profile ----------
  function renderProfile() {
    const u = state.user;
    if (!u) return;
    renderUser();
    $("profile-name").textContent = displayName();
    $("profile-email").textContent = u.email;
    if (document.activeElement !== $("p-name")) $("p-name").value = (u.user_metadata && u.user_metadata.full_name) || "";
    $("account-facts").innerHTML = facts([
      [t("p.email"), escapeHtml(u.email)],
      [t("p.role"), escapeHtml(t("role.admin"))],
      [t("p.lastSignIn"), u.last_sign_in_at ? fmtDateTime(u.last_sign_in_at) : "–"],
      [t("p.created"), u.created_at ? fmtDate(u.created_at) : "–"],
    ]);
    $("pref-lang").value = window.I18N.lang;
    $("pref-theme").value = prefs.theme;
    $("pref-motion").value = prefs.motion;
    $("pref-refresh").value = String(prefs.refresh);
    $("pref-period").value = String(prefs.period);
    $("pref-idle").value = String(prefs.idle);
  }

  function fillPrefOptions() {
    const fill = (id, items) => {
      const el = $(id);
      const value = el.value;
      el.innerHTML = items.map(([v, label]) => `<option value="${v}">${escapeHtml(label)}</option>`).join("");
      if (value) el.value = value;
    };
    fill("pref-refresh", [[30, t("p.every", { n: 30 })], [60, t("p.every", { n: 60 })], [300, t("p.everyMin", { n: 5 })], [0, t("p.off")]]);
    fill("pref-period", [[7, t("f.r7")], [30, t("f.r30")], [90, t("f.r90")], [365, t("f.r365")], [0, t("f.all")]]);
    fill("pref-idle", [[15, t("p.minutes", { n: 15 })], [30, t("p.minutes", { n: 30 })], [60, t("p.minutes", { n: 60 })], [0, t("p.never")]]);
    const label = $("s-label");
    const keep = label.value;
    label.innerHTML = `<option value="">${escapeHtml(t("sc.all"))}</option>` +
      LABELS.map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(labelName(l))}</option>`).join("");
    label.value = keep;
  }

  function initProfile() {
    $("name-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const full = $("p-name").value.trim();
      const { data, error } = await db.auth.updateUser({ data: { full_name: full } });
      if (error) { toast(t("p.fail", { msg: error.message })); return; }
      state.user = data.user;
      $("p-name").blur();
      renderProfile();
      tickClock();
      toast(t("p.saved"));
    });
    $("pw-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const a = $("p-pw1").value;
      const b = $("p-pw2").value;
      const err = $("pw-error");
      err.hidden = true;
      if (a.length < 8) { err.textContent = t("p.pwShort"); err.hidden = false; return; }
      if (a !== b) { err.textContent = t("p.pwMismatch"); err.hidden = false; return; }
      const { error } = await db.auth.updateUser({ password: a });
      if (error) { err.textContent = t("p.fail", { msg: error.message }); err.hidden = false; return; }
      $("pw-form").reset();
      toast(t("p.pwDone"));
    });
    $("pref-lang").addEventListener("change", (e) => setLanguage(e.target.value));
    $("pref-theme").addEventListener("change", (e) => { prefs.theme = e.target.value; savePrefs(); applyTheme(); redrawForTheme(); });
    $("pref-motion").addEventListener("change", (e) => { prefs.motion = e.target.value; savePrefs(); applyMotion(); });
    $("pref-refresh").addEventListener("change", (e) => { prefs.refresh = Number(e.target.value); savePrefs(); startLive(); });
    $("pref-period").addEventListener("change", (e) => { prefs.period = Number(e.target.value); savePrefs(); $("range").value = String(prefs.period); });
    $("pref-idle").addEventListener("change", (e) => { prefs.idle = Number(e.target.value); savePrefs(); lastActivity = Date.now(); });
  }

  // ---------- language ----------
  function setLanguage(lang) {
    window.I18N.setLang(lang);
    refreshTexts();
  }
  function refreshTexts() {
    window.I18N.applyStatic();
    document.querySelectorAll(".lang-switch button").forEach((b) => b.classList.toggle("active", b.dataset.lang === window.I18N.lang));
    fillPrefOptions();
    applyTheme();
    applyFold();
    $("login-button-text").textContent = $("login-button").classList.contains("busy") ? t("login.checking") : t("login.button");
    if (state.user) $("boot-title").textContent = t("boot.welcome", { name: displayName() });
    $("version-note").textContent = `PaddyNet Admin v${CFG.dashboardVersion || "1.0"}`;
    if (!$("app-view").hidden) {
      $("page-title").textContent = t(`nav.${state.page}`);
      updateAlertBadges();
      updateLive();
      if (dailyChart) { dailyChart.destroy(); dailyChart = null; }
      renderPage();
    }
    tickClock();
  }

  function redrawForTheme() {
    if (dailyChart) { dailyChart.destroy(); dailyChart = null; }
    renderPage();
  }

  // ---------- print ----------
  function printReport() {
    const period = $("range").options[$("range").selectedIndex].textContent;
    $("print-meta").textContent = t("print.meta", { period, date: fmtDateTime(new Date()), who: displayName() });
    setTimeout(() => window.print(), 50);
  }

  // ---------- start ----------
  function init() {
    applyTheme();
    applyMotion();
    applyFold();
    $("range").value = String(prefs.period);
    refreshTexts();
    if (darkQuery && darkQuery.addEventListener) {
      darkQuery.addEventListener("change", () => { if (prefs.theme === "system") { applyTheme(); redrawForTheme(); } });
    }

    document.querySelectorAll(".lang-switch button").forEach((b) => b.addEventListener("click", () => setLanguage(b.dataset.lang)));
    $("theme-button").addEventListener("click", () => {
      prefs.theme = currentTheme() === "dark" ? "light" : "dark";
      savePrefs();
      applyTheme();
      redrawForTheme();
    });
    $("fold-button").addEventListener("click", () => {
      if (isMobile()) { $("app-view").classList.toggle("nav-open"); return; }
      prefs.folded = !prefs.folded;
      savePrefs();
      applyFold();
    });
    $("nav-backdrop").addEventListener("click", () => $("app-view").classList.remove("nav-open"));
    $("nav").addEventListener("click", (e) => {
      const a = e.target.closest("a[data-page]");
      if (!a) return;
      e.preventDefault();
      goTo(a.dataset.page);
    });
    window.addEventListener("hashchange", () => { if (!$("app-view").hidden) goTo(location.hash.slice(1)); });

    // Menus
    $("bell-button").addEventListener("click", (e) => {
      e.stopPropagation();
      const open = $("bell-menu").hidden;
      closeMenus();
      setMenu("bell-button", "bell-menu", open);
    });
    $("user-button").addEventListener("click", (e) => {
      e.stopPropagation();
      const open = $("user-menu").hidden;
      closeMenus();
      setMenu("user-button", "user-menu", open);
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".dropdown")) closeMenus();
      const alertItem = e.target.closest("[data-alert]");
      if (alertItem) { showAlertOnMap(Number(alertItem.dataset.alert)); return; }
      const del = e.target.closest("[data-delete]");
      if (del) { deleteScan(del.dataset.delete); return; }
      const scan = e.target.closest("[data-scan]");
      if (scan) showScan(scan.dataset.scan);
    });
    document.querySelectorAll(".menu a[href^='#']").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      goTo(a.getAttribute("href").slice(1));
    }));
    document.querySelectorAll(".card-head a[href^='#']").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      goTo(a.getAttribute("href").slice(1));
    }));

    // Popup
    $("modal-x").addEventListener("click", closeModal);
    $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeModal(); closeMenus(); $("app-view").classList.remove("nav-open"); }
    });

    // Filters and pages
    $("range").addEventListener("change", () => { state.scanPage = 0; if (map) map.fitPending = true; renderPage(); });
    $("refresh-button").addEventListener("click", () => loadData());
    $("print-button").addEventListener("click", printReport);
    $("alert-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      state.alertRule = {
        min: Math.max(2, Number($("a-min").value) || 3),
        radius: Math.max(0.2, Number($("a-radius").value) || 1),
        days: Math.max(1, Number($("a-days").value) || 14),
      };
      try { await fetchAlerts(); } catch (err) { toast(t("al.fail", { msg: err.message })); }
      updateAlertBadges();
      renderAlerts();
    });
    $("s-label").addEventListener("change", () => { state.scanPage = 0; renderScans(); });
    $("s-search").addEventListener("input", () => { state.scanPage = 0; renderScans(); });
    $("s-prev").addEventListener("click", () => { state.scanPage -= 1; renderScans(); });
    $("s-next").addEventListener("click", () => { state.scanPage += 1; renderScans(); });
    $("csv-button").addEventListener("click", downloadCsv);
    document.querySelectorAll(".seg-btn[data-cm]").forEach((b) => b.addEventListener("click", () => {
      state.cmMode = b.dataset.cm;
      renderModel();
    }));
    initProfile();

    // Clock, online state, idle check, and catching up when the tab comes back
    setInterval(tickClock, 1000);
    setInterval(checkIdle, 5000);
    ["mousemove", "keydown", "click", "scroll", "touchstart"].forEach((ev) =>
      window.addEventListener(ev, () => { if (!idleWarning || ev !== "mousemove") noteActivity(); }, { passive: true }));
    window.addEventListener("online", () => { updateLive(); if (!$("app-view").hidden) loadData({ silent: true }); });
    window.addEventListener("offline", updateLive);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden || $("app-view").hidden || prefs.refresh === 0) return;
      if (!state.loadedAt || Date.now() - state.loadedAt.getTime() > 30 * 1000) loadData({ silent: true });
    });

    initAuth();
  }

  init();
})();
