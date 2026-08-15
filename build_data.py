#!/usr/bin/env python3
"""Build a compact US airport/runway JSON for the crosswind PWA.

Output schema (arrays, not objects, to keep the file small):

  a: [ id, icao, station, name, city, state, lat, lon, elev, decl, declRate, runways ]
  runways: [ le_ident, he_ident, le_mag_hdg, len_ft, wid_ft, surf_idx, lit, precise ]

le_mag_hdg is the MAGNETIC heading of the low-numbered end.
  precise=1 -> derived from surveyed true heading + WMM declination
  precise=0 -> derived from the painted runway number (number x 10)

decl is magnetic declination in degrees (East positive) at the field, epoch
`gen`; declRate is deg/year so the app can extrapolate.
Convention: true = magnetic + decl  ->  magnetic = true - decl
"""
import csv, json, os, re, datetime
from pygeomag import GeoMag

D = os.path.expanduser('~/wind')
OUT = os.path.expanduser('~/wind/xwind/data/airports.json')

KEEP_TYPES = {'small_airport', 'medium_airport', 'large_airport'}
SURF = ['Unknown', 'Asphalt', 'Concrete', 'Turf', 'Gravel', 'Dirt', 'Water', 'Snow/Ice', 'Mats', 'Sand']


def surf_idx(s):
    s = (s or '').upper()
    if not s: return 0
    if any(k in s for k in ('ASP', 'BIT', 'TAR', 'PAVE', 'PEM', 'MAC')): return 1
    if any(k in s for k in ('CON', 'CEM', 'PSP')): return 2
    if any(k in s for k in ('TURF', 'GRAS', 'GRS', 'SOD')): return 3
    if any(k in s for k in ('GRVL', 'GRAV', 'CORAL', 'ROCK', 'STONE')): return 4
    if any(k in s for k in ('DIRT', 'CLAY', 'SOIL', 'GROUND', 'EARTH')): return 5
    if any(k in s for k in ('WATER', 'LAKE')): return 6
    if any(k in s for k in ('SNOW', 'ICE')): return 7
    if any(k in s for k in ('MAT', 'ALUM', 'STEEL', 'DECK')): return 8
    if 'SAND' in s: return 9
    return 0


RWY_NUM = re.compile(r'^(\d{1,2})([LRCWAB]?)$')


def parse_end(ident):
    if not ident: return None
    t = ident.strip().upper().replace(' ', '')
    m = RWY_NUM.match(t)
    if not m: return None
    n = int(m.group(1))
    if n < 1 or n > 36: return None
    return n


def f(v, default=None):
    try: return float(v)
    except (TypeError, ValueError): return default


def i(v, default=0):
    try: return int(float(v))
    except (TypeError, ValueError): return default


def angdiff(a, b):
    d = abs((a - b) % 360)
    return min(d, 360 - d)


today = datetime.date.today()
DECIMAL_YEAR = today.year + (today.timetuple().tm_yday - 1) / 365.25
gm = GeoMag(coefficients_file='wmm/WMM_2025.COF')

# ---- airports ----
apts = {}
for r in csv.DictReader(open(D + '/airports.csv')):
    if r['iso_country'] != 'US' or r['type'] not in KEEP_TYPES:
        continue
    lat, lon = f(r['latitude_deg']), f(r['longitude_deg'])
    if lat is None or lon is None:
        continue
    icao = (r['icao_code'] or '').strip().upper()
    gps = (r['gps_code'] or '').strip().upper()
    local = (r['local_code'] or '').strip().upper()
    station = icao or (gps if re.fullmatch(r'K[A-Z0-9]{3}', gps or '') else '')
    region = r['iso_region'] or ''
    apts[r['ident']] = {
        'id': local or icao or r['ident'],
        'icao': icao,
        'st': station,
        'nm': r['name'],
        'city': r['municipality'] or '',
        'state': region.split('-')[-1] if region.startswith('US-') else '',
        'lat': round(lat, 5),
        'lon': round(lon, 5),
        'elev': i(r['elevation_ft'], -9999),
        'rw': [],
    }

# ---- runways ----
stats = {'precise': 0, 'painted': 0}
for r in csv.DictReader(open(D + '/runways.csv')):
    a = apts.get(r['airport_ident'])
    if a is None or r['closed'] == '1':
        continue
    le, he = parse_end(r['le_ident']), parse_end(r['he_ident'])
    if le is None or he is None:
        continue
    if 'decl' not in a:
        res = gm.calculate(glat=a['lat'], glon=a['lon'], alt=0, time=DECIMAL_YEAR)
        nxt = gm.calculate(glat=a['lat'], glon=a['lon'], alt=0, time=DECIMAL_YEAR + 1)
        a['decl'] = round(res.d, 2)
        a['drate'] = round(nxt.d - res.d, 3)

    painted = le * 10.0
    mag, precise = painted, 0
    t = f(r['le_heading_degT'])
    if t is None:
        th = f(r['he_heading_degT'])
        t = (th + 180) % 360 if th is not None else None
    if t is not None:
        cand = (t - a['decl']) % 360
        if angdiff(cand, painted) <= 6.0:
            mag, precise = round(cand, 1), 1
    stats['precise' if precise else 'painted'] += 1

    a['rw'].append([
        r['le_ident'].strip().upper(), r['he_ident'].strip().upper(),
        mag, i(r['length_ft'], 0), i(r['width_ft'], 0),
        surf_idx(r['surface']), 1 if r['lighted'] == '1' else 0, precise,
    ])

apts = {k: v for k, v in apts.items() if v['rw']}

rows = []
for ident, a in sorted(apts.items(), key=lambda kv: kv[1]['id']):
    a['rw'].sort(key=lambda x: -x[3])  # longest runway first
    rows.append([a['id'], a['icao'], a['st'], a['nm'], a['city'], a['state'],
                 a['lat'], a['lon'], a['elev'], a['decl'], a['drate'], a['rw']])

out = {
    'v': 1,
    'src': 'OurAirports (public domain) + NOAA/NCEI WMM2025',
    'gen': today.isoformat(),
    'epochYear': round(DECIMAL_YEAR, 3),
    'surf': SURF,
    'cols': ['id', 'icao', 'station', 'name', 'city', 'state', 'lat', 'lon',
             'elev', 'decl', 'declRate', 'runways'],
    'rwcols': ['le', 'he', 'leMagHdg', 'lenFt', 'widFt', 'surf', 'lit', 'precise'],
    'a': rows,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w') as fh:
    json.dump(out, fh, separators=(',', ':'))

print(f"airports={len(rows)} runways={sum(stats.values())} "
      f"precise={stats['precise']} painted={stats['painted']} "
      f"bytes={os.path.getsize(OUT):,}")
print('with METAR station id=', sum(1 for a in apts.values() if a['st']))
for probe in ('KJFK', 'KASE', 'KBED', 'KSEA'):
    for a in apts.values():
        if a['icao'] == probe:
            print(probe, a['decl'], a['elev'], a['rw'][:3])
            break
