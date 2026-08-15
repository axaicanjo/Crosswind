# Crosswind — handoff notes

Context for a fresh session picking this up. Read `README.md` for how the app works and
how to deploy it; this file is the "why" and the current state.

## Goal

A self-contained crosswind/headwind calculator for the iPad, personal use. Web app, not
native — Safari "Add to Home Screen" gives an app icon and offline use without Xcode
signing or a $99/yr developer account.

## Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Platform | PWA (HTML/CSS/JS), no framework, no build step | Add to Home Screen; no signing; edit and re-upload |
| Hosting | GitHub Pages | Free HTTPS, which a service worker requires |
| Airport coverage | All US land airports (12,460 / 15,121 runways) | Includes small and grass strips |
| Data persistence | localStorage only | Prefs, favorites, last METAR per station |
| Wind reference | Magnetic by default, True toggle | ATIS/tower/AWOS are magnetic; coded METAR is true |
| Extras | Gust crosswind, personal x-wind limit, density altitude, recents/favorites | All requested |

## Architecture

Flat static site, no bundler:

```
index.html            markup only
app.css               themed via CSS custom properties, day/night
app.js                everything: state, search, METAR, math, SVG diagram
sw.js                 cache-first service worker; bump VERSION to force a refresh
manifest.webmanifest
data/airports.json    1.6 MB, generated
icons/
build_data.py         regenerates data/airports.json from OurAirports CSVs
```

`app.js` sections, in order: state/prefs → math → data loading and search → METAR fetch →
wind model → views (`render()` fans out to `renderBest`, `renderTable`, `renderDiagram`,
`renderPerf`) → glue/wiring.

## The one subtle thing

Coded METAR winds are **true north**; runway numbers are **magnetic**. Mixing them is the
main way this class of tool goes wrong. Declination per airport is precomputed at build
time from WMM2025 (`pygeomag`), with its annual rate, so the app drifts it forward without
carrying the model at runtime. Convention throughout:

```
true = magnetic + declination        (declination East positive)
```

Runway magnetic headings come from OurAirports' surveyed true bearings converted with that
declination — but only where the result lands within 6° of the painted runway number.
OurAirports' heading field is unreliable at small strips: 24% of them disagree with their
own runway numbers by more than 6°. Those fall back to number × 10 and are flagged `±5`
in the table.

## Verification done

- `test_math.mjs` — 22 assertions: trig, the 30°/45°/60° rules of thumb, angle wrapping,
  true/magnetic round trips, PA/DA against standard-day and known cases.
- `smoke.mjs` — headless browser: search, manual wind, paste-METAR, tailwind cases,
  offline behaviour, phone and iPad viewports.
- `test_wx.mjs` — mocked AWC normal / AWC down with NWS fallback / empty response / VRB wind.

Run them with a local server on port 8899 (`python3 -m http.server 8899` in this folder).
Playwright needs `executablePath: '/opt/pw-browsers/chromium'` in the sandbox.

## Open items

1. **Not yet deployed.** No GitHub repo, no Pages URL, never opened on the actual iPad.
2. **AWC CORS unverified.** `aviationweather.gov/api/data/metar` is the primary weather
   source and cross-origin access was never confirmed from a real browser — the build
   sandbox had no outbound access to it. If it turns out to block CORS the app silently
   falls through to `api.weather.gov`, which definitely allows browser requests. The
   status line under the METAR tab names whichever source answered, so the first real
   launch will show which one is live. Nothing to fix unless both fail.
3. **Not flight-tested.** Numbers check out against hand calculations; nobody has compared
   a reading against an actual ATIS yet.

## Ideas raised but not built

- Runway length / landing distance adjustment for the headwind component
- Aircraft profiles (different limits per type flown)
- Wind history sparkline from the last few METARs
- North-up diagram orientation as an alternative to runway-up
