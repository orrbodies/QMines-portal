/* QMines Drillhole Database portal — application logic (v2) */
"use strict";

const sb = window.supabase.createClient(QMINES_CONFIG.SUPABASE_URL, QMINES_CONFIG.SUPABASE_KEY);

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 100;
const FETCH_CHUNK = 1000;
const ID_CHUNK = 150; // hole_ids per .in() query, keeps URLs safely short
const PROJECT_COLORS = { "Mt Chalmers": "#c9573c", "Develin Creek": "#3e7c6f", "Mt Mackenzie": "#5b6da8" };
const LABEL_ZOOM = 13; // show hole labels at this zoom and closer

/* Grade colour ramps - EDIT RANGES/COLOURS HERE.
   Values in ppm (Au ppm = g/t). Each band: up to (exclusive) -> colour. */
const GRADE_RAMPS = {
  max_cu_ppm: { label: "Max Cu", unit: "ppm", bands: [
    { upTo: 1000,     color: "#7f9bb3", name: "< 1,000 (<0.1%)" },
    { upTo: 5000,     color: "#4f9c62", name: "1,000 – 5,000" },
    { upTo: 10000,    color: "#e0932f", name: "5,000 – 10,000" },
    { upTo: Infinity, color: "#cf3f2a", name: "\u2265 10,000 (\u22651%)" },
  ]},
  max_au_ppm: { label: "Max Au", unit: "g/t", bands: [
    { upTo: 0.1,      color: "#7f9bb3", name: "< 0.1" },
    { upTo: 0.5,      color: "#4f9c62", name: "0.1 – 0.5" },
    { upTo: 1,        color: "#e0932f", name: "0.5 – 1" },
    { upTo: Infinity, color: "#cf3f2a", name: "\u2265 1" },
  ]},
  max_zn_ppm: { label: "Max Zn", unit: "ppm", bands: [
    { upTo: 5000,     color: "#7f9bb3", name: "< 5,000" },
    { upTo: 20000,    color: "#4f9c62", name: "5,000 – 20,000" },
    { upTo: 50000,    color: "#e0932f", name: "20,000 – 50,000" },
    { upTo: Infinity, color: "#cf3f2a", name: "\u2265 50,000 (\u22655%)" },
  ]},
};
const NO_ASSAY_COLOR = "#9b9b93";

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

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const csvEsc = (v) => v == null ? "" : /[",\n]/.test(String(v)) ? '"' + String(v).replaceAll('"', '""') + '"' : String(v);
function toCSV(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  return [cols.join(",")].concat(rows.map((r) => cols.map((c) => csvEsc(r[c])).join(","))).join("\n");
}
function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
const dateStamp = () => new Date().toISOString().slice(0, 10);

/* ================= MAP ================= */

let map = null, holeLayer = null, tenementLayer = null, prospectLayer = null, drawLayer = null, basemaps = {};
let allHoles = [];
let markerByHole = new Map();
let prospectMarkers = [];
let selectedHoles = null; // array of hole objects inside drawn region, or null
let appStarted = false;

async function startApp() {
  if (appStarted) return;
  appStarted = true;
  initMap();
  try {
    showLoading("Loading drillholes\u2026");
    await Promise.all([loadHoles(), loadTenements()]);
    await loadProspectPoints(); // after holes, so popups can count linked drilling
    populateHoleTypes();
    renderHoles();
    hideLoading();
  } catch (err) {
    hideLoading();
    $("map-count").textContent = "Failed to load data: " + (err.message || err);
  }
  loadProspects();
  loadTenementList();
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
  prospectLayer = L.layerGroup().addTo(map);
  drawLayer = new L.FeatureGroup().addTo(map);

  // region-draw tools (polygon + rectangle)
  const drawControl = new L.Control.Draw({
    position: "topleft",
    draw: {
      polygon: { allowIntersection: false, showArea: false,
                 shapeOptions: { color: "#e0a05c", weight: 2 } },
      rectangle: { shapeOptions: { color: "#e0a05c", weight: 2 } },
      polyline: false, circle: false, marker: false, circlemarker: false,
    },
    edit: { featureGroup: drawLayer, edit: false, remove: false },
  });
  map.addControl(drawControl);
  map.on(L.Draw.Event.CREATED, (e) => {
    drawLayer.clearLayers();
    drawLayer.addLayer(e.layer);
    applyRegionSelection(e.layer);
  });

  document.querySelectorAll('input[name="basemap"]').forEach((r) =>
    r.addEventListener("change", () => {
      Object.values(basemaps).forEach((l) => map.removeLayer(l));
      basemaps[r.value].addTo(map);
    }));
  document.querySelectorAll(".f-project, .f-source").forEach((c) => c.addEventListener("change", renderHoles));
  $("f-planned-only").addEventListener("change", renderHoles);
  $("f-holetype").addEventListener("change", renderHoles);
  $("colour-mode").addEventListener("change", () => { renderLegend(); renderHoles(); });
  $("f-tenements").addEventListener("change", (e) =>
    e.target.checked ? tenementLayer.addTo(map) : map.removeLayer(tenementLayer));
  $("f-prospects").addEventListener("change", (e) => {
    if (e.target.checked) { prospectLayer.addTo(map); updateProspectLabels(); }
    else map.removeLayer(prospectLayer);
  });
  $("f-labels").addEventListener("change", updateLabels);
  map.on("zoomend moveend", () => { updateLabels(); updateProspectLabels(); });
  $("sel-clear").addEventListener("click", clearSelection);
  $("sel-export").addEventListener("click", exportSelection);
}

async function loadHoles() {
  const [holes, maxes] = await Promise.all([
    fetchAll(() => sb.from("collars").select(
      "hole_id,project_name,prospect,data_source,source_company,hole_type,latitude,longitude," +
      "max_depth,year,coordinate_status,mga2020_east,mga2020_north,mga_zone,tenement")),
    fetchAll(() => sb.from("collar_max_assays").select("*")).catch(() => []),
  ]);
  const maxByHole = new Map(maxes.map((m) => [m.hole_id, m]));
  allHoles = holes.map((h) => ({ ...h, ...(maxByHole.get(h.hole_id) || {}) }));
}

function populateHoleTypes() {
  const types = [...new Set(allHoles.map((h) => h.hole_type).filter(Boolean))].sort();
  const opts = '<option value="">All types</option>' + types.map((t) => `<option>${t}</option>`).join("");
  $("f-holetype").innerHTML = opts;
  $("d-holetype").innerHTML = opts;
}

function currentColourMode() { return $("colour-mode").value; }

function colourFor(h) {
  const mode = currentColourMode();
  if (mode === "project") return PROJECT_COLORS[h.project_name] || "#888";
  const ramp = GRADE_RAMPS[mode];
  const v = h[mode];
  if (v == null) return NO_ASSAY_COLOR;
  for (const band of ramp.bands) if (v < band.upTo) return band.color;
  return ramp.bands[ramp.bands.length - 1].color;
}

function renderLegend() {
  const mode = currentColourMode();
  const box = $("grade-legend");
  if (mode === "project") { box.classList.add("hidden"); box.innerHTML = ""; return; }
  const ramp = GRADE_RAMPS[mode];
  box.innerHTML = `<div class="legend-title">${ramp.label} (${ramp.unit}, primary samples)</div>` +
    ramp.bands.map((b) => `<div class="legend-row"><span class="swatch" style="background:${b.color}"></span>${b.name}</div>`).join("") +
    `<div class="legend-row"><span class="swatch" style="background:${NO_ASSAY_COLOR}"></span>no assays</div>`;
  box.classList.remove("hidden");
}

function holeVisible(h) {
  const projects = new Set([...document.querySelectorAll(".f-project:checked")].map((c) => c.value));
  const sources = new Set([...document.querySelectorAll(".f-source:checked")].map((c) => c.value));
  const holeType = $("f-holetype").value;
  if (h.latitude == null) return false;
  if (!projects.has(h.project_name) || !sources.has(h.data_source)) return false;
  if ($("f-planned-only").checked && h.coordinate_status !== "Planned") return false;
  if (holeType && h.hole_type !== holeType) return false;
  return true;
}

function renderHoles() {
  holeLayer.clearLayers();
  markerByHole.clear();
  let shown = 0;
  const bounds = [];
  const selSet = selectedHoles ? new Set(selectedHoles.map((h) => h.hole_id)) : null;
  for (const h of allHoles) {
    if (!holeVisible(h)) continue;
    const planned = h.coordinate_status === "Planned";
    const color = colourFor(h);
    const inSel = selSet ? selSet.has(h.hole_id) : true;
    const m = L.circleMarker([h.latitude, h.longitude], {
      radius: h.data_source === "QMines" ? 6 : 4.5,
      color: inSel ? color : "#777",
      weight: planned ? 2 : 1.5,
      dashArray: planned ? "3 3" : null,
      fillColor: color,
      fillOpacity: !inSel ? 0.08 : planned ? 0 : (h.data_source === "QMines" ? 0.9 : 0.5),
      opacity: inSel ? 1 : 0.35,
    });
    m.bindPopup(holePopup(h), { maxWidth: 300 });
    holeLayer.addLayer(m);
    markerByHole.set(h.hole_id, { marker: m, hole: h });
    bounds.push([h.latitude, h.longitude]);
    shown++;
  }
  $("map-count").textContent = `${shown.toLocaleString()} of ${allHoles.length.toLocaleString()} holes shown`;
  if (bounds.length && !renderHoles._fitted) { map.fitBounds(bounds, { padding: [30, 30] }); renderHoles._fitted = true; }
  updateLabels();
}

function updateLabels() {
  const on = $("f-labels").checked && map.getZoom() >= LABEL_ZOOM;
  const view = map.getBounds();
  markerByHole.forEach(({ marker, hole }) => {
    const should = on && view.contains(marker.getLatLng());
    const has = !!marker.getTooltip();
    if (should && !has) {
      marker.bindTooltip(hole.hole_id, { permanent: true, direction: "right",
        offset: [8, 0], className: "hole-label" });
    } else if (!should && has) {
      marker.unbindTooltip();
    }
  });
}

function holePopup(h) {
  const mode = currentColourMode();
  const row = (k, v) => (v == null || v === "" ? "" : `<dt>${k}</dt><dd>${v}</dd>`);
  const grade = mode !== "project" && h[mode] != null
    ? row(GRADE_RAMPS[mode].label, h[mode].toLocaleString() + " " + GRADE_RAMPS[mode].unit) : "";
  return `<div class="popup-hole">${h.hole_id}</div>
    <dl class="popup-grid">
      ${row("Project", h.project_name)}
      ${row("Prospect", h.prospect)}
      ${row("Tenement", h.tenement)}
      ${row("Source", h.data_source + (h.source_company && h.source_company !== "QMines" ? " (" + h.source_company + ")" : ""))}
      ${row("Type", h.hole_type)}
      ${row("Depth", h.max_depth != null ? h.max_depth + " m" : null)}
      ${row("Year", h.year)}
      ${grade}
      ${row("East (MGA2020)", h.mga2020_east)}
      ${row("North (MGA2020)", h.mga2020_north)}
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
    layer.bindPopup(() => {
      const n = allHoles.filter((h) => h.tenement === t.tenement_number).length;
      return `<div class="popup-hole">${t.tenement_number}</div>
      <dl class="popup-grid">
        <dt>Status</dt><dd>${t.status || "\u2014"}</dd>
        <dt>Holder</dt><dd>${t.holder_name || "\u2014"}</dd>
        <dt>Minerals</dt><dd>${t.minerals || "\u2014"}</dd>
        <dt>Area</dt><dd>${t.area_ha ? t.area_ha.toLocaleString() + " ha" : "\u2014"}</dd>
        <dt>Expiry</dt><dd>${t.expiry_date || "\u2014"}</dd>
        <dt>Drillholes</dt><dd>${n.toLocaleString()}</dd>
      </dl>
      <p class="popup-tip">Data tab \u2192 Tenement filter to browse/export these holes.</p>`;
    }, { maxWidth: 300 });
    tenementLayer.addLayer(layer);
  }
}

/* ---------- prospect points layer ---------- */

const PROSPECT_LABEL_ZOOM = 12;

function normName(s) {
  return String(s).toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

function holesForProspectPoint(name) {
  // match the point name (or each part of compound "A / B" names) against
  // the drillholes' prospect attribution, ignoring case and punctuation
  const parts = [name].concat(String(name).split(/\s*\/\s*/));
  const targets = new Set(parts.map(normName).filter(Boolean));
  return allHoles.filter((h) => h.prospect && targets.has(normName(h.prospect)));
}

async function loadProspectPoints() {
  let rows = [];
  try {
    rows = await fetchAll(() => sb.from("prospects").select(
      "prospect_name,project_name,latitude,longitude,mga2020_east,mga2020_north,mga_zone"));
  } catch (e) {
    return; // table not created yet - layer simply stays empty
  }
  for (const p of rows) {
    if (p.latitude == null) continue;
    const color = PROJECT_COLORS[p.project_name] || "#888";
    const icon = L.divIcon({
      className: "",
      html: `<div class="prospect-pin" style="border-color:${color}"></div>`,
      iconSize: [12, 12], iconAnchor: [6, 6],
    });
    const m = L.marker([p.latitude, p.longitude], { icon, zIndexOffset: -100 });
    m.bindPopup(() => {
      const linked = holesForProspectPoint(p.prospect_name);
      const drillRow = linked.length
        ? `<dt>Drillholes</dt><dd>${linked.length.toLocaleString()}</dd>`
        : `<dt>Drillholes</dt><dd>none attributed</dd>`;
      const tip = linked.length
        ? `<p class="popup-tip">Data tab \u2192 Prospect filter to browse/export these holes.</p>` : "";
      return `<div class="popup-hole">${p.prospect_name}</div>
        <dl class="popup-grid">
          <dt>Project</dt><dd>${p.project_name || "\u2014"}</dd>
          ${drillRow}
          <dt>East (MGA2020)</dt><dd>${p.mga2020_east}</dd>
          <dt>North (MGA2020)</dt><dd>${p.mga2020_north}</dd>
          <dt>Zone</dt><dd>${p.mga_zone}</dd>
        </dl>${tip}`;
    }, { maxWidth: 300 });
    prospectLayer.addLayer(m);
    prospectMarkers.push({ marker: m, name: p.prospect_name });
  }
  updateProspectLabels();
}

function updateProspectLabels() {
  if (!map) return;
  const on = map.getZoom() >= PROSPECT_LABEL_ZOOM && map.hasLayer(prospectLayer);
  const view = map.getBounds();
  for (const { marker, name } of prospectMarkers) {
    const should = on && view.contains(marker.getLatLng());
    const has = !!marker.getTooltip();
    if (should && !has) {
      marker.bindTooltip(name, { permanent: true, direction: "top",
        offset: [0, -8], className: "prospect-label" });
    } else if (!should && has) {
      marker.unbindTooltip();
    }
  }
}

function parseMultiPolygon(wkt) {
  if (!wkt) return [];
  const body = wkt.replace(/^\s*MULTIPOLYGON\s*/i, "").trim();
  const polygons = [];
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

/* ---------- region selection ---------- */

function pointInRing(lat, lon, ring) {
  // ray casting; ring = [[lat,lon],...]
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function applyRegionSelection(layer) {
  let rings;
  if (layer instanceof L.Rectangle || layer instanceof L.Polygon) {
    const latlngs = layer.getLatLngs();
    // normalize to array of outer rings
    const outer = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
    rings = [outer.map((ll) => [ll.lat, ll.lng])];
  } else return;
  selectedHoles = allHoles.filter((h) =>
    h.latitude != null && holeVisible(h) &&
    rings.some((ring) => pointInRing(h.latitude, h.longitude, ring)));
  $("sel-count").textContent = selectedHoles.length.toLocaleString();
  $("selection-box").classList.remove("hidden");
  renderHoles();
}

function clearSelection() {
  selectedHoles = null;
  drawLayer.clearLayers();
  $("selection-box").classList.add("hidden");
  renderHoles();
}

async function exportSelection() {
  if (!selectedHoles || !selectedHoles.length) return;
  const ids = selectedHoles.map((h) => h.hole_id);
  const withRelated = $("sel-related").checked;
  await exportHoleBundle(ids, withRelated, "map_selection");
}

/* ---------- shared bundle export (holes + daughter data) ---------- */

const RELATED_TABLES = ["survey", "lithology_qmines", "lithology_historical", "rqd", "sg",
                         "structure", "drilling_details", "samples_assays", "assay_results_by_method"];

const TABLE_ORDER_COLS = {
  collars: ["hole_id"],
  survey: ["hole_id", "depth"],
  lithology_qmines: ["hole_id", "from_m"],
  lithology_historical: ["hole_id", "from_m"],
  rqd: ["hole_id", "from_m"],
  sg: ["hole_id", "from_m"],
  structure: ["hole_id", "depth"],
  drilling_details: ["hole_id"],
  samples_assays: ["sample_id"],
  assay_results_by_method: ["sample_id", "element", "method"],
};

async function fetchInChunks(table, holeIds) {
  // pages through Supabase's Max Rows cap for each chunk of hole_ids;
  // explicit order() makes each page a stable, non-overlapping slice
  let rows = [];
  const orderCols = TABLE_ORDER_COLS[table] || ["hole_id"];
  for (const ids of chunk(holeIds, ID_CHUNK)) {
    let from = 0;
    for (;;) {
      let q = sb.from(table).select("*").in("hole_id", ids);
      for (const col of orderCols) q = q.order(col);
      const { data, error } = await q.range(from, from + FETCH_CHUNK - 1);
      if (error) throw error;
      rows = rows.concat(data);
      if (data.length < FETCH_CHUNK) break;
      from += FETCH_CHUNK;
    }
  }
  return rows;
}

async function exportHoleBundle(holeIds, includeRelated, label) {
  showLoading(`Exporting ${holeIds.length.toLocaleString()} holes…`);
  try {
    const collars = await fetchInChunks("collars", holeIds);
    if (!includeRelated) {
      downloadBlob(new Blob([toCSV(collars)], { type: "text/csv" }),
        `qmines_${label}_collars_${dateStamp()}.csv`);
      return;
    }
    const zip = new JSZip();
    zip.file("collars.csv", toCSV(collars));
    for (const table of RELATED_TABLES) {
      showLoading(`Exporting ${table.replaceAll("_", " ")}…`);
      const rows = await fetchInChunks(table, holeIds);
      if (rows.length) zip.file(`${table}.csv`, toCSV(rows));
    }
    showLoading("Building zip…");
    const blob = await zip.generateAsync({ type: "blob" });
    downloadBlob(blob, `qmines_${label}_${dateStamp()}.zip`);
  } catch (err) {
    alert("Export failed: " + (err.message || err));
  } finally {
    hideLoading();
  }
}

/* ================= DATA BROWSER ================= */

const TABLE_DEFS = {
  collars: {
    cols: ["hole_id","project_name","prospect","tenement","data_source","source_company","hole_type",
           "mga2020_east","mga2020_north","rl","max_depth","year","coordinate_status"],
    projectCol: "project_name", prospectCol: "prospect", sourceCol: "data_source",
    holeCol: "hole_id", holeTypeCol: "hole_type", coords: true, yearCol: "year",
    tenementCol: "tenement", order: "hole_id",
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
        cols: ["hole_id","depth","planar_structure","alpha","beta","dip","dip_direction","thickness_mm","mineral_1","mineral_2","mineral_3","mineral_4","comment"],
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
  const show = (id, cond) => { $(id).style.display = cond ? "" : "none"; };
  show("fg-project", !!(def.projectCol || def.embed));
  show("fg-prospect", !!(def.prospectCol || def.embed));
  show("fg-tenement", !!(def.tenementCol || def.embed));
  show("fg-source", !!def.sourceCol);
  show("fg-holetype", !!(def.holeTypeCol || def.embed));
  show("fg-hole", !!def.holeCol);
  show("fg-year", !!(def.yearCol || def.embed));
  show("fg-east", !!(def.coords || def.embed));
  show("fg-north", !!(def.coords || def.embed));
  show("fg-priority", !!def.priority);
  document.querySelector(".export-related").style.display = def.embed || def.coords ? "" : "none";
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

async function loadTenementList() {
  const { data } = await sb.from("tenements").select("tenement_number").order("tenement_number");
  $("d-tenement").innerHTML = '<option value="">All tenements</option>' +
    (data || []).map((t) => `<option>${t.tenement_number}</option>`).join("");
}

function numOrNull(id) {
  const v = $(id).value.trim();
  return v === "" ? null : Number(v);
}

function buildQuery(def, table, { count = false, forExport = false } = {}) {
  const selectCols = forExport ? "*" : def.cols.join(",");
  const embed = def.embed ? ",collars!inner(project_name,prospect,tenement,hole_type,year,mga2020_east,mga2020_north)" : "";
  let q = sb.from(table).select(selectCols + embed, count ? { count: "exact" } : {});
  const project = $("d-project").value, prospect = $("d-prospect").value,
        tenement = $("d-tenement").value, source = $("d-source").value,
        holeType = $("d-holetype").value, hole = $("d-hole").value.trim(),
        priority = $("d-priority").value,
        yearMin = numOrNull("d-year-min"), yearMax = numOrNull("d-year-max"),
        eastMin = numOrNull("d-east-min"), eastMax = numOrNull("d-east-max"),
        northMin = numOrNull("d-north-min"), northMax = numOrNull("d-north-max");

  const col = (own, name) => def.embed ? `collars.${name}` : own;
  if (project && (def.projectCol || def.embed)) q = q.eq(col(def.projectCol, "project_name"), project);
  if (prospect && (def.prospectCol || def.embed)) q = q.eq(col(def.prospectCol, "prospect"), prospect);
  if (tenement && (def.tenementCol || def.embed)) q = q.eq(col(def.tenementCol, "tenement"), tenement);
  if (holeType && (def.holeTypeCol || def.embed)) q = q.eq(col(def.holeTypeCol, "hole_type"), holeType);
  if (yearMin != null && (def.yearCol || def.embed)) q = q.gte(col(def.yearCol, "year"), yearMin);
  if (yearMax != null && (def.yearCol || def.embed)) q = q.lte(col(def.yearCol, "year"), yearMax);
  if (eastMin != null && (def.coords || def.embed)) q = q.gte(col("mga2020_east", "mga2020_east"), eastMin);
  if (eastMax != null && (def.coords || def.embed)) q = q.lte(col("mga2020_east", "mga2020_east"), eastMax);
  if (northMin != null && (def.coords || def.embed)) q = q.gte(col("mga2020_north", "mga2020_north"), northMin);
  if (northMax != null && (def.coords || def.embed)) q = q.lte(col("mga2020_north", "mga2020_north"), northMax);
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
      const cls = isNum ? "num" : (/_id$|^hole_id$|tenement/.test(c) ? "mono" : "");
      const neg = isNum && v < 0 && /_ppm$|_pct$/.test(c);
      const shown = neg ? `<span class="below-dl">&lt;${Math.abs(v)}</span>` : String(v);
      cells.push(`<td class="${cls}">${shown}</td>`);
    }
    return "<tr>" + cells.join("") + "</tr>";
  }).join("");
}

/* ================= CSV / bundle export from Data view ================= */

async function exportCSV() {
  const table = $("table-select").value;
  const def = TABLE_DEFS[table];
  if (!totalRows) { alert("Nothing to export — apply filters first."); return; }
  const withRelated = $("export-related").checked && (def.embed || def.coords);

  if (withRelated) {
    // resolve the filtered set to hole_ids, then bundle everything for those holes
    showLoading("Finding matching holes\u2026");
    try {
      const rows = await fetchAll(() => buildQuery(def, table, { forExport: true }));
      const ids = [...new Set(rows.map((r) => r.hole_id).filter(Boolean))];
      if (!ids.length) throw new Error("no holes in the filtered set");
      await exportHoleBundle(ids, true, table);
    } catch (err) {
      alert("Export failed: " + (err.message || err));
      hideLoading();
    }
    return;
  }

  if (totalRows > 60000 && !confirm(`This will export ${totalRows.toLocaleString()} rows — it may take a minute. Continue?`)) return;
  showLoading(`Exporting ${totalRows.toLocaleString()} rows\u2026`);
  try {
    const rows = await fetchAll(() => buildQuery(def, table, { forExport: true }));
    if (!rows.length) throw new Error("no rows returned");
    const flat = rows.map((r) => {
      const { collars, ...rest } = r;
      return def.embed ? { project_name: collars?.project_name, prospect: collars?.prospect, ...rest } : rest;
    });
    downloadBlob(new Blob([toCSV(flat)], { type: "text/csv" }), `qmines_${table}_${dateStamp()}.csv`);
  } catch (err) {
    alert("Export failed: " + (err.message || err));
  } finally {
    hideLoading();
  }
}

/* ================= boot ================= */
renderLegend();
syncFilterVisibility();
init();
