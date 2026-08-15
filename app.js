/* Crosswind — runway wind component calculator.
   Offline-first PWA. Not for navigation. */
'use strict';

const VERSION = '1.0.1';
const $ = (id) => document.getElementById(id);
const KT_PER_KMH = 0.539957;
const HPA_PER_INHG = 33.8638866667;

/* ------------------------------------------------------------------ state */
const S = {
  db: null,          // parsed airports.json
  apts: [],          // array of airport objects
  byId: new Map(),
  stations: [],      // airports that have a METAR station id
  apt: null,         // selected airport
  sel: null,         // selected runway end key
  mode: 'metar',     // 'metar' | 'manual'
  manualRef: 'mag',  // 'mag' | 'true'
  wx: null,          // {dirTrue|null, vrb, spd, gst, tempC, dewC, altimHpa, raw, station, dist, time, stale, source}
  timer: null,
};

const PREFS = {
  xwLimit: 15, twLimit: 10, gustLimit: false, autoRefresh: false,
  theme: 'auto', last: null, recents: [], favs: [],
};

function loadPrefs() {
  try { Object.assign(PREFS, JSON.parse(localStorage.getItem('xw.prefs') || '{}')); } catch (e) {}
}
function savePrefs() {
  try { localStorage.setItem('xw.prefs', JSON.stringify(PREFS)); } catch (e) {}
}

/* ------------------------------------------------------------------ math */
const rad = (d) => d * Math.PI / 180;
const norm360 = (d) => ((d % 360) + 360) % 360;
const round1 = (n) => Math.round(n * 10) / 10;

/** Signed difference b - a, folded to (-180, 180]. */
function angDelta(a, b) {
  let d = norm360(b - a);
  if (d > 180) d -= 360;
  return d;
}

/** Wind components for one runway end.
 *  windDirMag: direction the wind is coming FROM, magnetic degrees.
 *  Returns head (+ = headwind, - = tailwind) and cross (+ = from the right). */
function components(rwyHdgMag, windDirMag, speed) {
  const off = rad(angDelta(rwyHdgMag, windDirMag));
  return { head: speed * Math.cos(off), cross: speed * Math.sin(off), offDeg: angDelta(rwyHdgMag, windDirMag) };
}

/** Magnetic heading of a runway end given the low end's magnetic heading. */
function endHeading(leMag, isHighEnd) { return norm360(isHighEnd ? leMag + 180 : leMag); }

/** True wind direction -> magnetic, using declination (East positive). */
function trueToMag(dirTrue, decl) { return norm360(dirTrue - decl); }
function magToTrue(dirMag, decl) { return norm360(dirMag + decl); }

/** Declination at the field, drifted from the data epoch to now. */
function declNow(apt) {
  const now = new Date();
  const yr = now.getUTCFullYear() + (now - Date.UTC(now.getUTCFullYear())) / (365.25 * 864e5);
  return apt.decl + apt.drate * (yr - S.db.epochYear);
}

function pressureAlt(elevFt, altimHpa) {
  if (altimHpa == null || elevFt == null) return null;
  return elevFt + (29.9213 - altimHpa / HPA_PER_INHG) * 1000;
}
function densityAlt(pa, oatC) {
  if (pa == null || oatC == null) return null;
  return pa + 118.8 * (oatC - isaTemp(pa));
}
function isaTemp(pa) { return 15 - 1.98 * (pa / 1000); }

/* ------------------------------------------------------------------ data */
async function loadDb() {
  const res = await fetch('data/airports.json', { cache: 'force-cache' });
  if (!res.ok) throw new Error('airport database failed to load (' + res.status + ')');
  const db = await res.json();
  S.db = db;
  S.apts = db.a.map((r, idx) => ({
    idx, id: r[0], icao: r[1], station: r[2], name: r[3], city: r[4], state: r[5],
    lat: r[6], lon: r[7], elev: r[8], decl: r[9], drate: r[10],
    rw: r[11].map((x) => ({
      le: x[0], he: x[1], leMag: x[2], len: x[3], wid: x[4],
      surf: db.surf[x[5]] || 'Unknown', lit: !!x[6], precise: !!x[7],
    })),
    hay: (r[0] + ' ' + r[1] + ' ' + r[3] + ' ' + r[4] + ' ' + r[5]).toLowerCase(),
  }));
  for (const a of S.apts) {
    S.byId.set(a.id.toUpperCase(), a);
    if (a.icao) S.byId.set(a.icao.toUpperCase(), a);
    if (a.station) S.stations.push(a);
  }
  $('dataGen').textContent = 'Data snapshot ' + db.gen + '.';
}

function findApt(q) {
  const k = (q || '').trim().toUpperCase();
  if (!k) return null;
  return S.byId.get(k) || S.byId.get('K' + k) || null;
}

function search(q, limit = 40) {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const exact = [], pre = [], sub = [];
  for (const a of S.apts) {
    const id = a.id.toLowerCase(), ic = a.icao.toLowerCase();
    if (id === t || ic === t) exact.push(a);
    else if (id.startsWith(t) || ic.startsWith(t)) pre.push(a);
    else if (a.hay.includes(t)) sub.push(a);
    if (exact.length + pre.length > limit && t.length < 3) break;
  }
  const byRwy = (x, y) => y.rw.length - x.rw.length || (y.rw[0].len - x.rw[0].len);
  pre.sort(byRwy); sub.sort(byRwy);
  return exact.concat(pre, sub).slice(0, limit);
}

function distNm(a, b) {
  const R = 3440.065;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Nearest reporting stations to an airport, own station first. */
function nearbyStations(apt, n = 4) {
  const out = [];
  if (apt.station) out.push({ id: apt.station, dist: 0 });
  const cands = S.stations
    .filter((a) => a.station && a.station !== apt.station)
    .map((a) => ({ id: a.station, dist: distNm(apt, a) }))
    .filter((c) => c.dist < 60)
    .sort((x, y) => x.dist - y.dist)
    .slice(0, n);
  return out.concat(cands);
}

/* ------------------------------------------------------------------ METAR */
function parseMetar(raw) {
  if (!raw) return null;
  const txt = raw.trim().toUpperCase();
  const o = { raw: txt };
  const w = txt.match(/\b(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)\b/);
  if (w) {
    o.vrb = w[1] === 'VRB';
    o.dirTrue = o.vrb ? null : parseInt(w[1], 10);
    let sp = parseInt(w[2], 10), gs = w[3] ? parseInt(w[3], 10) : null;
    if (w[4] === 'MPS') { sp *= 1.94384; if (gs) gs *= 1.94384; }
    if (w[4] === 'KMH') { sp *= KT_PER_KMH; if (gs) gs *= KT_PER_KMH; }
    o.spd = Math.round(sp);
    o.gst = gs ? Math.round(gs) : null;
  }
  const v = txt.match(/\b(\d{3})V(\d{3})\b/);
  if (v) o.varRange = [parseInt(v[1], 10), parseInt(v[2], 10)];
  const t = txt.match(/\s(M?\d{2})\/(M?\d{2})\s/);
  if (t) {
    o.tempC = parseInt(t[1].replace('M', '-'), 10);
    o.dewC = parseInt(t[2].replace('M', '-'), 10);
  }
  const a = txt.match(/\bA(\d{4})\b/);
  if (a) o.altimHpa = (parseInt(a[1], 10) / 100) * HPA_PER_INHG;
  else {
    const q = txt.match(/\bQ(\d{4})\b/);
    if (q) o.altimHpa = parseInt(q[1], 10);
  }
  const d = txt.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
  if (d) {
    const now = new Date();
    const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(),
      +d[1], +d[2], +d[3]));
    if (dt - now > 6 * 3600e3) dt.setUTCMonth(dt.getUTCMonth() - 1);
    o.time = dt.getTime();
  }
  const st = txt.match(/^(?:METAR |SPECI )?([A-Z][A-Z0-9]{3})\s/);
  if (st) o.station = st[1];
  return o.spd != null ? o : null;
}

async function fetchAwc(ids) {
  const url = 'https://aviationweather.gov/api/data/metar?format=json&hours=3&ids=' +
    encodeURIComponent(ids.join(','));
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('AWC ' + r.status);
  const j = await r.json();
  if (!Array.isArray(j) || !j.length) return [];
  const best = new Map();
  for (const m of j) {
    const id = (m.icaoId || m.stationId || '').toUpperCase();
    const t = (m.obsTime ? m.obsTime * 1000 : Date.parse(m.reportTime + 'Z')) || 0;
    if (!best.has(id) || t > best.get(id).time) {
      best.set(id, {
        station: id, time: t, raw: m.rawOb || '',
        vrb: m.wdir === 'VRB' || m.wdir === null && m.wspd != null,
        dirTrue: typeof m.wdir === 'number' ? m.wdir : null,
        spd: m.wspd != null ? m.wspd : null,
        gst: m.wgst != null ? m.wgst : null,
        tempC: m.temp != null ? m.temp : null,
        dewC: m.dewp != null ? m.dewp : null,
        altimHpa: m.altim != null ? m.altim : null,
        source: 'Aviation Weather Center',
      });
    }
  }
  return [...best.values()].filter((m) => m.spd != null || m.raw);
}

async function fetchNws(id) {
  const r = await fetch('https://api.weather.gov/stations/' + encodeURIComponent(id) +
    '/observations/latest?require_qc=false', { cache: 'no-store', headers: { Accept: 'application/geo+json' } });
  if (!r.ok) throw new Error('NWS ' + r.status);
  const p = (await r.json()).properties || {};
  const kt = (v) => (v == null ? null : Math.round(v * KT_PER_KMH));
  const out = {
    station: id.toUpperCase(), time: Date.parse(p.timestamp) || Date.now(),
    raw: p.rawMessage || '',
    dirTrue: p.windDirection && p.windDirection.value != null ? p.windDirection.value : null,
    vrb: false,
    spd: kt(p.windSpeed && p.windSpeed.value),
    gst: kt(p.windGust && p.windGust.value),
    tempC: p.temperature && p.temperature.value != null ? p.temperature.value : null,
    dewC: p.dewpoint && p.dewpoint.value != null ? p.dewpoint.value : null,
    altimHpa: p.barometricPressure && p.barometricPressure.value != null
      ? p.barometricPressure.value / 100 : null,
    source: 'NWS api.weather.gov',
  };
  if (out.spd == null && out.raw) {
    const pm = parseMetar(out.raw);
    if (pm) Object.assign(out, pm, { source: out.source + ' (raw)', station: out.station });
  }
  return out.spd != null ? out : null;
}

function cacheKey(id) { return 'xw.wx.' + id; }
function cacheWx(m) {
  try { localStorage.setItem(cacheKey(m.station), JSON.stringify(m)); } catch (e) {}
}
function cachedWx(ids) {
  let best = null;
  for (const id of ids) {
    try {
      const v = JSON.parse(localStorage.getItem(cacheKey(id)) || 'null');
      if (v && (!best || v.time > best.time)) best = v;
    } catch (e) {}
  }
  return best;
}

async function refreshWx(silent) {
  const apt = S.apt;
  if (!apt) return;
  const cands = nearbyStations(apt);
  if (!cands.length) {
    S.wx = null;
    setStatus('No reporting station within 60 nm. Enter the wind manually.', true);
    render();
    return;
  }
  const distOf = (id) => {
    const c = cands.find((x) => x.id === id);
    return c ? c.dist : null;
  };
  if (!silent) setStatus('Fetching…');
  let got = null, err = null;
  try {
    const list = await fetchAwc(cands.map((c) => c.id));
    if (list.length) {
      list.sort((a, b) => (distOf(a.station) ?? 999) - (distOf(b.station) ?? 999) || b.time - a.time);
      got = list[0];
    }
  } catch (e) { err = e; }
  if (!got) {
    for (const c of cands.slice(0, 2)) {
      try { const m = await fetchNws(c.id); if (m) { got = m; break; } } catch (e) { err = err || e; }
    }
  }
  if (got) {
    if ((got.spd == null || got.altimHpa == null) && got.raw) {
      const pm = parseMetar(got.raw);
      if (pm) for (const k of ['dirTrue', 'vrb', 'spd', 'gst', 'tempC', 'dewC', 'altimHpa', 'varRange']) {
        if (got[k] == null && pm[k] != null) got[k] = pm[k];
      }
    }
    got.dist = distOf(got.station);
    got.stale = false;
    cacheWx(got);
    S.wx = got;
  } else {
    const c = cachedWx(cands.map((x) => x.id));
    if (c) { c.stale = true; c.dist = distOf(c.station); S.wx = c; }
    else S.wx = null;
    if (!S.wx) setStatus(navigator.onLine
      ? 'Could not reach a weather server. Switch to Manual and enter the wind.'
      : 'Offline and no saved report. Switch to Manual and enter the wind.', true);
  }
  render();
}

function setStatus(msg, warn) {
  const el = $('metarStatus');
  el.textContent = msg;
  el.style.color = warn ? 'var(--tail)' : '';
}

function ageStr(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (!isFinite(m)) return '';
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  return h + ' h ' + (m % 60) + ' min ago';
}

/* ------------------------------------------------------------- wind model */
/** The wind actually used for the calculation, in MAGNETIC degrees. */
function currentWind() {
  const apt = S.apt;
  if (!apt) return null;
  const decl = declNow(apt);
  if (S.mode === 'manual') {
    const spd = parseFloat($('mSpd').value);
    if (!isFinite(spd)) return null;
    const gst = parseFloat($('mGst').value);
    const vrb = $('mVrb').checked;
    let dir = parseFloat($('mDir').value);
    if (vrb || !isFinite(dir)) {
      return { vrb: true, spd, gst: isFinite(gst) ? gst : null, decl, src: 'manual' };
    }
    dir = norm360(dir);
    const dirMag = S.manualRef === 'true' ? trueToMag(dir, decl) : dir;
    return { vrb: false, dirMag, dirTrue: S.manualRef === 'true' ? dir : magToTrue(dir, decl),
      spd, gst: isFinite(gst) && gst > spd ? gst : null, decl, src: 'manual' };
  }
  const w = S.wx;
  if (!w || w.spd == null) return null;
  if (w.vrb || w.dirTrue == null) {
    return { vrb: true, spd: w.spd, gst: w.gst, decl, src: 'metar' };
  }
  return {
    vrb: false, dirTrue: w.dirTrue, dirMag: trueToMag(w.dirTrue, decl),
    spd: w.spd, gst: w.gst && w.gst > w.spd ? w.gst : null, decl, src: 'metar',
  };
}

/** Every runway end with its computed components, best first. */
function runwayTable(wind) {
  const rows = [];
  for (const r of S.apt.rw) {
    for (const hi of [0, 1]) {
      const hdg = endHeading(r.leMag, hi);
      const row = {
        key: (hi ? r.he : r.le) + '/' + r.le,
        id: hi ? r.he : r.le, opp: hi ? r.le : r.he,
        hdg, len: r.len, wid: r.wid, surf: r.surf, lit: r.lit, precise: r.precise, rw: r,
      };
      if (wind && !wind.vrb) {
        const c = components(hdg, wind.dirMag, wind.spd);
        row.head = c.head; row.cross = c.cross; row.off = c.offDeg;
        if (wind.gst) {
          const g = components(hdg, wind.dirMag, wind.gst);
          row.gHead = g.head; row.gCross = g.cross;
        }
      }
      rows.push(row);
    }
  }
  if (wind && !wind.vrb) {
    // Ties inside half a knot are not real differences — fall through to the
    // longer runway rather than splitting hairs between parallels.
    const tol = (x, y) => (Math.abs(x - y) < 0.5 ? 0 : y - x);
    rows.sort((a, b) =>
      tol(a.head, b.head) ||
      tol(Math.abs(b.cross), Math.abs(a.cross)) ||
      b.len - a.len ||
      a.id.localeCompare(b.id));
  } else {
    rows.sort((a, b) => b.len - a.len || a.id.localeCompare(b.id));
  }
  return rows;
}

function limitFor(row, wind) {
  const x = PREFS.gustLimit && row.gCross != null ? Math.abs(row.gCross) : Math.abs(row.cross || 0);
  if (PREFS.xwLimit > 0 && x > PREFS.xwLimit) return 'over';
  if (PREFS.xwLimit > 0 && x > PREFS.xwLimit * 0.8) return 'near';
  return 'ok';
}

/* ------------------------------------------------------------------ views */
function render() {
  const apt = S.apt;
  if (!apt) return;
  $('main').hidden = false;
  $('boot').hidden = true;

  $('aptId').textContent = apt.id + (apt.icao && apt.icao !== apt.id ? ' · ' + apt.icao : '');
  $('aptName').textContent = apt.name;
  const decl = declNow(apt);
  $('aptMeta').textContent =
    [apt.city, apt.state].filter(Boolean).join(', ') +
    ' · Field elev ' + fmtFt(apt.elev) +
    ' · Var ' + Math.abs(decl).toFixed(1) + '° ' + (decl < 0 ? 'W' : 'E') +
    ' · ' + apt.rw.length + ' runway' + (apt.rw.length === 1 ? '' : 's');
  $('favBtn').textContent = PREFS.favs.includes(apt.id) ? '★' : '☆';
  $('favBtn').classList.toggle('on', PREFS.favs.includes(apt.id));

  renderMetarPane();

  const wind = currentWind();
  const rows = runwayTable(wind);
  // The diagram follows the best runway unless the pilot has picked one.
  if (!S.selManual || !rows.some((r) => r.key === S.sel)) S.sel = rows[0] ? rows[0].key : null;
  const sel = rows.find((r) => r.key === S.sel) || rows[0];

  renderBest(rows, wind);
  renderTable(rows, wind);
  renderDiagram(sel, wind);
  renderPerf();
  renderRecents();
}

function renderMetarPane() {
  $('metarPane').hidden = S.mode !== 'metar';
  $('manualPane').hidden = S.mode !== 'manual';
  $('tabMetar').classList.toggle('active', S.mode === 'metar');
  $('tabManual').classList.toggle('active', S.mode === 'manual');
  if (S.mode !== 'metar') return;
  const w = S.wx;
  if (!w) return;
  const bits = [];
  bits.push(w.station + (w.dist > 0.5 ? ' (' + w.dist.toFixed(0) + ' nm away)' : ''));
  bits.push(ageStr(w.time));
  if (w.stale) bits.push('⚠ saved copy — not current');
  bits.push(w.source);
  setStatus(bits.join(' · '), !!w.stale);
  $('metarRaw').hidden = !w.raw;
  $('metarRaw').textContent = w.raw || '';
}

function renderBest(rows, wind) {
  const card = $('bestCard');
  card.hidden = false;
  card.classList.remove('caution', 'danger');
  $('bestWarn').hidden = true;
  $('bestGustWrap').hidden = true;

  if (!wind) {
    $('bestRwy').textContent = '—';
    $('bestHead').textContent = $('bestCross').textContent = '—';
    $('bestCrossLbl').textContent = 'Crosswind';
    showWarn('No wind yet. Fetch a METAR or enter the wind manually.', 'caution');
    return;
  }
  if (wind.vrb) {
    const longest = rows[0];
    $('bestRwy').textContent = 'RWY ' + longest.id;
    $('bestHead').textContent = '—'; $('bestCross').textContent = '—';
    showWarn('Wind reported variable at ' + Math.round(wind.spd) + ' kt' +
      (wind.gst ? ' gusting ' + Math.round(wind.gst) : '') +
      '. Components cannot be computed — treat any runway as a possible ' +
      Math.round(wind.gst || wind.spd) + ' kt crosswind.', 'caution');
    return;
  }
  if (wind.spd < 3) {
    const longest = [...rows].sort((a, b) => b.len - a.len)[0];
    $('bestRwy').textContent = 'RWY ' + longest.id;
    $('bestHead').textContent = '0'; $('bestCross').textContent = '0';
    $('bestCrossLbl').textContent = 'Crosswind';
    showWarn('Wind calm (' + Math.round(wind.spd) + ' kt). Longest runway shown; ' +
      'use the calm-wind runway or local procedure.', 'caution');
    return;
  }

  const b = rows[0];
  $('bestRwy').textContent = 'RWY ' + b.id;
  $('bestHead').textContent = fmtHead(b.head);
  $('bestCross').textContent = Math.abs(b.cross).toFixed(0);
  $('bestCrossLbl').textContent = 'Crosswind from ' + (b.cross >= 0 ? 'right' : 'left');
  if (b.gCross != null) {
    $('bestGustWrap').hidden = false;
    $('bestGust').textContent = Math.abs(b.gCross).toFixed(0);
  }

  const msgs = [];
  let level = null;
  const xw = PREFS.gustLimit && b.gCross != null ? Math.abs(b.gCross) : Math.abs(b.cross);
  if (PREFS.xwLimit > 0 && xw > PREFS.xwLimit) {
    msgs.push('Crosswind ' + xw.toFixed(0) + ' kt exceeds your ' + PREFS.xwLimit + ' kt limit on every runway here.');
    level = 'danger';
  } else if (b.gCross != null && PREFS.xwLimit > 0 && Math.abs(b.gCross) > PREFS.xwLimit) {
    msgs.push('Gust crosswind ' + Math.abs(b.gCross).toFixed(0) + ' kt exceeds your ' + PREFS.xwLimit + ' kt limit.');
    level = level || 'caution';
  }
  if (b.head < 0) {
    msgs.push('Best available option still has a ' + Math.abs(b.head).toFixed(0) + ' kt tailwind.');
    level = 'danger';
  } else if (PREFS.twLimit > 0 && b.head < 0) {
    level = level || 'caution';
  }
  if (b.head >= 0 && Math.abs(b.cross) > Math.abs(b.head)) {
    msgs.push('Crosswind exceeds headwind — wind is more than 45° off the runway.');
    level = level || 'caution';
  }
  if (msgs.length) { showWarn(msgs.join(' '), level); card.classList.add(level); }
}

function showWarn(text, level) {
  const el = $('bestWarn');
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle('caution', level === 'caution');
}

function renderTable(rows, wind) {
  const tb = $('rwyTable').querySelector('tbody');
  const showAll = $('showAll').checked;
  tb.textContent = '';
  for (const r of rows) {
    if (!showAll && r.head != null && r.head < 0) continue;
    const tr = document.createElement('tr');
    if (r.key === S.sel) tr.className = 'sel';
    tr.onclick = () => { S.sel = r.key; S.selManual = true; render(); };
    const lim = wind && !wind.vrb ? limitFor(r, wind) : 'ok';
    const cells = [
      ['<span class="rw-id">' + r.id + '</span>' +
        (r === rows[0] && wind && !wind.vrb ? '<span class="badge best-badge">BEST</span>' : '') +
        (r.lit ? '<span class="badge">LIT</span>' : ''), ''],
      [r.hdg.toFixed(0).padStart(3, '0') + '°' + (r.precise ? '' : '<span class="badge" title="Derived from the painted runway number">±5</span>'), ''],
      [r.head == null ? '—' : fmtHead(r.head),
        'num ' + (r.head == null || Math.abs(r.head) < 0.5 ? '' : r.head < 0 ? 'v-tail' : 'v-head')],
      [r.cross == null ? '—' : Math.abs(r.cross).toFixed(0) + (r.cross >= 0 ? ' R' : ' L'),
        'num ' + (lim === 'over' ? 'v-over' : lim === 'near' ? 'v-near' : '')],
      [r.gCross == null ? '—' : Math.abs(r.gCross).toFixed(0) + (r.gCross >= 0 ? ' R' : ' L'),
        'num ' + (r.gCross == null || !PREFS.xwLimit ? ''
          : Math.abs(r.gCross) > PREFS.xwLimit ? 'v-over'
          : Math.abs(r.gCross) > PREFS.xwLimit * 0.8 ? 'v-near' : '')],
      [r.len ? r.len.toLocaleString() + '′' : '—', ''],
      [r.surf, ''],
    ];
    for (const [html, cls] of cells) {
      const td = document.createElement('td');
      td.className = cls;
      td.innerHTML = html;
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
}

function renderPerf() {
  const apt = S.apt;
  const w = S.mode === 'metar' ? S.wx : S.pasted;
  $('daElev').textContent = fmtFt(apt.elev);
  const altim = w && w.altimHpa != null ? w.altimHpa : null;
  const oat = w && w.tempC != null ? w.tempC : null;
  const pa = pressureAlt(apt.elev, altim);
  const da = densityAlt(pa, oat);
  $('daPA').textContent = pa == null ? '—' : fmtFt(Math.round(pa));
  $('daDA').textContent = da == null ? '—' : fmtFt(Math.round(da));
  $('daTemp').textContent = oat == null ? '—' :
    oat.toFixed(0) + '° / ' + (w.dewC == null ? '—' : w.dewC.toFixed(0) + '°') + ' C';
  $('daAlt').textContent = altim == null ? '—' : (altim / HPA_PER_INHG).toFixed(2) + '″';
  $('daISA').textContent = (pa == null || oat == null) ? '—' :
    (oat - isaTemp(pa) >= 0 ? '+' : '−') + Math.abs(oat - isaTemp(pa)).toFixed(0) + '° C';
  $('daNote').textContent = altim == null
    ? 'Needs an altimeter setting and temperature — fetch a METAR.'
    : 'Standard approximations: PA = elev + (29.92 − altimeter) × 1000; DA = PA + 118.8 × (OAT − ISA). Dry-air estimate.';
}

/** Headwind for display: no "-0", explicit minus for a real tailwind. */
function fmtHead(v) {
  if (Math.abs(v) < 0.5) return '0';
  return (v < 0 ? '−' : '') + Math.abs(v).toFixed(0);
}

function fmtFt(n) {
  return n == null || n < -9000 ? '—' : Math.round(n).toLocaleString() + ' ft';
}

function renderRecents() {
  const ids = [...new Set(PREFS.favs.concat(PREFS.recents))].slice(0, 24);
  $('recentCard').hidden = !ids.length;
  const box = $('recentList');
  box.textContent = '';
  for (const id of ids) {
    const a = findApt(id);
    if (!a) continue;
    const b = document.createElement('button');
    b.className = 'chip';
    b.innerHTML = (PREFS.favs.includes(id) ? '<span class="st">★</span>' : '') + a.id;
    b.title = a.name;
    b.onclick = () => selectApt(a);
    box.appendChild(b);
  }
}

/* ---------------------------------------------------------------- diagram */
function renderDiagram(row, wind) {
  const W = 420, H = 420, cx = W / 2, cy = H / 2, R = 132;
  const p = [];
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  p.push(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Runway ${row ? row.id : ''} wind diagram">`);
  // One marker per colour: Safari does not support fill="context-stroke".
  const MARKERS = { wind: 'var(--wind)', head: 'var(--head)', tail: 'var(--tail)',
    cross: 'var(--cross)', muted: 'var(--muted)' };
  p.push('<defs>' + Object.keys(MARKERS).map((k) =>
    `<marker id="ah-${k}" viewBox="0 0 12 7" refX="11.5" refY="3.5" markerWidth="5" markerHeight="2.9"
       orient="auto-start-reverse"><path d="M0,0 L12,3.5 L0,7 z" fill="${MARKERS[k]}"/></marker>`
  ).join('') + '</defs>');

  // scale ring
  p.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="var(--line)" stroke-width="1"/>`);
  p.push(`<circle cx="${cx}" cy="${cy}" r="${R * 0.5}" fill="none" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 5"/>`);

  if (!row) { p.push('</svg>'); $('diagram').innerHTML = p.join(''); return; }

  // ---- runway, landing direction UP ----
  const halfLen = 116, halfW = 30;
  p.push(`<g>
    <rect x="${cx - halfW}" y="${cy - halfLen}" width="${halfW * 2}" height="${halfLen * 2}" rx="3"
          fill="var(--rwy)" stroke="var(--rwy-edge)" stroke-width="1.5"/>
    <line x1="${cx}" y1="${cy - halfLen + 46}" x2="${cx}" y2="${cy + halfLen - 62}"
          stroke="var(--rwy-edge)" stroke-width="2.5" stroke-dasharray="14 12" opacity=".8"/>`);
  for (const sgn of [1, -1]) {
    const y = cy + sgn * (halfLen - 11);
    for (let i = -3; i <= 3; i++) {
      if (i === 0) continue;
      p.push(`<rect x="${cx + i * 7 - 1.7}" y="${y - 9}" width="3.4" height="18" fill="var(--rwy-edge)" opacity=".85"/>`);
    }
  }
  // approach-end designator (readable), far-end designator small and muted
  p.push(`<text x="${cx}" y="${cy + halfLen - 30}" text-anchor="middle" fill="var(--fg)"
        font-size="30" font-weight="750" letter-spacing="1">${esc(row.id)}</text>`);
  p.push(`<text x="${cx}" y="${cy - halfLen + 40}" text-anchor="middle" fill="var(--muted)"
        font-size="16" font-weight="600" opacity=".7">${esc(row.opp)}</text>`);
  p.push(`</g>`);

  // aeroplane on the runway, pointing up
  p.push(`<g transform="translate(${cx} ${cy + 22})" opacity=".9">
    <path d="M0,-16 L3,-6 L18,3 L18,7 L3,3 L2.5,12 L8,16 L8,19 L0,17 L-8,19 L-8,16 L-2.5,12 L-3,3 L-18,7 L-18,3 L-3,-6 Z"
      fill="var(--fg)" opacity=".5"/></g>`);

  // ---- magnetic north indicator ----
  const nAng = -row.hdg; // magnetic north relative to screen-up
  p.push(`<text x="${W - 42}" y="18" text-anchor="middle" fill="var(--muted)" font-size="11"
    font-weight="700" letter-spacing=".5">MAG N</text>`);
  p.push(`<g transform="translate(${W - 42} 42) rotate(${nAng})">
    <line x1="0" y1="15" x2="0" y2="-15" stroke="var(--muted)" stroke-width="2" marker-end="url(#ah-muted)"/>
    </g>`);

  if (!wind || wind.vrb || wind.spd < 1) {
    p.push(`<text x="${cx}" y="${H - 12}" text-anchor="middle" fill="var(--muted)" font-size="13">${
      wind && wind.vrb ? 'Wind variable — no component solution' : 'No wind entered'}</text>`);
    p.push('</svg>');
    $('diagram').innerHTML = p.join('');
    $('legend').innerHTML = '';
    return;
  }

  // ---- wind vectors ----
  const peak = Math.max(wind.spd, wind.gst || 0);
  const pxPerKt = R / Math.max(peak, 1);
  const a = rad(angDelta(row.hdg, wind.dirMag)); // 0 = straight down the runway from ahead
  const ux = Math.sin(a), uy = -Math.cos(a);     // unit vector toward the wind's source
  const len = wind.spd * pxPerKt;
  const tx = cx + ux * len, ty = cy + uy * len;  // tail of the wind vector

  // gust vector (dashed, drawn behind)
  if (wind.gst) {
    const gl = wind.gst * pxPerKt;
    const gx = cx + ux * gl, gy = cy + uy * gl;
    p.push(`<line x1="${gx}" y1="${gy}" x2="${cx}" y2="${cy}"
      stroke="var(--wind)" stroke-width="2.5" stroke-dasharray="6 5" opacity=".45"/>`);
    p.push(`<line x1="${gx - uy * 7}" y1="${gy + ux * 7}" x2="${gx + uy * 7}" y2="${gy - ux * 7}"
      stroke="var(--wind)" stroke-width="2.5" opacity=".6"/>`);
  }

  // component legs: from the tail, along the runway axis, then across to the centre
  const headLen = wind.spd * Math.cos(a) * pxPerKt;   // + = headwind
  const crossLen = wind.spd * Math.sin(a) * pxPerKt;  // + = from the right
  const jx = tx, jy = ty + headLen;                   // corner of the right triangle

  const head = wind.spd * Math.cos(a), cross = wind.spd * Math.sin(a);
  const headCol = head < 0 ? 'var(--tail)' : 'var(--head)';

  // total wind vector (solid), then the two legs of the right triangle
  p.push(`<line x1="${tx}" y1="${ty}" x2="${cx}" y2="${cy}" stroke="var(--wind)" stroke-width="3"
    opacity=".9" marker-end="url(#ah-wind)"/>`);
  if (Math.abs(headLen) > 3) {
    p.push(`<line x1="${tx}" y1="${ty}" x2="${jx}" y2="${jy}" stroke="${headCol}" stroke-width="4.5"
      stroke-linecap="round" marker-end="url(#ah-${head < 0 ? 'tail' : 'head'})" opacity=".95"/>`);
  }
  if (Math.abs(crossLen) > 3) {
    p.push(`<line x1="${jx}" y1="${jy}" x2="${cx}" y2="${cy}" stroke="var(--cross)" stroke-width="4.5"
      stroke-linecap="round" marker-end="url(#ah-cross)" opacity=".95"/>`);
  }
  p.push(`<circle cx="${tx}" cy="${ty}" r="4.5" fill="var(--wind)"/>`);

  // ---- labels, placed on the outside of the triangle and clamped to the box ----
  const clampX = (x) => Math.max(46, Math.min(W - 46, x));
  const clampY = (y) => Math.max(20, Math.min(H - 26, y));
  const lbl = (x, y, txt, color, anchor) =>
    `<text x="${clampX(x)}" y="${clampY(y)}" text-anchor="${anchor || 'middle'}" fill="${color}"
      font-size="14.5" font-weight="750" paint-order="stroke" stroke="var(--panel)" stroke-width="4.5"
      stroke-linejoin="round">${esc(txt)}</text>`;

  // head leg is vertical at x = tx; the third vertex C sits at cx = tx - crossLen,
  // so the outside of the triangle is on the +crossLen side.
  const headOut = crossLen >= 0 ? 1 : -1;
  if (Math.abs(headLen) > 3) {
    p.push(lbl(tx + headOut * 11, (ty + jy) / 2 + 5,
      (head < 0 ? 'TAIL ' : 'HEAD ') + Math.abs(head).toFixed(0), headCol,
      headOut > 0 ? 'start' : 'end'));
  }
  // cross leg is horizontal at y = jy; T is at jy - headLen, so outside is the -headLen side.
  if (Math.abs(crossLen) > 3) {
    p.push(lbl((jx + cx) / 2, jy + (headLen >= 0 ? 20 : -11),
      'X-WIND ' + Math.abs(cross).toFixed(0) + (cross >= 0 ? ' R' : ' L'), 'var(--cross)'));
  }
  // wind origin label, pushed further outward along the wind vector
  p.push(lbl(tx + ux * 26, ty + uy * 26 + (uy < 0 ? -2 : 12),
    Math.round(wind.dirMag).toString().padStart(3, '0') + '°M ' + Math.round(wind.spd) +
    (wind.gst ? 'G' + Math.round(wind.gst) : '') + ' kt', 'var(--wind)',
    ux > 0.35 ? 'start' : ux < -0.35 ? 'end' : 'middle'));

  p.push(`<text x="${cx}" y="${H - 8}" text-anchor="middle" fill="var(--muted)" font-size="12"
    >Wind ${Math.abs(row.off).toFixed(0)}° off the ${esc(row.id)} centreline${
      Math.abs(row.off) < 1 ? '' : (row.off > 0 ? ', from the right' : ', from the left')}</text>`);
  p.push('</svg>');
  $('diagram').innerHTML = p.join('');

  $('legend').innerHTML =
    '<span><i style="background:var(--wind)"></i>Total wind</span>' +
    '<span><i style="background:var(--head)"></i>' + (head < 0 ? 'Tailwind' : 'Headwind') + ' component</span>' +
    '<span><i style="background:var(--cross)"></i>Crosswind component</span>' +
    '<span>Arrows point the way the air is moving. Runway ' + row.id + ' points up.</span>';
}

/* ------------------------------------------------------------------- glue */
function selectApt(apt) {
  if (!apt) return;
  S.apt = apt;
  S.sel = null;
  S.selManual = false;
  S.wx = null;
  S.pasted = null;
  // Never carry one field's wind over to another — that is how you land downwind.
  for (const id of ['mDir', 'mSpd', 'mGst', 'pasteBox']) if ($(id)) $(id).value = '';
  if ($('mVrb')) $('mVrb').checked = false;
  if ($('pasteMsg')) $('pasteMsg').textContent = '';
  S.manualRef = 'mag';
  if ($('refMag')) syncRef();
  PREFS.last = apt.id;
  PREFS.recents = [apt.id].concat(PREFS.recents.filter((x) => x !== apt.id)).slice(0, 12);
  savePrefs();
  $('search').value = '';
  $('results').hidden = true;
  setStatus('—');
  $('metarRaw').hidden = true;
  render();
  if (S.mode === 'metar') refreshWx();
}

function wireSearch() {
  const box = $('search'), list = $('results');
  let items = [], cur = -1;
  const close = () => { list.hidden = true; cur = -1; };
  const draw = () => {
    list.textContent = '';
    items.forEach((a, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === cur);
      li.innerHTML = '<span class="rid">' + a.id + '</span><span class="rnm">' +
        a.name.replace(/[<>&]/g, '') + (a.city ? ' — ' + a.city.replace(/[<>&]/g, '') : '') +
        (a.state ? ', ' + a.state : '') + '</span>';
      li.onmousedown = (e) => { e.preventDefault(); selectApt(a); };
      list.appendChild(li);
    });
    list.hidden = !items.length;
  };
  box.addEventListener('input', () => { items = search(box.value); cur = items.length ? 0 : -1; draw(); });
  box.addEventListener('focus', () => { if (box.value) { items = search(box.value); draw(); } });
  box.addEventListener('blur', () => setTimeout(close, 120));
  box.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { cur = Math.min(cur + 1, items.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { cur = Math.max(cur - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (items[cur]) { selectApt(items[cur]); e.preventDefault(); } }
    else if (e.key === 'Escape') close();
  });
}

function applyTheme() {
  const t = PREFS.theme === 'auto'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'day' : 'night')
    : PREFS.theme;
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')
    .setAttribute('content', t === 'day' ? '#f2f4f7' : '#0d1117');
}

function wireUI() {
  $('tabMetar').onclick = () => { S.mode = 'metar'; render(); if (!S.wx) refreshWx(); };
  $('tabManual').onclick = () => { S.mode = 'manual'; render(); $('mDir').focus(); };
  $('refreshBtn').onclick = () => refreshWx();
  $('showAll').onchange = render;
  for (const id of ['mDir', 'mSpd', 'mGst']) $(id).addEventListener('input', render);
  $('mVrb').onchange = render;
  $('refMag').onclick = () => { S.manualRef = 'mag'; syncRef(); render(); };
  $('refTrue').onclick = () => { S.manualRef = 'true'; syncRef(); render(); };
  $('pasteBtn').onclick = () => {
    const m = parseMetar($('pasteBox').value);
    if (!m) { $('pasteMsg').textContent = 'No wind group found in that text.'; return; }
    $('mDir').value = m.vrb ? '' : m.dirTrue;
    $('mSpd').value = m.spd;
    $('mGst').value = m.gst == null ? '' : m.gst;
    $('mVrb').checked = !!m.vrb;
    S.manualRef = 'true';           // coded METAR winds are true north
    S.pasted = m;
    $('pasteMsg').textContent = 'Loaded' + (m.station ? ' ' + m.station : '') + '.';
    syncRef(); render();
  };

  $('favBtn').onclick = () => {
    const id = S.apt.id;
    PREFS.favs = PREFS.favs.includes(id) ? PREFS.favs.filter((x) => x !== id) : [id].concat(PREFS.favs);
    savePrefs(); render();
  };
  $('themeBtn').onclick = () => {
    PREFS.theme = PREFS.theme === 'day' ? 'night' : PREFS.theme === 'night' ? 'auto' : 'day';
    savePrefs(); applyTheme();
  };

  const dlg = $('setDlg');
  $('setBtn').onclick = () => {
    $('setXw').value = PREFS.xwLimit;
    $('setTw').value = PREFS.twLimit;
    $('setGustLimit').checked = PREFS.gustLimit;
    $('setAutoRefresh').checked = PREFS.autoRefresh;
    $('verLine').textContent = 'Crosswind v' + VERSION + ' · data ' + (S.db ? S.db.gen : '');
    dlg.showModal();
  };
  dlg.addEventListener('close', () => {
    PREFS.xwLimit = clampNum($('setXw').value, 0, 60, 15);
    PREFS.twLimit = clampNum($('setTw').value, 0, 30, 10);
    PREFS.gustLimit = $('setGustLimit').checked;
    PREFS.autoRefresh = $('setAutoRefresh').checked;
    savePrefs(); setAutoRefresh(); render();
  });
  $('clearCache').onclick = () => {
    Object.keys(localStorage).filter((k) => k.startsWith('xw.')).forEach((k) => localStorage.removeItem(k));
    location.reload();
  };
  addEventListener('online', () => { if (S.mode === 'metar') refreshWx(true); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.mode === 'metar' && S.wx && Date.now() - S.wx.time > 15 * 60000) refreshWx(true);
  });
  syncRef();
}

function syncRef() {
  $('refMag').classList.toggle('active', S.manualRef === 'mag');
  $('refTrue').classList.toggle('active', S.manualRef === 'true');
  $('refHint').textContent = S.manualRef === 'mag'
    ? 'ATIS, tower and AWOS voice winds are magnetic — use this.'
    : 'Coded METAR and forecast winds are true north — converted using the field variation.';
}

function clampNum(v, lo, hi, dflt) {
  const n = parseFloat(v);
  return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

function setAutoRefresh() {
  clearInterval(S.timer);
  if (PREFS.autoRefresh) S.timer = setInterval(() => { if (S.mode === 'metar') refreshWx(true); }, 300000);
}

/* ------------------------------------------------------- failure reporting */
/* On an iPad there is no console, so any failure has to be legible on screen. */
function fatal(where, err) {
  const msg = (err && (err.message || err)) + '';
  const stack = (err && err.stack ? String(err.stack) : '').split('\n').slice(0, 4).join('\n');
  const box = $('boot') || document.body;
  box.hidden = false;
  box.innerHTML =
    '<div class="fatal"><h2>Something broke</h2>' +
    '<p><strong>' + where + '</strong></p>' +
    '<pre>' + escapeHtml(msg + (stack ? '\n\n' + stack : '')) + '</pre>' +
    '<p class="muted small">' + escapeHtml(navigator.userAgent) + '</p>' +
    '<p class="muted small">Read this out and it can be fixed.</p></div>';
  try { console.error(where, err); } catch (e) {}
}
function escapeHtml(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}
addEventListener('error', (e) => {
  if (!S.booted) fatal('Uncaught error during startup', e.error || e.message);
});
addEventListener('unhandledrejection', (e) => {
  if (!S.booted) fatal('Unhandled promise rejection during startup', e.reason);
});

async function boot() {
  try {
    loadPrefs();
    applyTheme();
    try {
      matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
    } catch (e) {
      // Safari < 14 only has the deprecated listener API; theme switching is not worth dying for.
      try { matchMedia('(prefers-color-scheme: light)').addListener(applyTheme); } catch (e2) {}
    }
    wireSearch();
  } catch (e) { return fatal('Startup (preferences / theme / search wiring)', e); }

  try {
    await loadDb();
  } catch (e) {
    return fatal('Loading the airport database (data/airports.json)', e);
  }

  try {
    wireUI();
    setAutoRefresh();
  } catch (e) { return fatal('Wiring up the controls', e); }

  try {
    const start = findApt(new URLSearchParams(location.search).get('apt') || PREFS.last || '') ||
      findApt('KBED');
    if (start) selectApt(start);
    else {
      $('boot').textContent = 'Search for an airport to begin.';
      $('main').hidden = false;
      $('search').focus();
    }
  } catch (e) { return fatal('Drawing the first airport', e); }

  S.booted = true;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
