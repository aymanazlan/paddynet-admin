/* PaddyNet Admin dashboard. Reads shared scans from Supabase (admins only) and shows them. */
(() => {
  "use strict";

  const CFG = window.PADDYNET_CONFIG || {};
  const LABELS = ["Bacterial Leaf Blight", "Blast", "Brown Spot", "Normal"];
  const COLOR_VAR = {
    "Bacterial Leaf Blight": "--c-blb",
    "Blast": "--c-blast",
    "Brown Spot": "--c-brown",
    "Normal": "--c-normal",
  };
  const PAGE_TITLES = {
    overview: "Overview", trends: "Trends", map: "Map", alerts: "Alerts",
    scans: "Scans", model: "Model & System",
  };
  const SCAN_COLUMNS =
    "id,device_id,label,confidence,used_tta,inference_ms,scanned_at,received_at,area,latitude,longitude,app_version,model_version";
  const PAGE_SIZE = 25;
  const LOW_CONFIDENCE = 0.6;
  const DAY = 24 * 60 * 60 * 1000;

  const configured =
    typeof CFG.supabaseUrl === "string" && CFG.supabaseUrl.startsWith("https://") &&
    !CFG.supabaseUrl.includes("YOUR-") && typeof CFG.supabaseKey === "string" &&
    !CFG.supabaseKey.startsWith("YOUR_");
  const db = configured ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey) : null;

  const state = {
    scans: [],
    models: [],
    alerts: [],
    alertRule: { min: 3, radius: 1, days: 14 },
    page: "overview",
    scanPage: 0,
    hiddenOnMap: new Set(),
    cmMode: "tta",
    loadedAt: null,
  };
  let trendChart = null;
  let map = null;
  let mapLayer = null;

  const $ = (id) => document.getElementById(id);

  // ---------- helpers ----------
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const colorOf = (label) => cssVar(COLOR_VAR[label] || "--muted");
  const swatch = (label) => `<span class="swatch" style="background:${colorOf(label)}"></span>`;
  const fmtInt = (n) => Number(n).toLocaleString("en-MY");
  const fmtPct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;
  const fmtDate = (d) => new Date(d).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" });
  const fmtDateTime = (d) => new Date(d).toLocaleString("en-MY", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  function timeAgo(d) {
    const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 2 * 86400) return "yesterday";
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
    return fmtDate(d);
  }
  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 3000);
  }
  function rangeDays() { return Number($("range").value); }
  function scansInRange() {
    const days = rangeDays();
    if (!days) return state.scans;
    const cutoff = Date.now() - days * DAY;
    return state.scans.filter((s) => new Date(s.scanned_at).getTime() >= cutoff);
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

  // ---------- theme ----------
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    $("theme-button").textContent = theme === "dark" ? "Light mode" : "Dark mode";
  }
  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem("pn-theme"); } catch (e) { /* private mode */ }
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(saved || (prefersDark ? "dark" : "light"));
    $("theme-button").addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(next);
      try { localStorage.setItem("pn-theme", next); } catch (e) { /* ignore */ }
      renderPage();
    });
  }

  // ---------- login ----------
  function showLogin(message) {
    $("app-view").hidden = true;
    $("login-view").hidden = false;
    playLoginVideo(true);
    $("login-error").hidden = !message;
    $("login-error").textContent = message || "";
    if (!configured) {
      $("config-warning").hidden = false;
      $("login-button").disabled = true;
    }
  }

  // Background video only plays while the login page is showing (saves battery and CPU)
  function playLoginVideo(on) {
    const video = $("login-video");
    if (!video) return;
    if (on && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  async function checkAdminAndStart(session) {
    const { data: isAdmin, error } = await db.rpc("is_admin");
    if (error || !isAdmin) {
      await db.auth.signOut();
      showLogin(error ? `Could not check your account: ${error.message}` :
        "This account is not an admin. Add it to the admins table in Supabase first.");
      return;
    }
    $("signed-in-as").textContent = `Signed in as ${session.user.email}`;
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    playLoginVideo(false);
    await loadData();
    goTo(location.hash.slice(1) || "overview");
  }

  async function initAuth() {
    $("login-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!db) return;
      $("login-button").disabled = true;
      $("login-error").hidden = true;
      const { data, error } = await db.auth.signInWithPassword({
        email: $("login-email").value.trim(),
        password: $("login-password").value,
      });
      $("login-button").disabled = false;
      if (error) {
        showLogin(error.message === "Invalid login credentials" ? "Wrong email or password." : error.message);
        return;
      }
      await checkAdminAndStart(data.session);
    });
    $("logout-button").addEventListener("click", async () => {
      await db.auth.signOut();
      state.scans = [];
      showLogin();
    });

    if (!db) { showLogin(); return; }
    const { data } = await db.auth.getSession();
    if (data.session) await checkAdminAndStart(data.session);
    else showLogin();
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

  async function loadData() {
    $("refresh-button").disabled = true;
    $("load-error").hidden = true;
    try {
      const [scans, models] = await Promise.all([
        fetchAllScans(),
        db.from("model_versions").select("*").order("released_at", { ascending: false }),
        fetchAlerts(),
      ]);
      if (models.error) throw models.error;
      state.scans = scans;
      state.models = models.data || [];
      state.loadedAt = new Date();
      $("last-loaded").textContent = `Updated ${state.loadedAt.toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit" })}`;
    } catch (error) {
      $("load-error").textContent = `Could not load data: ${error.message || error}`;
      $("load-error").hidden = false;
    } finally {
      $("refresh-button").disabled = false;
    }
    const n = state.alerts.length;
    $("nav-alert-count").hidden = n === 0;
    $("nav-alert-count").textContent = n;
    renderPage();
  }

  // ---------- navigation ----------
  function goTo(page) {
    if (!PAGE_TITLES[page]) page = "overview";
    state.page = page;
    for (const name of Object.keys(PAGE_TITLES)) $(`page-${name}`).hidden = name !== page;
    for (const a of document.querySelectorAll("#nav a")) a.classList.toggle("active", a.dataset.page === page);
    $("page-title").textContent = PAGE_TITLES[page];
    if (location.hash.slice(1) !== page) history.replaceState(null, "", `#${page}`);
    renderPage();
  }

  function renderPage() {
    if ($("app-view").hidden) return;
    ({
      overview: renderOverview, trends: renderTrends, map: renderMap,
      alerts: renderAlerts, scans: renderScans, model: renderModel,
    })[state.page]();
  }

  // ---------- overview ----------
  function renderOverview() {
    const scans = scansInRange();
    const total = scans.length;
    const diseased = scans.filter(isDiseased).length;
    const areas = new Set(scans.filter((s) => s.area).map((s) => s.area.trim().toLowerCase()));
    const noArea = scans.filter((s) => !s.area).length;

    $("t-total").textContent = fmtInt(total);
    $("t-total-sub").textContent = `${fmtInt(state.scans.length)} all time`;
    $("t-diseased").textContent = total ? fmtPct(diseased / total, 0) : "–";
    $("t-diseased-sub").textContent = `${fmtInt(diseased)} of ${fmtInt(total)} scans`;
    $("t-devices").textContent = fmtInt(new Set(scans.map((s) => s.device_id)).size);
    $("t-areas").textContent = fmtInt(areas.size);
    $("t-areas-sub").textContent = noArea ? `${fmtInt(noArea)} scans without area` : "every scan has an area";
    $("t-alerts").textContent = fmtInt(state.alerts.length);
    $("t-alerts").classList.toggle("has-alerts", state.alerts.length > 0);

    const counts = countBy(scans, "label");
    $("split-bars").innerHTML = total === 0
      ? `<p class="empty">No scans in this period yet.</p>`
      : LABELS.map((label) => {
          const n = counts.get(label) || 0;
          const share = n / total;
          return `<div>
            <div class="hbar-top"><span>${swatch(label)}${escapeHtml(label)}</span>
              <span class="num">${fmtInt(n)} · ${fmtPct(share, 0)}</span></div>
            <div class="hbar-track"><div class="hbar-fill" style="width:${(share * 100).toFixed(1)}%;background:${colorOf(label)}"></div></div>
          </div>`;
        }).join("");

    const latest = state.scans.slice(0, 8);
    $("latest-list").innerHTML = latest.length === 0
      ? `<li class="empty">No scans shared yet.</li>`
      : latest.map((s) => `<li>
          <span>${swatch(s.label)}<b>${escapeHtml(s.label)}</b> <span class="sub">${fmtPct(s.confidence)}</span><br>
            <span class="sub">${escapeHtml(s.area || "No area")}</span></span>
          <span class="sub">${timeAgo(s.scanned_at)}</span>
        </li>`).join("");
  }

  // ---------- trends ----------
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function startOfWeek(d) {
    const x = startOfDay(d);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
    return x;
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
    $("trend-title").textContent = daily ? "Scans per day" : "Scans per week";

    // Build every bucket in the period, so empty days or weeks show as gaps, not missing
    const end = bucketOf(new Date());
    let start;
    if (days) start = bucketOf(new Date(Date.now() - (days - 1) * DAY));
    else if (scans.length) start = bucketOf(new Date(Math.min(...scans.map((s) => new Date(s.scanned_at).getTime()))));
    else start = end;
    const buckets = [];
    for (let t = new Date(start); t <= end; t.setDate(t.getDate() + (daily ? 1 : 7))) buckets.push(new Date(t).getTime());
    const index = new Map(buckets.map((b, i) => [b, i]));

    const series = Object.fromEntries(LABELS.map((l) => [l, new Array(buckets.length).fill(0)]));
    for (const s of scans) {
      const i = index.get(bucketOf(new Date(s.scanned_at)).getTime());
      if (i !== undefined && series[s.label]) series[s.label][i] += 1;
    }

    const labels = buckets.map((b) => {
      const d = new Date(b);
      return d.toLocaleDateString("en-MY", { day: "numeric", month: "short" });
    });
    const surface = cssVar("--surface");
    const text = cssVar("--muted");
    const grid = cssVar("--grid");

    $("trend-legend").innerHTML = LABELS.map((l) => `<span>${swatch(l)}${escapeHtml(l)}</span>`).join("");
    if (trendChart) trendChart.destroy();
    trendChart = new Chart($("trend-chart"), {
      type: "bar",
      data: {
        labels,
        datasets: LABELS.map((label) => ({
          label,
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
              title: (items) => (daily ? items[0].label : `Week of ${items[0].label}`),
              footer: (items) => `Total: ${items.reduce((a, i) => a + i.parsed.y, 0)}`,
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
      if (!s.area) continue;
      const key = s.area.trim().toLowerCase();
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
      ? `<tr><td colspan="4" class="empty">No scans with an area name in this period.</td></tr>`
      : rows.map((a) => {
          const top = [...a.labels.entries()].sort((x, y) => y[1] - x[1])[0];
          return `<tr><td>${escapeHtml(a.name)}</td><td class="num">${fmtInt(a.total)}</td>
            <td class="num">${fmtInt(a.diseased)} (${fmtPct(a.diseased / a.total, 0)})</td>
            <td>${top ? `${swatch(top[0])}${escapeHtml(top[0])}` : "–"}</td></tr>`;
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

    $("map-legend").innerHTML = LABELS.map((l) => `<label>
        <input type="checkbox" data-label="${escapeHtml(l)}" ${state.hiddenOnMap.has(l) ? "" : "checked"}>
        ${swatch(l)}${escapeHtml(l)}</label>`).join("");
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
      }).bindPopup(`<b>${escapeHtml(s.label)}</b> (${fmtPct(s.confidence)})<br>
          ${escapeHtml(s.area || "No area")}<br>${fmtDateTime(s.scanned_at)}`).addTo(mapLayer);
    }
    for (const a of state.alerts) {
      L.circle([a.center_lat, a.center_lng], {
        radius: state.alertRule.radius * 1000, color: colorOf(a.label), weight: 2, dashArray: "6 6", fill: false,
      }).bindPopup(`<b>Alert: ${escapeHtml(a.label)}</b><br>${fmtInt(a.scan_count)} scans within ${state.alertRule.radius} km<br>
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
    $("rule-min").textContent = r.min;
    $("rule-radius").textContent = r.radius;
    $("rule-days").textContent = r.days;
    const rows = state.alerts;
    $("alert-empty").hidden = rows.length > 0;
    $("alert-table").hidden = rows.length === 0;
    $("alert-table").querySelector("tbody").innerHTML = rows.map((a, i) => `<tr>
        <td>${swatch(a.label)}<b>${escapeHtml(a.label)}</b></td>
        <td>${escapeHtml(a.area || "–")}</td>
        <td class="num">${fmtInt(a.scan_count)}</td>
        <td>${fmtDate(a.first_seen)}</td>
        <td>${timeAgo(a.last_seen)}</td>
        <td><button class="btn btn-small" data-alert="${i}" type="button">Show on map</button></td>
      </tr>`).join("");
    $("alert-table").querySelectorAll("[data-alert]").forEach((b) => b.addEventListener("click", () => {
      const a = state.alerts[Number(b.dataset.alert)];
      goTo("map");
      map.fitPending = false;
      map.setView([a.center_lat, a.center_lng], 14);
    }));
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
      ? `<tr><td colspan="8" class="empty">No scans match.</td></tr>`
      : pageRows.map((s) => `<tr>
          <td>${fmtDateTime(s.scanned_at)}</td>
          <td>${swatch(s.label)}${escapeHtml(s.label)}</td>
          <td class="num">${fmtPct(s.confidence)}</td>
          <td>${escapeHtml(s.area || "–")}</td>
          <td>${s.latitude != null ? `${s.latitude.toFixed(3)}, ${s.longitude.toFixed(3)}` : "–"}</td>
          <td>${s.used_tta ? "Yes" : "No"}</td>
          <td>${escapeHtml(s.app_version || "–")}</td>
          <td><button class="btn btn-small btn-danger" data-delete="${escapeHtml(s.id)}" type="button">Delete</button></td>
        </tr>`).join("");
    $("s-page").textContent = `${fmtInt(rows.length)} scans · page ${state.scanPage + 1} of ${pages}`;
    $("s-prev").disabled = state.scanPage === 0;
    $("s-next").disabled = state.scanPage >= pages - 1;
    $("scan-table").querySelectorAll("[data-delete]").forEach((b) => b.addEventListener("click", () => deleteScan(b.dataset.delete)));
  }

  async function deleteScan(id) {
    if (!confirm("Delete this scan from the online database? (It stays on the farmer's phone.)")) return;
    const { error } = await db.from("scans").delete().eq("id", id);
    if (error) { toast(`Could not delete: ${error.message}`); return; }
    state.scans = state.scans.filter((s) => s.id !== id);
    toast("Scan deleted");
    renderScans();
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
        ["Version", escapeHtml(current.version)],
        ["Model", escapeHtml(current.architecture)],
        ["Classes", `<div class="chips">${(current.classes || []).map((c) => `<span class="chip">${swatch(c)}${escapeHtml(c)}</span>`).join("")}</div>`],
        ["Input", escapeHtml(current.input_size)],
        ["Trained on", escapeHtml(current.dataset)],
        ["File size", current.file_size_mb ? `${current.file_size_mb} MB` : ""],
        ["Released", current.released_at ? fmtDate(current.released_at) : ""],
        ["Notes", escapeHtml(current.notes)],
      ]);
      const metric = (label, v) => `<div class="tile"><span class="tile-label">${label}</span>
          <span class="tile-value">${v != null ? fmtPct(v, 2) : "–"}</span></div>`;
      $("model-metrics").innerHTML =
        metric("Validation accuracy", current.val_accuracy) +
        metric("Test accuracy", current.test_accuracy) +
        metric("Test with TTA", current.tta_accuracy);
    } else {
      $("model-facts").innerHTML = `<p class="empty">No model info in the database yet.</p>`;
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
      return v.length ? `${swatch(l)}${escapeHtml(l)}: ${fmtPct(average(v))} (${fmtInt(v.length)})` : null;
    }).filter(Boolean).join("<br>");
    $("field-facts").innerHTML = scans.length === 0
      ? `<p class="empty">No scans in this period yet.</p>`
      : facts([
          ["Scans", fmtInt(scans.length)],
          ["Average confidence", fmtPct(average(conf))],
          ["Low confidence", `${fmtPct(conf.filter((c) => c < LOW_CONFIDENCE).length / conf.length)} of scans under ${LOW_CONFIDENCE * 100}%`],
          ["Confidence by result", perLabel],
          ["TTA turned on", fmtPct(scans.filter((s) => s.used_tta).length / scans.length, 0)],
          ["Speed with TTA", tta.length ? `${Math.round(median(tta))} ms (median)` : "–"],
          ["Speed without TTA", single.length ? `${Math.round(median(single))} ms (median)` : "–"],
        ]);

    // System
    const all = state.scans;
    const delays = all.filter((s) => s.received_at).map((s) => new Date(s.received_at) - new Date(s.scanned_at));
    const delay = median(delays);
    const lastReceived = all.reduce((m, s) => (s.received_at > m ? s.received_at : m), "");
    const firstScan = all.length ? all[all.length - 1].scanned_at : null;
    let host = "";
    try { host = new URL(CFG.supabaseUrl).host; } catch (e) { /* ignore */ }
    $("system-facts").innerHTML = facts([
      ["Database", `Supabase (PostgreSQL) · ${escapeHtml(host)}`],
      ["Scans stored", fmtInt(all.length)],
      ["Phones that shared", fmtInt(new Set(all.map((s) => s.device_id)).size)],
      ["First shared scan", firstScan ? fmtDate(firstScan) : "–"],
      ["Last scan received", lastReceived ? `${fmtDateTime(lastReceived)} (${timeAgo(lastReceived)})` : "–"],
      ["Typical upload delay", delay != null ? describeDelay(delay) : "–"],
      ["Dashboard", `v${escapeHtml(CFG.dashboardVersion || "1.0")}`],
      ["Data loaded", state.loadedAt ? fmtDateTime(state.loadedAt) : "–"],
    ]);

    // App versions
    const byVersion = new Map();
    for (const s of all) {
      const v = s.app_version || "unknown";
      if (!byVersion.has(v)) byVersion.set(v, { devices: new Set(), scans: 0, last: s.scanned_at });
      const e = byVersion.get(v);
      e.devices.add(s.device_id);
      e.scans += 1;
      if (s.scanned_at > e.last) e.last = s.scanned_at;
    }
    $("app-version-table").querySelector("tbody").innerHTML = byVersion.size === 0
      ? `<tr><td colspan="4" class="empty">No scans shared yet.</td></tr>`
      : [...byVersion.entries()].sort((a, b) => (a[1].last < b[1].last ? 1 : -1)).map(([v, e]) => `<tr>
          <td>${escapeHtml(v)}</td><td class="num">${fmtInt(e.devices.size)}</td>
          <td class="num">${fmtInt(e.scans)}</td><td>${timeAgo(e.last)}</td></tr>`).join("");

    // Model versions
    const scansPerModel = countBy(all, "model_version");
    $("model-version-table").querySelector("tbody").innerHTML = state.models.length === 0
      ? `<tr><td colspan="5" class="empty">No model versions in the database.</td></tr>`
      : state.models.map((m) => `<tr>
          <td>${escapeHtml(m.version)}</td>
          <td class="num">${m.test_accuracy != null ? fmtPct(m.test_accuracy, 2) : "–"}</td>
          <td class="num">${m.tta_accuracy != null ? fmtPct(m.tta_accuracy, 2) : "–"}</td>
          <td class="num">${fmtInt(scansPerModel.get(m.version) || 0)}</td>
          <td>${m.is_current ? "<b>In the app now</b>" : "Older"}</td></tr>`).join("");
  }

  /** Confusion matrix as a shaded table, plus precision, recall and F1 per disease. */
  function renderConfusion(model) {
    const tta = state.cmMode === "tta";
    document.querySelectorAll(".seg-btn[data-cm]").forEach((b) => b.classList.toggle("active", b.dataset.cm === state.cmMode));
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
    const short = { "Bacterial Leaf Blight": "BLB", "Blast": "Blast", "Brown Spot": "Brown Spot", "Normal": "Normal" };

    let html = `<table class="cm-grid"><thead><tr><th></th>${LABELS.map((l) => `<th>${escapeHtml(short[l])}</th>`).join("")}</tr></thead><tbody>`;
    for (let i = 0; i < n; i++) {
      html += `<tr><th class="row-head">${escapeHtml(short[LABELS[i]])}</th>`;
      for (let j = 0; j < n; j++) {
        const v = matrix[i][j];
        const share = rowSum[i] ? v / rowSum[i] : 0; // shade by share of the true class
        const pct = Math.round(Math.max(share, v > 0 ? 0.06 : 0) * 100);
        const ink = share > 0.5 ? "var(--seq-ink)" : "var(--text)";
        html += `<td class="${i === j ? "diag" : ""}" style="background:color-mix(in srgb, var(--seq) ${pct}%, transparent);color:${ink}"
          title="True ${escapeHtml(LABELS[i])}, predicted ${escapeHtml(LABELS[j])}: ${v} of ${rowSum[i]} (${fmtPct(share)})">${v}</td>`;
      }
      html += "</tr>";
    }
    html += `</tbody></table><p class="cm-axis">${fmtInt(correct)} of ${fmtInt(total)} test images correct = ${fmtPct(correct / total, 2)}</p>`;
    $("cm-table").innerHTML = html;
    $("cm-caption").textContent = `Confusion matrix on the test set${tta ? " with TTA (original, flip, brightness)" : " (single view)"}. Rows are the true disease, columns are what the model said.`;

    const rows = LABELS.map((label, i) => {
      const p = colSum[i] ? matrix[i][i] / colSum[i] : 0;
      const r = rowSum[i] ? matrix[i][i] / rowSum[i] : 0;
      const f1 = p + r ? (2 * p * r) / (p + r) : 0;
      return { label, p, r, f1, images: rowSum[i] };
    });
    const avg = (k) => rows.reduce((a, x) => a + x[k], 0) / rows.length;
    $("class-metrics").innerHTML = `<thead><tr><th>Disease</th><th class="num">Precision</th><th class="num">Recall</th><th class="num">F1</th><th class="num">Images</th></tr></thead>
      <tbody>${rows.map((x) => `<tr><td>${swatch(x.label)}${escapeHtml(x.label)}</td><td class="num">${fmtPct(x.p)}</td>
        <td class="num">${fmtPct(x.r)}</td><td class="num">${fmtPct(x.f1)}</td><td class="num">${fmtInt(x.images)}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>Average (macro)</td><td class="num">${fmtPct(avg("p"))}</td><td class="num">${fmtPct(avg("r"))}</td>
        <td class="num">${fmtPct(avg("f1"))}</td><td class="num">${fmtInt(total)}</td></tr></tfoot>`;
  }

  function describeDelay(ms) {
    if (ms < 60 * 1000) return "under a minute";
    if (ms < 3600 * 1000) return `${Math.round(ms / 60000)} min`;
    if (ms < DAY) return `${(ms / 3600000).toFixed(1)} hours`;
    return `${(ms / DAY).toFixed(1)} days (phones were offline)`;
  }

  // ---------- start ----------
  function init() {
    initTheme();
    for (const label of LABELS) $("s-label").insertAdjacentHTML("beforeend", `<option>${escapeHtml(label)}</option>`);
    $("nav").addEventListener("click", (e) => {
      const a = e.target.closest("a[data-page]");
      if (!a) return;
      e.preventDefault();
      goTo(a.dataset.page);
    });
    window.addEventListener("hashchange", () => goTo(location.hash.slice(1)));
    $("range").addEventListener("change", () => { state.scanPage = 0; if (map) map.fitPending = true; renderPage(); });
    $("refresh-button").addEventListener("click", loadData);
    $("alert-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      state.alertRule = {
        min: Math.max(2, Number($("a-min").value) || 3),
        radius: Math.max(0.2, Number($("a-radius").value) || 1),
        days: Math.max(1, Number($("a-days").value) || 14),
      };
      try { await fetchAlerts(); } catch (err) { toast(`Could not check alerts: ${err.message}`); }
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
    initAuth();
  }

  init();
})();
