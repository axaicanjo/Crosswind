# Crosswind

Runway headwind / crosswind component calculator for US airports. Offline-first web app,
built to live on an iPad home screen.

**Not for navigation.** Advisory only. Verify against current charts, the Chart Supplement,
and official weather before flight.

---

## Putting it on your iPad

### 1. Create the repo

On [github.com](https://github.com), click **+ → New repository**. Name it `crosswind`,
set it to **Public** (GitHub Pages needs public on a free account), and create it.

### 2. Upload the files

On the empty repo page, click **uploading an existing file**. Drag in everything from
this folder — `index.html`, `app.css`, `app.js`, `sw.js`, `manifest.webmanifest`,
`.nojekyll`, and the `data/` and `icons/` folders. Commit.

> `data/airports.json` is about 1.6 MB. That's fine for the web uploader and well under
> GitHub's limits.

### 3. Turn on Pages

**Settings → Pages**. Under *Build and deployment*, set Source to **Deploy from a branch**,
branch **main**, folder **/ (root)**. Save.

Now **reload the page** — it does not update on its own. After a minute or two a green
banner appears near the top of the Pages section:

> ✅ Your site is live at `https://<your-username>.github.io/crosswind/`

Before the first build finishes you'll instead see *"Your site is being built"*, or nothing
at all. Reload again.

If it still hasn't appeared after five minutes, check the **Actions** tab for a workflow
run called *pages build and deployment*. A red X there means the build failed; the log
says why.

The URL is predictable, so you can also just try it directly:

```
https://<your-username>.github.io/<repo-name>/
```

**If you get a 404:** `index.html` has to sit at the top level of the repo, not inside a
subfolder. If the repo shows a single folder (e.g. `Crosswind app/`) instead of
`index.html`, `app.js`, `data/`, and so on, you uploaded the folder rather than its
contents. Delete the files and re-upload, opening the folder first and selecting
everything inside it.

### 4. Add it to the home screen

Open that URL in **Safari** on the iPad (it has to be Safari — Chrome on iOS can't install
web apps). Tap the **Share** button → **Add to Home Screen** → **Add**.

Open it once from the home screen icon while you still have wifi. That first launch caches
the whole airport database, so from then on it works with no signal.

---

## Using it

**Search** by identifier (`BED`, `KBED`, `06N`), airport name, or city.

**METAR tab** pulls the current observation automatically. If the field has no reporting
station, it finds the nearest one within 60 nm and tells you how far away it is. The last
report is saved on the device, so if you open it with no signal you still see the most
recent one you fetched, clearly marked as not current.

**Manual tab** for when there's no signal or you want to try a what-if. Enter direction,
speed, and gust.

- **Magnetic** is what ATIS, tower, and AWOS give you over the radio. This is the default.
- **True** is what a coded METAR or a forecast prints. The app converts it using the
  field's magnetic variation.

Getting this backwards matters. At Seattle the variation is 15° E — a wind read as true
when it was magnetic puts the crosswind out by a couple of knots at 20 kt, and more at
higher angles.

**Paste a raw METAR** (under the Manual tab) takes a full METAR string, sets the wind to
true reference automatically, and picks up the temperature and altimeter for density
altitude.

**Best runway** is the end with the greatest headwind component. Ties within half a knot
go to the longer runway. Tap any row in the table to draw that runway instead.

**Settings** (gear icon) sets your personal crosswind limit. Runways over it turn red;
runways within 20% of it turn amber. You can point the limit at the gust crosswind
instead of the steady one.

---

## How the numbers are worked out

Wind components:

```
offset  = wind direction (magnetic) − runway magnetic heading
headwind = speed × cos(offset)        + is a headwind, − is a tailwind
crosswind = speed × sin(offset)       + is from the right, − is from the left
```

**Runway headings** come from surveyed true bearings converted to magnetic with the
NOAA/NCEI World Magnetic Model 2025, but only where that result agrees with the painted
runway number within 6°. Where the survey data is missing or disagrees, the app falls
back to the painted number × 10 and marks the heading `±5` in the table. About a third
of runways — mostly the larger fields — get the surveyed value.

**Magnetic variation** is precomputed per airport from WMM2025 at build time, along with
its annual rate of change, so the app drifts it forward without needing the model at
runtime. WMM2025 is valid through 2029.

**Pressure and density altitude** use the standard field approximations:

```
PA = field elevation + (29.92 − altimeter inHg) × 1000
ISA temp = 15 − 1.98 × (PA / 1000)
DA = PA + 118.8 × (OAT − ISA temp)
```

That's a dry-air estimate — it ignores humidity, which on a hot muggy day makes the real
density altitude a bit worse than shown.

---

## Data sources

| What | Where | Notes |
|---|---|---|
| Airports and runways | [OurAirports](https://ourairports.com/data/) | Public domain. 12,460 US airports, 15,121 runways. |
| Magnetic declination | [NOAA/NCEI WMM2025](https://www.ncei.noaa.gov/products/world-magnetic-model) | Baked in at build time. |
| Weather (primary) | [NOAA Aviation Weather Center](https://aviationweather.gov/data/api/) | `api/data/metar` |
| Weather (fallback) | [NWS api.weather.gov](https://www.weather.gov/documentation/services-web-api) | Used automatically if AWC fails |

The status line under the METAR tab always names the source it actually used, so you can
tell at a glance which one answered.

---

## Refreshing the airport data

Runway data changes slowly, but if you want a newer snapshot, re-run `build_data.py`
(included alongside this folder) with fresh `airports.csv` and `runways.csv` from
OurAirports, then re-upload `data/airports.json` and bump `VERSION` in `sw.js` so the
service worker replaces its cached copy.

## License

Do whatever you like with it. Airport data is public domain; keep the attribution in the
footer honest if you pass it on.
