// Unit tests for the wind-component math, run against app.js's own functions.
import fs from 'fs';
import vm from 'vm';

const src = fs.readFileSync(new URL('./xwind/app.js', import.meta.url), 'utf8');
// Strip the DOM-dependent bootstrap: we only want the pure functions.
const pure = src.split('/* ------------------------------------------------------------------ data */')[0];

const ctx = { console, document: { getElementById: () => ({}) }, localStorage: { getItem: () => null, setItem: () => {} } };
vm.createContext(ctx);
vm.runInContext(pure + '\nglobalThis.__x = {components, angDelta, norm360, endHeading, trueToMag, magToTrue, pressureAlt, densityAlt, isaTemp};', ctx);
const X = ctx.__x;

let pass = 0, fail = 0;
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;
function t(name, cond, got, want) {
  if (cond) { pass++; }
  else { fail++; console.log(`FAIL  ${name}\n      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}

// --- angDelta ---
t('angDelta 350->010 = +20', near(X.angDelta(350, 10), 20), X.angDelta(350, 10), 20);
t('angDelta 010->350 = -20', near(X.angDelta(10, 350), -20), X.angDelta(10, 350), -20);
t('angDelta 090->270 = 180', near(Math.abs(X.angDelta(90, 270)), 180), X.angDelta(90, 270), 180);

// --- components: straight down the runway ---
let c = X.components(270, 270, 20);
t('straight headwind', near(c.head, 20) && near(c.cross, 0), c, { head: 20, cross: 0 });

// --- pure tailwind ---
c = X.components(270, 90, 20);
t('pure tailwind', near(c.head, -20) && near(c.cross, 0, 1e-6 + 1e-3), c, { head: -20, cross: 0 });

// --- 90 deg from the right ---
c = X.components(360, 90, 15);
t('90 from right: cross +15', near(c.head, 0, 1e-6) && near(c.cross, 15), c, { head: 0, cross: 15 });

// --- 90 deg from the left ---
c = X.components(360, 270, 15);
t('90 from left: cross -15', near(c.head, 0, 1e-6) && near(c.cross, -15), c, { head: 0, cross: -15 });

// --- classic 30 deg rule of thumb: cross = half the wind ---
c = X.components(360, 30, 20);
t('30 deg off -> cross 10 kt (1/2 rule)', near(c.cross, 10, 0.01) && near(c.head, 17.32, 0.01), c, { cross: 10 });

// --- 45 deg: cross = head = 0.707 V ---
c = X.components(90, 135, 20);
t('45 deg off -> head=cross=14.14', near(c.head, 14.142, 0.01) && near(c.cross, 14.142, 0.01), c, 14.142);

// --- 60 deg rule of thumb: cross ~ 0.87 V ---
c = X.components(180, 240, 20);
t('60 deg off -> cross 17.3', near(c.cross, 17.32, 0.01), c, 17.32);

// --- worked real example: KBED rwy 11 (111.7 M), wind 290/14 magnetic -> 8 kt tailwind ---
c = X.components(111.7, 290, 14);
t('KBED 11 with 290@14 is a tailwind', c.head < -13.9, c.head, '< -13.9');
c = X.components(291.7, 290, 14);
t('KBED 29 with 290@14 is ~14 kt headwind', near(c.head, 14, 0.02) && Math.abs(c.cross) < 0.5, c, 14);

// --- end heading arithmetic ---
t('endHeading low', near(X.endHeading(133.6, 0), 133.6, 1e-9), X.endHeading(133.6, 0), 133.6);
t('endHeading high', near(X.endHeading(133.6, 1), 313.6), X.endHeading(133.6, 1), 313.6);
t('endHeading wraps', near(X.endHeading(350, 1), 170), X.endHeading(350, 1), 170);

// --- true / magnetic conversion. Convention: true = magnetic + decl (E positive) ---
// KJFK decl -12.56 (W). Rwy 04L surveyed true 31.0 -> magnetic 43.56.
t('JFK true->mag', near(X.trueToMag(31.0, -12.56), 43.56, 0.01), X.trueToMag(31.0, -12.56), 43.56);
t('mag->true roundtrip', near(X.magToTrue(X.trueToMag(200, 14.85), 14.85), 200, 1e-9), 0, 0);
// KSEA decl +14.85 (E). METAR wind 180 true -> 165.15 magnetic.
t('SEA true 180 -> mag 165.15', near(X.trueToMag(180, 14.85), 165.15, 0.01), X.trueToMag(180, 14.85), 165.15);

// --- pressure / density altitude ---
// Standard day at sea level: 29.92 -> PA 0, 15 C -> DA 0.
let pa = X.pressureAlt(0, 29.9213 * 33.8638866667);
t('PA std sea level = 0', near(pa, 0, 0.5), pa, 0);
t('DA std sea level = 0', near(X.densityAlt(pa, 15), 0, 1), X.densityAlt(pa, 15), 0);
// 30.42 inHg at sea level -> PA about -500 ft
pa = X.pressureAlt(0, 30.4213 * 33.8638866667);
t('PA at 30.42 = -500', near(pa, -500, 1), pa, -500);
// KASE 7820 ft, 29.92, OAT 25 C: ISA at 7820 is 15-1.98*7.82 = -0.48; DA = 7820 + 118.8*25.48
pa = X.pressureAlt(7820, 29.9213 * 33.8638866667);
let da = X.densityAlt(pa, 25);
t('KASE hot-day DA ~ 10847', near(da, 7820 + 118.8 * (25 - (15 - 1.98 * 7.82)), 1), Math.round(da), 10847);
console.log('  (KASE 7820 ft / 25 C / 29.92 -> DA ' + Math.round(da) + ' ft)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
