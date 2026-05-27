// ============================================================
//  Moto-Cali — Análisis + Trazabilidad Vial
// ============================================================

const CALI  = [3.4516, -76.532];
const ZOOM  = 12;
const $     = id => document.getElementById(id);

// ── Map ──────────────────────────────────────────────────────
const map = L.map('map', { center: CALI, zoom: ZOOM });
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '© OpenStreetMap © CARTO', subdomains: 'abcd', maxZoom: 19,
}).addTo(map);

let heatLayer    = null;
let markersLayer = L.layerGroup().addTo(map);
let comunasLayer = null;

let allRecords = [], filteredRecords = [];
let comunasData = null, communeNames = [];
let showHeat = true, showMarkers = false, showComunas = true;
let selectedFile = null, pollingTimer = null;

// ── Severity config ───────────────────────────────────────────
const SEV_COLOR = {
  'Fallecido':   '#ef4444',
  'Lesionado':   '#f97316',
  'Solo daños':  '#eab308',
  'Negativo':    '#6b7280',
};

function sevColor(s) { return SEV_COLOR[s] || '#1e88e5'; }

// ── Toast ─────────────────────────────────────────────────────
function toast(msg, type = 'info', ms = 5000) {
  const el = $('toast');
  el.innerHTML = msg;
  el.className = `toast show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, ms);
}

// ── Loading ───────────────────────────────────────────────────
function setLoading(show, text = '', sub = '') {
  $('loading-overlay').classList.toggle('show', show);
  if (text) $('loading-text').textContent = text;
  if (sub)  $('loading-sub').textContent  = sub;
}

// ── Progress ──────────────────────────────────────────────────
function setProgress(pct, label, eta = '') {
  $('progress-container').style.display = 'block';
  $('progress-bar').style.width = `${Math.min(pct, 100)}%`;
  if (label) $('progress-label').textContent = label;
  $('progress-eta').textContent = eta;
}
function hideProgress() { $('progress-container').style.display = 'none'; }

// ── Tabs ──────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ── Comunas ───────────────────────────────────────────────────
async function loadComunas() {
  try {
    const d = await fetch('/comunas').then(r => r.json());
    if (!d.features?.length) return;
    comunasData  = d;
    communeNames = [];

    comunasLayer = L.geoJSON(d, {
      style: { color:'#1e88e5', weight:1.5, fillColor:'#1e3a5f', fillOpacity:.12, opacity:.7 },
      onEachFeature(f, layer) {
        const p    = f.properties || {};
        const name = p.NOMBRE_COMUNA || p.nombre_comuna || p.NOMBRE || p.nombre || p.COMUNA || 'Sin nombre';
        if (!communeNames.includes(name)) communeNames.push(name);
        layer.bindTooltip(name, { permanent:false, direction:'center' });
        layer.on('mouseover', function() { this.setStyle({ fillOpacity:.35, weight:2.5 }); });
        layer.on('mouseout',  function() { this.setStyle({ fillOpacity:.12, weight:1.5 }); });
      },
    });
    if (showComunas) comunasLayer.addTo(map);

    const sel = $('filter-comuna');
    communeNames.sort().forEach(n => {
      const o = document.createElement('option');
      o.value = n; o.textContent = n; sel.appendChild(o);
    });
  } catch(e) { console.warn('Comunas no disponibles', e); }
}

// ── Point-in-polygon ──────────────────────────────────────────
function getComuna(lat, lon) {
  if (!comunasData) return 'Sin asignar';
  const pt = [lon, lat];
  for (const f of comunasData.features) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map(p => p[0]);
    if (polys.some(vs => pip(pt, vs))) {
      const p = f.properties || {};
      return p.NOMBRE_COMUNA || p.nombre_comuna || p.NOMBRE || p.nombre || p.COMUNA || 'Sin nombre';
    }
  }
  return 'Sin asignar';
}

function pip([x, y], vs) {
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const [xi, yi] = vs[i], [xj, yj] = vs[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function assignComunas(recs) {
  return recs.map(r => ({ ...r, comuna: r.comuna || getComuna(r.lat, r.lon) }));
}

// ── Markers ───────────────────────────────────────────────────
function dotIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div style="width:9px;height:9px;background:${color};border:2px solid rgba(255,255,255,.6);border-radius:50%;box-shadow:0 0 5px ${color}"></div>`,
    iconSize: [9, 9], iconAnchor: [4, 4],
  });
}

function buildPopup(r) {
  const c = sevColor(r.severidad);
  return `<div class="acc-popup">
    <h4>Accidente de Moto</h4>
    <div class="popup-row"><span class="popup-label">Fecha:</span><span class="popup-value">${r.fecha||'N/D'}</span></div>
    <div class="popup-row"><span class="popup-label">Dirección:</span><span class="popup-value">${r.direccion||'N/D'}</span></div>
    <div class="popup-row"><span class="popup-label">Tipo:</span><span class="popup-value">${r.tipo||'N/D'}</span></div>
    <div class="popup-row"><span class="popup-label">Severidad:</span><span class="popup-value popup-sev ${r.severidad||''}" style="color:${c}">${r.severidad||'N/D'}</span></div>
    <div class="popup-row"><span class="popup-label">Vehículos:</span><span class="popup-value">${r.vehiculos||'N/D'}</span></div>
    <div class="popup-row"><span class="popup-label">Comuna:</span><span class="popup-value">${r.comuna||'Sin asignar'}</span></div>
  </div>`;
}

// ── Render ────────────────────────────────────────────────────
function renderData(recs) {
  // Heat
  if (heatLayer) map.removeLayer(heatLayer);
  heatLayer = L.heatLayer(recs.map(r => [r.lat, r.lon, 1]), {
    radius:22, blur:18, maxZoom:16,
    gradient:{0:'#00ccff',.3:'#00ff88',.6:'#ffaa00',.8:'#ff4400',1:'#ff0000'},
  });
  if (showHeat) heatLayer.addTo(map);

  // Markers (colored by severity)
  markersLayer.clearLayers();
  recs.forEach(r => {
    L.marker([r.lat, r.lon], { icon: dotIcon(sevColor(r.severidad)) })
     .bindPopup(buildPopup(r))
     .addTo(markersLayer);
  });
  if (!showMarkers) map.removeLayer(markersLayer);
  else markersLayer.addTo(map);

  $('no-data-msg').style.display = recs.length ? 'none' : 'block';

  if (recs.length) {
    const lats = recs.map(r=>r.lat), lons = recs.map(r=>r.lon);
    map.fitBounds([[Math.min(...lats),Math.min(...lons)],[Math.max(...lats),Math.max(...lons)]], {padding:[30,30]});
  }
}

// ── Dashboard ─────────────────────────────────────────────────
function updateDashboard(recs) {
  $('stat-total').textContent    = (allRecords.length||0).toLocaleString('es-CO');
  $('stat-geocoded').textContent = recs.length.toLocaleString('es-CO');
  $('record-count').textContent  = `${recs.length.toLocaleString('es-CO')} accidentes`;

  const fallecidos = recs.filter(r=>r.severidad==='Fallecido').length;
  const lesionados = recs.filter(r=>r.severidad==='Lesionado').length;
  $('stat-fallecidos').textContent = fallecidos.toLocaleString('es-CO');
  $('stat-lesionados').textContent = lesionados.toLocaleString('es-CO');

  // Tipo
  const tc = {};
  recs.forEach(r => { const t=r.tipo||'N/D'; tc[t]=(tc[t]||0)+1; });
  const tTop = Object.entries(tc).sort((a,b)=>b[1]-a[1])[0];
  $('stat-top-tipo').textContent = tTop ? `${tTop[0]} (${tTop[1].toLocaleString()})` : 'Sin datos';

  // Filter
  const tipoSel = $('filter-tipo');
  tipoSel.innerHTML = '<option value="">Todos los tipos</option>';
  Object.keys(tc).sort().forEach(t => {
    const o=document.createElement('option'); o.value=t; o.textContent=t; tipoSel.appendChild(o);
  });

  // Comunas
  const cc = {};
  recs.forEach(r => { const c=r.comuna||'Sin asignar'; cc[c]=(cc[c]||0)+1; });
  const sorted = Object.entries(cc).sort((a,b)=>b[1]-a[1]);
  $('stat-top-comuna').textContent = sorted[0] ? `${sorted[0][0]} (${sorted[0][1].toLocaleString()})` : 'Sin datos';
  updateTop5(sorted.slice(0,5));
}

function updateTop5(items) {
  const list = $('top5-list');
  if (!items.length) { list.innerHTML='<li class="top5-empty">Sin datos</li>'; return; }
  const max = items[0][1];
  const ranks = ['gold','silver','bronze','',''];
  list.innerHTML = items.map(([name,count],i) => `
    <li class="top5-item">
      <div class="top5-rank ${ranks[i]}">${i+1}</div>
      <div class="top5-bar-container">
        <div class="top5-name" title="${name}">${name}</div>
        <div class="top5-bar"><div class="top5-bar-fill" style="width:${Math.round(count/max*100)}%"></div></div>
      </div>
      <span class="top5-count">${count.toLocaleString()}</span>
    </li>`).join('');
}

// ── Filters ───────────────────────────────────────────────────
function applyFilters() {
  const df  = $('filter-date-from').value;
  const dt  = $('filter-date-to').value;
  const com = $('filter-comuna').value;
  const tip = $('filter-tipo').value;
  const sev = $('filter-severidad').value;

  filteredRecords = allRecords.filter(r => {
    if (df  && r.fecha    && r.fecha    < df)  return false;
    if (dt  && r.fecha    && r.fecha    > dt)  return false;
    if (com && r.comuna   !== com)             return false;
    if (tip && r.tipo     !== tip)             return false;
    if (sev && r.severidad !== sev)            return false;
    return true;
  });
  renderData(filteredRecords);
  updateDashboard(filteredRecords);
  toast(`Filtros aplicados: ${filteredRecords.length.toLocaleString('es-CO')} accidentes`, 'success');
}

function clearFilters() {
  ['filter-date-from','filter-date-to','filter-comuna','filter-tipo','filter-severidad']
    .forEach(id => { $(id).value = ''; });
  filteredRecords = [...allRecords];
  renderData(filteredRecords);
  updateDashboard(filteredRecords);
  toast('Filtros eliminados', 'info');
}

// ── Hotspots / Trazabilidad ───────────────────────────────────
let hotspotsData = [];

$('btn-load-hotspots').addEventListener('click', async () => {
  const container = $('hotspots-container');
  const btn       = $('btn-load-hotspots');
  btn.disabled    = true;
  btn.textContent = '⏳ Cargando...';
  container.innerHTML = '<div style="text-align:center;padding:20px"><div class="spinner small" style="margin:0 auto 8px"></div><p style="font-size:11px;color:var(--text-2)">Analizando puntos críticos...</p></div>';

  try {
    const resp = await fetch('/hotspots');
    const data = await resp.json();
    hotspotsData = data.hotspots || [];

    if (!hotspotsData.length) {
      container.innerHTML = '<p class="hotspots-empty">No hay datos aún. Carga un CSV primero.</p>';
      return;
    }

    container.innerHTML = `
      <div style="font-size:10px;color:var(--text-2);margin-bottom:10px">
        Top 15 puntos más peligrosos — haz clic en "Ver vía" para consultar el estado de la infraestructura en OSM
      </div>
      ${hotspotsData.map((h, i) => `
        <div class="hotspot-card" onclick="flyToHotspot(${h.lat},${h.lon})">
          <div class="hotspot-addr" title="${h.direccion}">${i+1}. ${h.direccion}</div>
          <div style="display:flex;align-items:baseline;gap:8px">
            <span class="hotspot-count">${h.count}</span>
            <span class="hotspot-label">accidentes</span>
          </div>
          <div class="hotspot-sevs">
            ${h.fallecidos ? `<span class="sev-pill dead">💀 ${h.fallecidos}</span>` : ''}
            ${h.lesionados ? `<span class="sev-pill hurt">🤕 ${h.lesionados}</span>` : ''}
            ${h.solo_danos ? `<span class="sev-pill damage">🔧 ${h.solo_danos}</span>` : ''}
          </div>
          <div class="hotspot-tipo">Tipo principal: ${h.top_tipo}</div>
          <button class="hotspot-road-btn" onclick="event.stopPropagation(); loadRoadQuality(${h.lat},${h.lon},'${h.direccion.replace(/'/g,"\\'")}')">
            🛣️ Ver estado de la vía (OSM)
          </button>
        </div>`).join('')}
    `;
    toast(`${hotspotsData.length} puntos críticos cargados`, 'success');

    // Switch to roads tab
    document.querySelector('[data-tab="roads"]').click();
  } catch(e) {
    container.innerHTML = `<p class="hotspots-empty">Error: ${e.message}</p>`;
    toast('Error cargando hotspots', 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = '📊 Recargar puntos críticos';
  }
});

function flyToHotspot(lat, lon) {
  map.flyTo([lat, lon], 17, { duration: 1.2 });
}

async function loadRoadQuality(lat, lon, addr) {
  const panel = $('road-panel');
  const body  = $('road-panel-body');
  $('road-panel-addr').textContent = addr;
  body.innerHTML = '<div style="text-align:center;padding:10px"><div class="spinner small" style="margin:0 auto 8px"></div></div>';
  panel.classList.add('open');

  try {
    const resp = await fetch(`/road_quality?lat=${lat}&lon=${lon}`);
    const data = await resp.json();
    const roads = data.roads || [];

    if (!roads.length) {
      body.innerHTML = `
        <div class="road-no-data">⚠️ No se encontraron datos viales en OSM para esta ubicación</div>
        <div class="road-analysis">
          <strong>Nota:</strong> OpenStreetMap puede no tener atributos detallados de esta vía.
          Esto no descarta problemas de infraestructura — simplemente no están registrados en la base colaborativa.
        </div>`;
      return;
    }

    const smQuality = (val) => {
      const bad = ['bad','very_bad','horrible','very_horrible','impassable','Mala','Muy mala','Horrible','Pésima','Impasable'];
      const ok  = ['intermediate','Intermedia'];
      if (bad.some(b => val.includes(b))) return 'bad';
      if (ok.some(o => val.includes(o)))  return 'ok';
      if (val === 'No registrada')         return '';
      return 'good';
    };

    body.innerHTML = roads.map(r => `
      <div class="road-card">
        <div class="road-name">🛣️ ${r.name || 'Vía sin nombre'}</div>
        <div class="road-attrs">
          <div class="road-attr-item">
            <div class="road-attr-key">Tipo de vía</div>
            <div class="road-attr-val">${r.highway}</div>
          </div>
          <div class="road-attr-item">
            <div class="road-attr-key">Superficie</div>
            <div class="road-attr-val ${r.surface === 'No registrada' ? '' : (r.surface.includes('Asfalt')||r.surface.includes('Concret')||r.surface.includes('Pavim') ? 'good' : 'ok')}">${r.surface}</div>
          </div>
          <div class="road-attr-item">
            <div class="road-attr-key">Estado (smoothness)</div>
            <div class="road-attr-val ${smQuality(r.smoothness)}">${r.smoothness}</div>
          </div>
          <div class="road-attr-item">
            <div class="road-attr-key">Velocidad máx.</div>
            <div class="road-attr-val">${r.maxspeed === 'No registrada' ? '—' : r.maxspeed + ' km/h'}</div>
          </div>
          <div class="road-attr-item">
            <div class="road-attr-key">Carriles</div>
            <div class="road-attr-val">${r.lanes}</div>
          </div>
          <div class="road-attr-item">
            <div class="road-attr-key">Iluminación</div>
            <div class="road-attr-val ${r.lit === 'Sí' ? 'good' : (r.lit === 'No' ? 'bad' : '')}">${r.lit}</div>
          </div>
          <div class="road-attr-item">
            <div class="road-attr-key">Sentido único</div>
            <div class="road-attr-val">${r.oneway}</div>
          </div>
        </div>
      </div>`).join('') + `
      <div class="road-analysis">
        <strong>¿Hay trazabilidad?</strong> Los datos de OSM permiten correlacionar el tipo de vía y superficie con la 
        frecuencia de accidentes. Para un análisis completo de estado de vías se recomienda cruzar con el 
        <strong>IDU Cali</strong> o el inventario vial del <strong>DAPM</strong>, ya que OSM puede estar 
        desactualizado en zonas periféricas.
      </div>`;

    flyToHotspot(lat, lon);
  } catch(e) {
    body.innerHTML = `<div class="road-no-data">Error consultando OSM: ${e.message}</div>`;
  }
}

$('road-panel-close').addEventListener('click', () => {
  $('road-panel').classList.remove('open');
});

// ── Layer toggles ─────────────────────────────────────────────
$('btn-heat').addEventListener('click', function() {
  showHeat = !showHeat; this.classList.toggle('active', showHeat);
  if (showHeat && heatLayer) heatLayer.addTo(map); else if (heatLayer) map.removeLayer(heatLayer);
});
$('btn-markers').addEventListener('click', function() {
  showMarkers = !showMarkers; this.classList.toggle('active', showMarkers);
  if (showMarkers) markersLayer.addTo(map); else map.removeLayer(markersLayer);
});
$('btn-comunas').addEventListener('click', function() {
  showComunas = !showComunas; this.classList.toggle('active', showComunas);
  if (comunasLayer) { if (showComunas) comunasLayer.addTo(map); else map.removeLayer(comunasLayer); }
});
$('btn-center').addEventListener('click', () => map.setView(CALI, ZOOM));
$('btn-apply-filter').addEventListener('click', applyFilters);
$('btn-clear-filter').addEventListener('click', clearFilters);

// ── Upload UI ─────────────────────────────────────────────────
const uploadZone = $('upload-zone');
const fileInput  = $('file-input');
const btnUpload  = $('btn-upload');

uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault(); uploadZone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f?.name.endsWith('.csv')) { selectedFile = f; $('upload-label').textContent = `📄 ${f.name}`; btnUpload.disabled = false; }
  else toast('Solo se aceptan archivos CSV', 'error');
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) { selectedFile = fileInput.files[0]; $('upload-label').textContent = `📄 ${selectedFile.name}`; btnUpload.disabled = false; }
});

btnUpload.addEventListener('click', async () => {
  if (!selectedFile) return;
  setLoading(true, 'Leyendo CSV...', 'Filtrando registros de motos...');
  setProgress(3, 'Subiendo archivo...');
  btnUpload.disabled = true;

  const form = new FormData();
  form.append('file', selectedFile);

  try {
    const resp = await fetch('/upload', { method:'POST', body:form });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'Error procesando el archivo');
    setLoading(false);
    $('stat-total').textContent = data.total_filtered.toLocaleString('es-CO');
    setProgress(2, `${data.total_filtered.toLocaleString()} registros de motos — geocodificando con Nominatim...`);
    toast(`📂 ${data.total_filtered.toLocaleString('es-CO')} registros — geocodificando en segundo plano`, 'info', 6000);
    startPolling(data.total_filtered);
    document.querySelector('[data-tab="stats"]').click();
  } catch(err) {
    setLoading(false); hideProgress();
    toast(`❌ ${err.message}`, 'error', 7000);
    btnUpload.disabled = false;
  }
});

// ── Polling ───────────────────────────────────────────────────
let _startTime  = null;
let _lastRecs   = 0;
let _dataFetch  = false;  // prevent overlapping /data fetches

function startPolling(totalFiltered) {
  stopPolling();
  _startTime = Date.now();
  _lastRecs  = 0;

  pollingTimer = setInterval(async () => {
    try {
      const s     = await fetch('/status').then(r => r.json());
      const done  = s.geocoded_unique  || 0;
      const total = s.total_unique     || 1;
      const recs  = s.geocoded_records || 0;
      const pct   = Math.round(done / total * 100);

      // ETA
      let eta = '';
      const elapsed = (Date.now() - _startTime) / 1000;
      if (done > 0 && elapsed > 5) {
        const rate = done / elapsed;
        const rem  = (total - done) / rate;
        eta = rem > 60 ? `~${Math.round(rem/60)} min restantes` : `~${Math.round(rem)} seg restantes`;
      }

      if (s.state === 'geocoding' || s.state === 'starting') {
        setProgress(pct,
          `Geocodificando con Nominatim: ${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`,
          eta);

        // Fetch new records from result.json when count increases
        if (recs > _lastRecs && !_dataFetch) {
          _dataFetch = true;
          _lastRecs  = recs;
          fetch('/data').then(r => r.json()).then(d => {
            if (d.records?.length) {
              allRecords      = assignComunas(d.records);
              filteredRecords = [...allRecords];
              renderData(filteredRecords);
              updateDashboard(filteredRecords);
              $('stat-total').textContent = (totalFiltered||0).toLocaleString('es-CO');
            }
          }).catch(()=>{}).finally(() => { _dataFetch = false; });
        }

      } else if (s.state === 'done') {
        stopPolling(); hideProgress();
        const d = await fetch('/data').then(r => r.json());
        if (d.records?.length) {
          allRecords      = assignComunas(d.records);
          filteredRecords = [...allRecords];
          renderData(filteredRecords);
          updateDashboard(filteredRecords);
          $('stat-total').textContent = (totalFiltered||0).toLocaleString('es-CO');
        }
        toast(`✅ Completado: ${(s.geocoded_records||0).toLocaleString('es-CO')} ubicaciones geocodificadas`, 'success', 8000);
        btnUpload.disabled = false;

      } else if (s.state === 'idle' || s.state === 'interrupted') {
        stopPolling(); hideProgress(); btnUpload.disabled = false;
      }
    } catch(e) { /* keep polling */ }
  }, 4000);
}

function stopPolling() { if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; } }

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  await loadComunas();
  try {
    const [s, dataResp] = await Promise.all([
      fetch('/status').then(r => r.json()),
      fetch('/data').then(r => r.json()).catch(() => ({ records: [] })),
    ]);

    // Always load any existing result.json data first (shows map immediately)
    if (dataResp.records?.length) {
      allRecords      = assignComunas(dataResp.records);
      filteredRecords = [...allRecords];
      renderData(filteredRecords);
      updateDashboard(filteredRecords);
      $('no-data-msg').style.display = 'none';
      document.querySelector('[data-tab="stats"]').click();
    }

    if (s.state === 'geocoding' || s.state === 'starting') {
      // Active geocoding — resume polling
      const total = s.total_rows || 0;
      toast('🔄 Geocodificación Nominatim en curso — retomando...', 'info', 5000);
      const pct = s.total_unique ? Math.round((s.geocoded_unique||0) / s.total_unique * 100) : 0;
      setProgress(pct, `Geocodificando: ${(s.geocoded_unique||0).toLocaleString()} / ${(s.total_unique||0).toLocaleString()} (${pct}%)`);
      startPolling(total);

    } else if (s.state === 'interrupted') {
      // Server restarted mid-geocoding — show what we have and allow re-upload
      if (dataResp.records?.length) {
        const done   = s.geocoded_unique  || 0;
        const total  = s.total_unique     || done;
        const pct    = total ? Math.round(done / total * 100) : 100;
        toast(
          `⚠️ Geocodificación interrumpida (${pct}% completado). ` +
          `Mostrando ${dataResp.records.length.toLocaleString('es-CO')} accidentes geocodificados. ` +
          `Vuelve a subir el CSV para continuar.`,
          'info', 12000
        );
      } else {
        toast('⚠️ Geocodificación interrumpida. Sube el CSV para comenzar de nuevo.', 'info', 8000);
      }

    } else if (s.state === 'done' && dataResp.records?.length) {
      $('stat-total').textContent = (s.total_rows || dataResp.records.length).toLocaleString('es-CO');
      toast(`✅ ${dataResp.records.length.toLocaleString('es-CO')} accidentes cargados`, 'success');
    }
  } catch(e) { /* no previous data */ }
})();
