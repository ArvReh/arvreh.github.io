
// XCO Sector Analyzer MVP
const SECTOR_COLORS = [
  "#388bfd", "#2ecc71", "#e74c3c", "#f39c12", "#9b59b6",
  "#1abc9c", "#e67e22", "#00bcd4", "#e91e63", "#34495e",
  "#8e44ad", "#27ae60", "#d35400", "#16a085", "#f1c40f"
];

let state = {
  records: [],
  laps: [],
  refLapIndex: 0,
  refLapRecords: [],
  lapLength: 0,
  splitDistances: [],
  sectorNames: {},
  map: null,
  trackLayers: [],
  markerLayers: [],
  canvas: null
};

document.addEventListener("DOMContentLoaded", () => {
  initDropzone();
  initCanvas();
  
  const btnDemo = document.getElementById("btnDemo");
  if (btnDemo) btnDemo.addEventListener("click", loadDemo);
  
  const btnReset = document.getElementById("btnReset");
  if (btnReset) btnReset.addEventListener("click", resetAll);
});

function initDropzone() {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const fileInput2 = document.getElementById("fileInput2");

  if (dropzone) {
    dropzone.addEventListener("click", () => {
      if (fileInput2) fileInput2.click();
    });
  }

  if (fileInput) {
    fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));
  }
  if (fileInput2) {
    fileInput2.addEventListener("change", (e) => handleFile(e.target.files[0]));
  }

  if (dropzone) {
    ["dragenter", "dragover"].forEach(evt => {
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.add("dragover");
      });
    });

    ["dragleave", "drop"].forEach(evt => {
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
      });
    });

    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      if (e.dataTransfer && e.dataTransfer.files.length) {
        handleFile(e.dataTransfer.files[0]);
      }
    });
  }
}

function handleFile(file) {
  if (!file) return;
  showLoading(true);
  if (file.name.toLowerCase().endsWith(".json")) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        loadFromParsedData(data.records, data.laps);
      } catch (err) {
        alert("Felaktig JSON-fil: " + err.message);
        showLoading(false);
      }
    };
    reader.readAsText(file);
    return;
  }

  parseFitBlob(file);
}

function showLoading(show) {
  const dz = document.getElementById("dropzone");
  const ld = document.getElementById("loading");
  if (show) {
    if (dz) dz.classList.add("hidden");
    if (ld) ld.classList.remove("hidden");
  } else {
    if (dz) dz.classList.remove("hidden");
    if (ld) ld.classList.add("hidden");
  }
}

async function parseFitBlob(blob) {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    
    if (typeof GarminFitSDK === "undefined" || !GarminFitSDK.Decoder) {
      throw new Error("Garmin FIT SDK saknas i webbläsaren.");
    }

    const { Decoder, Stream } = GarminFitSDK;
    const stream = Stream.fromArrayBuffer(arrayBuffer);
    const decoder = new Decoder(stream);
    const { messages, errors } = decoder.read();

    if (errors && errors.length > 0) {
      console.warn("FIT parsing warnings:", errors);
    }

    if (!messages.recordMesgs || messages.recordMesgs.length === 0) {
      alert("Inga träningspunkter (records) hittades i FIT-filen.");
      showLoading(false);
      return;
    }

    processFitMessages(messages);
  } catch (err) {
    console.error("Fel vid avkodning av FIT:", err);
    alert("Kunde inte avkoda FIT-filen: " + err.message);
    showLoading(false);
  }
}

function semicirclesToDegrees(sc) {
  return sc * (180 / 2147483648);
}

function processFitMessages(messages) {
  const records = [];
  
  messages.recordMesgs.forEach(m => {
    if (m.positionLat != null && m.positionLong != null) {
      records.push({
        lat: semicirclesToDegrees(m.positionLat),
        lng: semicirclesToDegrees(m.positionLong),
        distance: m.distance != null ? m.distance : 0,
        altitude: m.enhancedAltitude != null ? m.enhancedAltitude : (m.altitude != null ? m.altitude : 0),
        speed: m.enhancedSpeed != null ? m.enhancedSpeed * 3.6 : (m.speed != null ? m.speed * 3.6 : 0),
        watts: m.power != null ? m.power : 0,
        heartRate: m.heartRate != null ? m.heartRate : 0,
        cadence: m.cadence != null ? m.cadence : 0,
        time: m.timestamp ? new Date(m.timestamp) : null
      });
    }
  });

  if (records.length === 0) {
    alert("FIT-filen saknar giltig GPS-data.");
    showLoading(false);
    return;
  }

  const rawLaps = (messages.lapMesgs || []).map((l, i) => ({
    lapNum: i + 1,
    duration: Math.round(l.totalTimerTime || 0),
    distance: Math.round(l.totalDistance || 0),
    avgWatts: Math.round(l.avgPower || 0),
    avgHr: Math.round(l.avgHeartRate || 0),
    trigger: l.lapTrigger || ""
  }));

  loadFromParsedData(records, rawLaps);
}

function loadFromParsedData(records, rawLaps) {
  state.records = records;
  extractLaps(rawLaps);
  setReferenceLap();

  document.getElementById("uploadArea").classList.add("hidden");
  document.getElementById("analysisArea").classList.remove("hidden");
  showLoading(false);

  // Set default sectors if not already set (e.g. 4 sectors)
  if (state.splitDistances.length === 0) {
    const L = state.lapLength;
    if (L > 1000) {
      state.splitDistances = [
        Math.round(L * 0.25),
        Math.round(L * 0.50),
        Math.round(L * 0.75)
      ];
    }
  }

  renderMeta();
  setTimeout(() => {
    initMap();
    drawElevProfile();
    renderSectors();
    renderTable();
  }, 50);
}

function extractLaps(rawLaps) {
  state.laps = [];

  if (rawLaps && rawLaps.length >= 2) {
    let recIdx = 0;
    rawLaps.forEach((l, idx) => {
      const lapDist = l.distance || 0;
      const startDist = state.records[recIdx].distance;
      const targetEndDist = startDist + lapDist;
      
      let endIdx = recIdx;
      while (endIdx < state.records.length - 1 && state.records[endIdx].distance < targetEndDist) {
        endIdx++;
      }

      // Filter out small master/start loops (<500m) from laps table unless very few laps
      if (lapDist > 500 || rawLaps.length <= 3) {
        state.laps.push({
          lapNum: state.laps.length + 1,
          startIndex: recIdx,
          endIndex: endIdx,
          duration: l.duration,
          distance: lapDist,
          avgWatts: l.avgWatts,
          avgHr: l.avgHr
        });
      }
      recIdx = endIdx;
    });
  }

  // Fallback to auto-detection if no laps found
  if (state.laps.length <= 1) {
    autodetectLaps();
  }
}

function autodetectLaps() {
  state.laps = [];
  const recs = state.records;
  const finish = recs[recs.length - 1];
  
  const mPerDegLat = 111139.0;
  const mPerDegLng = 111139.0 * Math.cos(finish.lat * Math.PI / 180);

  const crossings = [];
  for (let i = 10; i < recs.length - 10; i++) {
    const dy = (recs[i].lat - finish.lat) * mPerDegLat;
    const dx = (recs[i].lng - finish.lng) * mPerDegLng;
    const dist = Math.hypot(dx, dy);

    if (dist < 40) {
      if (crossings.length === 0 || (recs[i].distance - recs[crossings[crossings.length - 1]].distance > 1500)) {
        crossings.push(i);
      }
    }
  }

  if (crossings.length >= 2) {
    for (let c = 0; c < crossings.length - 1; c++) {
      const sIdx = crossings[c];
      const eIdx = crossings[c+1];
      const d = recs[eIdx].distance - recs[sIdx].distance;
      const t = eIdx - sIdx;
      
      const lapSlice = recs.slice(sIdx, eIdx);
      const wSum = lapSlice.reduce((acc, r) => acc + r.watts, 0);
      const hrSum = lapSlice.reduce((acc, r) => acc + r.heartRate, 0);

      state.laps.push({
        lapNum: c + 1,
        startIndex: sIdx,
        endIndex: eIdx,
        duration: t,
        distance: Math.round(d),
        avgWatts: Math.round(wSum / lapSlice.length),
        avgHr: Math.round(hrSum / lapSlice.length)
      });
    }
  }
}

function setReferenceLap() {
  if (state.laps.length === 0) {
    state.refLapRecords = state.records;
    state.lapLength = Math.round(state.records[state.records.length - 1].distance);
    return;
  }

  let refLap = state.laps[0];
  if (state.laps.length >= 2 && state.laps[1].distance > 1000) {
    refLap = state.laps[1];
  }

  const s = refLap.startIndex;
  const e = refLap.endIndex;
  const slice = state.records.slice(s, e);
  const startDist = slice[0].distance;

  state.refLapRecords = slice.map(r => ({
    ...r,
    relDist: r.distance - startDist
  }));

  state.lapLength = Math.round(state.refLapRecords[state.refLapRecords.length - 1].relDist);
}

function renderMeta() {
  const meta = document.getElementById("metaBar");
  const totDist = (state.records[state.records.length - 1].distance / 1000).toFixed(2);
  const totLaps = state.laps.length;
  const avgW = Math.round(state.records.reduce((a, r) => a + r.watts, 0) / state.records.length);
  const avgHr = Math.round(state.records.reduce((a, r) => a + r.heartRate, 0) / state.records.length);

  meta.innerHTML = `
    <div class="meta-item"><span class="meta-label">Total Distans</span><span class="meta-val">${totDist} km</span></div>
    <div class="meta-item"><span class="meta-label">Identifierade Varv</span><span class="meta-val">${totLaps} st</span></div>
    <div class="meta-item"><span class="meta-label">Varvlängd</span><span class="meta-val">${state.lapLength} m</span></div>
    <div class="meta-item"><span class="meta-label">Snitteffekt</span><span class="meta-val">${avgW} W</span></div>
    <div class="meta-item"><span class="meta-label">Snittpuls</span><span class="meta-val">${avgHr} bpm</span></div>
  `;
}

function initMap() {
  const mapContainer = document.getElementById('map');
  if (!mapContainer) return;

  if (state.map) {
    state.map.remove();
    state.map = null;
  }

  const latlngs = state.refLapRecords.map(r => [r.lat, r.lng]);
  state.map = L.map('map').setView(latlngs[0], 15);

  /*L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(state.map);*/

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19,
  attribution: 'Tiles &copy; Esri'
  }).addTo(state.map);


  state.map.fitBounds(L.polyline(latlngs).getBounds(), { padding: [30, 30] });

  // Start / Finish marker
  L.marker(latlngs[0]).addTo(state.map).bindPopup(`<b>Start / Mål</b><br>0 m / ${state.lapLength} m`);

  state.map.on('click', (e) => {
    const nearest = findNearestRecord(e.latlng.lat, e.latlng.lng);
    if (nearest && nearest.relDist > 100 && nearest.relDist < state.lapLength - 100) {
      addSplit(nearest.relDist);
    }
  });

  drawMapSectors();
}

function findNearestRecord(lat, lng) {
  let best = null;
  let minDist = Infinity;
  for (let i = 0; i < state.refLapRecords.length; i++) {
    const r = state.refLapRecords[i];
    const d = Math.hypot(r.lat - lat, r.lng - lng);
    if (d < minDist) {
      minDist = d;
      best = r;
    }
  }
  return best;
}

function findNearestByDist(dist) {
  let best = state.refLapRecords[0];
  let minDiff = Infinity;
  for (let i = 0; i < state.refLapRecords.length; i++) {
    const diff = Math.abs(state.refLapRecords[i].relDist - dist);
    if (diff < minDiff) {
      minDiff = diff;
      best = state.refLapRecords[i];
    }
  }
  return best;
}

function addSplit(dist) {
  if (state.splitDistances.some(d => Math.abs(d - dist) < 50)) return;
  state.splitDistances.push(dist);
  state.splitDistances.sort((a, b) => a - b);
  updateAll();
}

function removeSplit(idx) {
  state.splitDistances.splice(idx, 1);
  updateAll();
}

function updateAll() {
  drawMapSectors();
  drawElevProfile();
  renderSectors();
  renderTable();
}

function getSectorBoundaries() {
  return [0, ...state.splitDistances, state.lapLength];
}

function drawMapSectors() {
  if (!state.map) return;
  state.trackLayers.forEach(l => state.map.removeLayer(l));
  state.markerLayers.forEach(m => state.map.removeLayer(m));
  state.trackLayers = [];
  state.markerLayers = [];

  const bounds = getSectorBoundaries();

  for (let i = 0; i < bounds.length - 1; i++) {
    const dStart = bounds[i];
    const dEnd = bounds[i+1];
    const color = SECTOR_COLORS[i % SECTOR_COLORS.length];

    const slice = state.refLapRecords.filter(r => r.relDist >= dStart && r.relDist <= dEnd);
    if (slice.length > 1) {
      const line = L.polyline(slice.map(r => [r.lat, r.lng]), {
        color: color,
        weight: 6,
        opacity: 0.95
      }).addTo(state.map);

      line.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        const nearest = findNearestRecord(e.latlng.lat, e.latlng.lng);
        if (nearest) addSplit(nearest.relDist);
      });

      state.trackLayers.push(line);
    }
  }

  // Draw split markers
  state.splitDistances.forEach((dist, idx) => {
    const pt = findNearestByDist(dist);
    const marker = L.circleMarker([pt.lat, pt.lng], {
      radius: 8,
      color: '#fff',
      fillColor: '#f85149',
      fillOpacity: 1,
      weight: 2
    }).addTo(state.map);

    marker.bindTooltip(`Brytpunkt: ${dist}m<br><i>Klicka för att ta bort</i>`, { direction: 'top' });
    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      removeSplit(idx);
    });

    state.markerLayers.push(marker);
  });
}

function renderSectors() {
  const container = document.getElementById("sectorNames");
  if (!container) return;
  container.innerHTML = "";
  const bounds = getSectorBoundaries();

  for (let i = 0; i < bounds.length - 1; i++) {
    const sStart = bounds[i];
    const sEnd = bounds[i+1];
    const color = SECTOR_COLORS[i % SECTOR_COLORS.length];
    const defaultName = `Sektor ${i+1}`;
    const curName = state.sectorNames[i] || defaultName;

    const chip = document.createElement("div");
    chip.className = "sector-chip";
    chip.innerHTML = `
      <span class="sector-color-dot" style="background:${color}"></span>
      <input type="text" value="${curName}" placeholder="${defaultName}">
      <span class="chip-dist">${sStart}–${sEnd}m (${sEnd - sStart}m)</span>
      ${i < state.splitDistances.length ? `<button class="btn-chip-del" title="Ta bort brytpunkt">×</button>` : ''}
    `;

    const input = chip.querySelector("input");
    input.addEventListener("input", (e) => {
      state.sectorNames[i] = e.target.value;
      renderTable();
    });

    const delBtn = chip.querySelector(".btn-chip-del");
    if (delBtn) {
      delBtn.addEventListener("click", () => removeSplit(i));
    }

    container.appendChild(chip);
  }
}

function initCanvas() {
  state.canvas = document.getElementById("elevCanvas");
  if (!state.canvas) return;

  state.canvas.addEventListener("click", (e) => {
    const rect = state.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = x / rect.width;
    const clickDist = Math.round(ratio * state.lapLength);
    addSplit(clickDist);
  });

  window.addEventListener("resize", () => {
    drawElevProfile();
  });
}

function drawElevProfile() {
  const canvas = state.canvas;
  if (!canvas || !canvas.parentElement) return;

  const ctx = canvas.getContext("2d");
  const w = canvas.width = canvas.parentElement.clientWidth - 34;
  const h = canvas.height = 140;

  ctx.clearRect(0, 0, w, h);

  const recs = state.refLapRecords;
  if (!recs || recs.length === 0) return;

  const minAlt = Math.min(...recs.map(r => r.altitude)) - 2;
  const maxAlt = Math.max(...recs.map(r => r.altitude)) + 4;
  const altRange = maxAlt - minAlt || 1;

  const bounds = getSectorBoundaries();

  for (let i = 0; i < bounds.length - 1; i++) {
    const dStart = bounds[i];
    const dEnd = bounds[i+1];
    const color = SECTOR_COLORS[i % SECTOR_COLORS.length];

    const slice = recs.filter(r => r.relDist >= dStart && r.relDist <= dEnd);
    if (slice.length < 2) continue;

    ctx.beginPath();
    slice.forEach((r, idx) => {
      const x = (r.relDist / state.lapLength) * w;
      const y = h - ((r.altitude - minAlt) / altRange) * (h - 24) - 12;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    const firstX = (slice[0].relDist / state.lapLength) * w;
    const lastX = (slice[slice.length - 1].relDist / state.lapLength) * w;
    ctx.lineTo(lastX, h);
    ctx.lineTo(firstX, h);
    ctx.closePath();

    ctx.fillStyle = color + "33";
    ctx.fill();

    ctx.beginPath();
    slice.forEach((r, idx) => {
      const x = (r.relDist / state.lapLength) * w;
      const y = h - ((r.altitude - minAlt) / altRange) * (h - 24) - 12;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.8;
    ctx.stroke();
  }

  // Draw split marker lines
  state.splitDistances.forEach(dist => {
    const x = (dist / state.lapLength) * w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.strokeStyle = "#ffffff";
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.setLineDash([]);
  });
}

function renderTable() {
  const thead = document.querySelector("#resultTable thead");
  const tbody = document.querySelector("#resultTable tbody");
  if (!thead || !tbody) return;

  thead.innerHTML = "";
  tbody.innerHTML = "";

  const bounds = getSectorBoundaries();
  const laps = state.laps.length > 0 ? state.laps : [{ lapNum: 1, startIndex: 0, endIndex: state.records.length - 1 }];

  let headerHtml = "<tr><th>Sektor & Sträcka</th><th>Längd</th>";
  laps.forEach(l => {
    headerHtml += `<th>Varv ${l.lapNum}<br><small>(Tid | W | HR)</small></th>`;
  });
  headerHtml += "</tr>";
  thead.innerHTML = headerHtml;

  for (let i = 0; i < bounds.length - 1; i++) {
    const dStart = bounds[i];
    const dEnd = bounds[i+1];
    const sLen = dEnd - dStart;
    const sName = state.sectorNames[i] || `Sektor ${i+1}`;
    const color = SECTOR_COLORS[i % SECTOR_COLORS.length];

    let rowHtml = `<tr>
      <td><span class="sector-color-dot" style="background:${color}; display:inline-block; margin-right:6px;"></span><b>${sName}</b> <small style="color:#8b949e">(${dStart}–${dEnd}m)</small></td>
      <td>${sLen} m</td>`;

    laps.forEach(l => {
      const lapSlice = state.records.slice(l.startIndex, l.endIndex);
      const lStartDist = lapSlice[0].distance;
      const secSlice = lapSlice.filter(r => {
        const rel = r.distance - lStartDist;
        return rel >= dStart && rel < dEnd;
      });

      if (secSlice.length > 0) {
        const secTime = secSlice.length;
        const wAvg = Math.round(secSlice.reduce((a, r) => a + r.watts, 0) / secSlice.length);
        const hrAvg = Math.round(secSlice.reduce((a, r) => a + r.heartRate, 0) / secSlice.length);
        
        const m = Math.floor(secTime / 60);
        const s = secTime % 60;
        const timeStr = `${m}:${s.toString().padStart(2, '0')}`;

        rowHtml += `<td>${timeStr} | ${wAvg}W | ${hrAvg} bpm</td>`;
      } else {
        rowHtml += `<td>–</td>`;
      }
    });

    rowHtml += "</tr>";
    tbody.innerHTML += rowHtml;
  }

  // Total lap row
  let totalHtml = `<tr class="total-row"><td>TOTALT VARV</td><td>${state.lapLength} m</td>`;
  laps.forEach(l => {
    const lapSlice = state.records.slice(l.startIndex, l.endIndex);
    const t = lapSlice.length;
    const wAvg = Math.round(lapSlice.reduce((a, r) => a + r.watts, 0) / lapSlice.length);
    const hrAvg = Math.round(lapSlice.reduce((a, r) => a + r.heartRate, 0) / lapSlice.length);
    const m = Math.floor(t / 60);
    const s = t % 60;
    totalHtml += `<td>${m}:${s.toString().padStart(2, '0')} | ${wAvg}W | ${hrAvg} bpm</td>`;
  });
  totalHtml += "</tr>";
  tbody.innerHTML += totalHtml;
}

function resetAll() {
  state.splitDistances = [];
  state.sectorNames = {};
  document.getElementById("analysisArea").classList.add("hidden");
  document.getElementById("uploadArea").classList.remove("hidden");
  showLoading(false);
}
