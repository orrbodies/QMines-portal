/* QMines Drillhole Database portal — application logic */
"use strict";

const sb = window.supabase.createClient(QMINES_CONFIG.SUPABASE_URL, QMINES_CONFIG.SUPABASE_KEY);

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 100;
const FETCH_CHUNK = 1000;
const PROJECT_COLORS = { "Mt Chalmers": "#c9573c", "Develin Creek": "#3e7c6f", "Mt Mackenzie": "#5b6da8" };

/* ================= auth ================= */

async function init() {
  const { data: { session } } = await sb.auth.getSession();
  setAuthed(!!session, session);
  sb.auth.onAuthStateChange((_evt, sess) => setAuthed(!!sess, sess));
}

function setAuthed(isAuthed, session) {
  $("login-screen").classList.toggle("hidden", isAuthed);
  $("app").classList.toggle("hidden", !isAuthed);
  if (isAuthed) {
    $("user-email").textContent = session.user.email;
    startApp();
  }
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  $("login-btn").disabled = true;
  const { error } = await sb.auth.signInWithPassword({
    email: $("login-email").value.trim(),
    password: $("login-password").value,
  });
  $("login-btn").disabled = false;
  if (error) $("login-error").textContent = "Sign-in failed — check your email and password.";
});

$("logout-btn").addEventListener("click", () => sb.auth.signOut());

/* ================= view switching ================= */

document.querySelectorAll(".view-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".view-tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + tab.dataset.view));
    if (tab.dataset.view === "map" && map) setTimeout(() => map.invalidateSize(), 60);
  });
});

/* ================= shared helpers ================= */

function showLoading(text) { $("loading-text").textContent = text; $("loading-overlay").classList.remove("hidden"); }
function hideLoading() { $("loading-overlay").classList.add("hidden"); }

async function fetchAll(buildQuery) {
  // pages through Supabase's 1000-row cap
  let rows = [], from = 0;
  for (;;) {
    const { data, error } = await buildQuery().range(from, from + FETCH_CHUNK - 1);
    if (error) throw error;
    rows = rows.concat(data);
    if (data.length < FETCH_CHUNK) break;
    from += FETCH_CHUNK;
  }
  return rows;
}

/* ================= MAP ================= */

let map = null, holeLayer = null, tenementLayer = null, basemaps = {};
let allHoles = [];
let appStarted = false;

async function startApp() {
  if (appStarted) return;
  appStarted = true;
  initMap();
  try {
    showLoading("Loading drillholes\u2026");
    await Promise.all([loadHoles(), loadTenements()]);
    renderHoles();
    hideLoading();
  } catch (err) {
    hideLoading();
    $("map-count").textContent = "Failed to load data: " + (err.message || err);
  }
  loadProspects();
  runQuery(true);
}

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([-23.05, 150.0], 8);
  basemaps.satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Imagery \u00a9 Esri &mdash; Source: Esri, Maxar, Earthstar Geographics" });
  basemaps.street = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    { maxZoom: 19, attribution: "\u00a9 OpenStreetMap contributors" });
  basemaps.satellite.addTo(map);
  holeLayer = L.layerGroup().addTo(map);
  tenementLayer = L.layerGroup().addTo(map);

  document.querySelectorAll('input[name="basemap"]').forEach((r) =>
    r.addEventListener("change", () => {
      Object.values(basemaps).forEach((l) => map.removeLayer(l));
      basemaps[r.value].addTo(map);
    }));
  document.querySelectorAll(".f-project, .f-source").forEach((c) => c.addEventListener("change", renderHoles));
  $("f-planned-only").addEventListener("change", renderHoles);
  $("f-tenements").addEventListener("change", (e) =>
    e.target.checked ? tenementLayer.addTo(map) : map.removeLayer(tenementLayer));
}

async function loadHoles() {
  allHoles = await fetchAll(() => sb.from("collars").select(
    "hole_id,project_name,prospect,data_source,source_company,hole_type,latitude,longitude," +
    "max_depth,year,coordinate_status,mga2020_east,mga2020_north,mga_zone"));
}

function renderHoles() {
  const projects = new Set([...document.querySelectorAll(".f-project:checked")].map((c) => c.value));
  const sources = new Set([...document.querySelectorAll(".f-source:checked")].map((c) => c.value));
  const plannedOnly = $("f-planned-only").checked;
  holeLayer.clearLayers();
  let shown = 0;
  const bounds = [];
  for (const h of allHoles) {
    if (h.latitude == null) continue;
    if (!projects.has(h.project_name) || !sources.has(h.data_source)) continue;
    if (plannedOnly && h.coordinate_status !== "Planned") continue;
    const planned = h.coordinate_status === "Planned";
    const color = PROJECT_COLORS[h.project_name] || "#888";
    const m = L.circleMarker([h.latitude, h.longitude], {
      radius: h.data_source === "QMines" ? 6 : 4.5,
      color, weight: planned ? 2 : 1.5,
      dashArray: planned ? "3 3" : null,
      fillColor: color,
      fillOpacity: planned ? 0 : (h.data_source === "QMines" ? 0.9 : 0.45),
    });
    m.bindPopup(holePopup(h), { maxWidth: 300 });
    holeLayer.addLayer(m);
    bounds.push([h.latitude, h.longitude]);
    shown++;
  }
  $("map-count").textContent = `${shown.toLocaleString()} of ${allHoles.length.toLocaleString()} holes shown`;
  if (bounds.length && !renderHoles._fitted) { map.fitBounds(bounds, { padding: [30, 30] }); renderHoles._fitted = true; }
}

function holePopup(h) {
  const row = (k, v) => (v == null || v === "" ? "" : `<dt>${k}</dt><dd>${v}</dd>`);
  return `<div class="popup-hole">${h.hole_id}</div>
    <dl class="popup-grid">
      ${row("Project", h.project_name)}
      ${row("Prospect", h.prospect)}
      ${row("Source", h.data_source + (h.source_company && h.source_company !== "QMines" ? " (" + h.source_company + ")" : ""))}
      ${row("Type", h.hole_type)}
      ${row("Depth", h.max_depth != null ? h.max_depth + " m" : null)}
      ${row("Year", h.year)}
      ${row("East (MGA2020)", h.mga2020_east)}
      ${row("North (MGA2020)", h.mga2020_north)}
      ${row("Zone", h.mga_zone)}
      ${row("Position", h.coordinate_status)}
    </dl>`;
}

async function loadTenements() {
  const rows = await fetchAll(() => sb.from("tenements").select(
    "tenement_number,status,minerals,holder_name,area_ha,expiry_date,geom_wkt"));
  for (const t of rows) {
    const polys = parseMultiPolygon(t.geom_wkt);
    if (!polys.length) continue;
    const layer = L.polygon(polys, {
      color: "#e0a05c", weight: 2, fillOpacity: 0.04,
      dashArray: t.status && t.status.toLowerCase().includes("application") ? "6 4" : null,
    });
    layer.bindPopup(`<div class="popup-hole">${t.tenement_number}</div>
      <dl class="popup-grid">
        <dt>Status</dt><dd>${t.status || "\u2014"}</dd>
        <dt>Holder</dt><dd>${t.holder_name || "\u2014"}</dd>
        <dt>Minerals</dt><dd>${t.minerals || "\u2014"}</dd>
        <dt>Area</dt><dd>${t.area_ha ? t.area_ha.toLocaleString() + " ha" : "\u2014"}</dd>
        <dt>Expiry</dt><dd>${t.expiry_date || "\u2014"}</dd>
      </dl>`, { maxWidth: 300 });
    tenementLayer.addLayer(layer);
  }
}

function parseMultiPolygon(wkt) {
  // "MULTIPOLYGON(((lon lat, ...),(hole ...)), ((...)))" -> Leaflet [[[lat,lon],...]] per polygon(with holes)
  if (!wkt) return [];
  const body = wkt.replace(/^\s*MULTIPOLYGON\s*/i, "").trim();
  const polygons = [];
  // split top-level (( ... )) groups
  const polyRe = /\(\(([\s\S]*?)\)\)/g;
  let m;
  while ((m = polyRe.exec(body)) !== null) {
    const rings = m[1].split(/\)\s*,\s*\(/).map((ring) =>
      ring.split(",").map((pt) => {
        const [lon, lat] = pt.trim().split(/\s+/).map(Number);
        return [lat, lon];
      }).filter((p) => !Number.isNaN(p[0]) && !Number.isNaN(p[1]))
    );
    if (rings.length && rings[0].length >= 3) polygons.push(rings);
  }
  return polygons;
}

/* ================= DATA BROWSER ================= */

const TABLE_DEFS = {
  collars: {
    cols: ["hole_id","project_name","prospect","data_source","source_company","hole_type",
           "mga2020_east","mga2020_north","rl","max_depth","year","coordinate_status"],
    projectCol: "project_name", prospectCol: "prospect", sourceCol: "data_source",
    holeCol: "hole_id", order: "hole_id",
  },
  samples_assays: {
    cols: ["sample_id","hole_id","from_m","to_m","sample_type","sample_priority","data_source",
           "au_ppm","ag_ppm","cu_ppm","pb_ppm","zn_ppm","s_pct","fe_pct","as_ppm"],
    embed: true, sourceCol: "data_source", holeCol: "hole_id", priority: true, order: "sample_id",
  },
  lithology_qmines: {
    cols: ["hole_id","from_m","to_m","lith_1","lith_2","weathering","oxidation","alt1","alt2",
           "mineral1","vein1","description"],
    embed: true, holeCol: "hole_id", order: "hole_id",
  },
  lithology_historical: {
    cols: ["hole_id","from_m","to_m","lith_1","lith_2","lith_3","colour","weathering","oxidation",
           "alteration_1","mineral_1","description"],
    embed: true, holeCol: "hole_id", order: "hole_id",
  },
  survey: {
    cols: ["hole_id","depth","dip","azimuth_true","azimuth_grid","azimuth_mag","instrument","date_surveyed"],
    embed: true, holeCol: "hole_id", order: "hole_id",
  },
  rqd: {
    cols: ["hole_id","from_m","to_m","core_size","drilled_m","recovered_m","core_recovery_ratio","rqd_ratio"],
    embed: true, holeCol: "hole_id", order: "hole_id",
  },
  sg: {
    cols: ["hole_id","from_m","to_m","density","comment"],
    embed: true, holeCol: "hole_id", order: "hole_id",
  },
  structure: {
    cols: ["hole_id","depth","planar_structure","dip","dip_direction","comment"],
    embed: true, holeCol: "hole_id", order: "hole_id",
  },
  assay_results_by_method: {
    cols: ["sample_id","hole_id","element","method","value","unit","is_best","lab","job_number"],
    embed: true, holeCol: "hole_id", order: "sample_id",
  },
  tenements: {
    cols: ["tenement_number","tenement_type","status","minerals","holder_name","permit_name",
           "area_ha","lodge_date","expiry_date"],
    order: "tenement_number",
  },
};

let currentPage = 0, totalRows = 0;

$("table-select").addEventListener("change", () => { syncFilterVisibility(); runQuery(true); });
$("apply-btn").addEventListener("click", () => runQuery(true));
$("d-project").addEventListener("change", loadProspects);
$("prev-btn").addEventListener("click", () => { currentPage--; runQuery(false); });
$("next-btn").addEventListener("click", () => { currentPage++; runQuery(false); });
$("export-btn").addEventListener("click", exportCSV);
$("d-hole").addEventListener("keydown", (e) => { if (e.key === "Enter") runQuery(true); });

function syncFilterVisibility() {
  const def = TABLE_DEFS[$("table-select").value];
  $("fg-project").style.display = (def.projectCol || def.embed) ? "" : "none";
  $("fg-prospect").style.display = (def.prospectCol || def.embed) ? "" : "none";
  $("fg-source").style.display = def.sourceCol ? "" : "none";
  $("fg-hole").style.display = def.holeCol ? "" : "none";
  $("fg-priority").style.display = def.priority ? "" : "none";
}

async function loadProspects() {
  const project = $("d-project").value;
  let q = sb.from("collars").select("prospect");
  if (project) q = q.eq("project_name", project);
  const { data } = await q;
  const prospects = [...new Set((data || []).map((r) => r.prospect).filter(Boolean))].sort();
  $("d-prospect").innerHTML = '<option value="">All prospects</option>' +
    prospects.map((p) => `<option>${p}</option>`).join("");
}

function buildQuery(def, table, { count = false, forExport = false } = {}) {
  const selectCols = forExport ? "*" : def.cols.join(",");
  const embed = def.embed ? ",collars!inner(project_name,prospect)" : "";
  let q = sb.from(table).select(selectCols + embed, count ? { count: "exact" } : {});
  const project = $("d-project").value, prospect = $("d-prospect").value,
        source = $("d-source").value, hole = $("d-hole").value.trim(),
        priority = $("d-priority").value;
  if (project) q = def.embed ? q.eq("collars.project_name", project) : (def.projectCol ? q.eq(def.projectCol, project) : q);
  if (prospect) q = def.embed ? q.eq("collars.prospect", prospect) : (def.prospectCol ? q.eq(def.prospectCol, prospect) : q);
  if (source && def.sourceCol) q = q.eq(def.sourceCol, source);
  if (hole && def.holeCol) q = q.ilike(def.holeCol, `%${hole}%`);
  if (priority && def.priority) q = q.eq("sample_priority", priority);
  if (def.order) q = q.order(def.order);
  return q;
}

async function runQuery(resetPage) {
  const table = $("table-select").value;
  const def = TABLE_DEFS[table];
  if (resetPage) currentPage = 0;
  syncFilterVisibility();
  showLoading("Loading data\u2026");
  try {
    const from = currentPage * PAGE_SIZE;
    const { data, count, error } = await buildQuery(def, table, { count: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    totalRows = count ?? 0;
    renderTable(def, data || []);
    $("row-count").textContent = `${totalRows.toLocaleString()} rows match`;
    const lastPage = Math.max(0, Math.ceil(totalRows / PAGE_SIZE) - 1);
    $("page-label").textContent = `Page ${currentPage + 1} of ${lastPage + 1}`;
    $("prev-btn").disabled = currentPage === 0;
    $("next-btn").disabled = currentPage >= lastPage;
    $("export-note").textContent = totalRows > 0
      ? `Download exports all ${totalRows.toLocaleString()} matching rows with every column.` : "";
  } catch (err) {
    $("row-count").textContent = "Query failed: " + (err.message || err);
  } finally {
    hideLoading();
  }
}

function renderTable(def, rows) {
  const thead = document.querySelector("#data-table thead");
  const tbody = document.querySelector("#data-table tbody");
  const showProj = def.embed;
  const headers = (showProj ? ["project", "prospect"] : []).concat(def.cols);
  thead.innerHTML = "<tr>" + headers.map((h) => `<th>${h.replaceAll("_", " ")}</th>`).join("") + "</tr>";
  tbody.innerHTML = rows.map((r) => {
    const cells = [];
    if (showProj) {
      cells.push(`<td>${r.collars?.project_name ?? ""}</td>`, `<td>${r.collars?.prospect ?? ""}</td>`);
    }
    for (const c of def.cols) {
      let v = r[c];
      if (v == null) { cells.push("<td></td>"); continue; }
      const isNum = typeof v === "number";
      const cls = isNum ? "num" : (/_id$|^hole_id$|tenement_number/.test(c) ? "mono" : "");
      const neg = isNum && v < 0 && /_ppm$|_pct$/.test(c);
      const shown = neg ? `<span class="below-dl">&lt;${Math.abs(v)}</span>` : String(v);
      cells.push(`<td class="${cls}">${shown}</td>`);
    }
    return "<tr>" + cells.join("") + "</tr>";
  }).join("");
}

/* ================= CSV export ================= */

async function exportCSV() {
  const table = $("table-select").value;
  const def = TABLE_DEFS[table];
  if (!totalRows) { alert("Nothing to export — apply filters first."); return; }
  if (totalRows > 60000 && !confirm(`This will export ${totalRows.toLocaleString()} rows — it may take a minute. Continue?`)) return;
  showLoading(`Exporting ${totalRows.toLocaleString()} rows\u2026`);
  try {
    const rows = await fetchAll(() => buildQuery(def, table, { forExport: true }));
    if (!rows.length) throw new Error("no rows returned");
    // flatten embedded project/prospect, drop nested object
    const flat = rows.map((r) => {
      const { collars, ...rest } = r;
      return def.embed ? { project_name: collars?.project_name, prospect: collars?.prospect, ...rest } : rest;
    });
    const cols = Object.keys(flat[0]);
    const esc = (v) => v == null ? "" : /[",\n]/.test(String(v)) ? '"' + String(v).replaceAll('"', '""') + '"' : String(v);
    const csv = [cols.join(",")].concat(flat.map((r) => cols.map((c) => esc(r[c])).join(","))).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `qmines_${table}_${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    alert("Export failed: " + (err.message || err));
  } finally {
    hideLoading();
  }
}

/* ================= boot ================= */
syncFilterVisibility();
init();
