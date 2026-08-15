import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8899/';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await b.newPage({ viewport: { width: 1024, height: 1366 }, deviceScaleFactor: 2 });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
// Block the live weather calls so we test the offline path deterministically.
await page.route('**://aviationweather.gov/**', (r) => r.abort());
await page.route('**://api.weather.gov/**', (r) => r.abort());

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#aptId:not(:empty)', { timeout: 20000 });
console.log('default airport:', await page.textContent('#aptId'), '|', await page.textContent('#aptName'));

// --- search ---
await page.fill('#search', 'aspen');
await page.waitForSelector('#results li');
console.log('search "aspen" ->', (await page.$$eval('#results li', (n) => n.slice(0, 3).map((x) => x.textContent))).join(' / '));
await page.click('#results li:first-child');
await page.waitForTimeout(300);
console.log('selected:', await page.textContent('#aptId'), '|', await page.textContent('#aptMeta'));

// --- manual wind ---
await page.click('#tabManual');
await page.fill('#mDir', '270');
await page.fill('#mSpd', '20');
await page.fill('#mGst', '30');
await page.waitForTimeout(250);
console.log('\nKASE rwy 15/33, wind 270/20G30 magnetic:');
console.log('  best:', await page.textContent('#bestRwy'),
  '| head', await page.textContent('#bestHead'),
  '| cross', await page.textContent('#bestCross'), (await page.textContent('#bestCrossLbl')),
  '| gust x', await page.textContent('#bestGust'));
console.log('  table:');
for (const row of await page.$$eval('#rwyTable tbody tr', (rs) => rs.map((r) => [...r.cells].map((c) => c.innerText.trim()).join(' | ')))) {
  console.log('   ', row);
}
console.log('  warn:', (await page.textContent('#bestWarn')).trim() || '(none)');

// --- paste a METAR ---
await page.click('.paste summary');
await page.fill('#pasteBox', 'KASE 141553Z 29014G22KT 10SM FEW045 24/11 A3002 RMK AO2');
await page.click('#pasteBtn');
await page.waitForTimeout(300);
console.log('\nafter pasting KASE 29014G22KT 24/11 A3002:');
console.log('  msg:', await page.textContent('#pasteMsg'));
console.log('  best:', await page.textContent('#bestRwy'), '| head', await page.textContent('#bestHead'), '| cross', await page.textContent('#bestCross'));
console.log('  PA', await page.textContent('#daPA'), '| DA', await page.textContent('#daDA'), '| ISA', await page.textContent('#daISA'), '| alt', await page.textContent('#daAlt'));

await page.screenshot({ path: '/root/wind/shot-ipad-day.png', fullPage: true });
await page.click('#themeBtn'); // -> day
await page.waitForTimeout(200);
await page.screenshot({ path: '/root/wind/shot-1.png', fullPage: true });
await page.click('#themeBtn'); await page.click('#themeBtn');
await page.waitForTimeout(200);

// --- big airport, tailwind case ---
await page.fill('#search', 'KJFK');
await page.waitForSelector('#results li');
await page.click('#results li:first-child');
await page.waitForTimeout(300);
await page.click('#tabManual');
await page.fill('#mDir', '040'); await page.fill('#mSpd', '18'); await page.fill('#mGst', '');
await page.waitForTimeout(250);
console.log('\nKJFK wind 040/18 magnetic — best:', await page.textContent('#bestRwy'),
  'head', await page.textContent('#bestHead'), 'cross', await page.textContent('#bestCross'));
console.log('  all ends:');
for (const row of await page.$$eval('#rwyTable tbody tr', (rs) => rs.map((r) => [...r.cells].slice(0, 4).map((c) => c.innerText.trim()).join(' | ')))) {
  console.log('   ', row);
}
await page.screenshot({ path: '/root/wind/shot-2.png', fullPage: true });

// --- offline METAR path: no station, no network ---
await page.click('#tabMetar');
await page.waitForTimeout(1200);
console.log('\nMETAR tab with network blocked:', (await page.textContent('#metarStatus')).trim());

// --- phone viewport ---
const p2 = await b.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
await p2.route('**://aviationweather.gov/**', (r) => r.abort());
await p2.route('**://api.weather.gov/**', (r) => r.abort());
await p2.goto(BASE + '?apt=KBED', { waitUntil: 'networkidle' });
await p2.waitForSelector('#aptId:not(:empty)');
await p2.click('#tabManual');
await p2.fill('#mDir', '200'); await p2.fill('#mSpd', '16'); await p2.fill('#mGst', '24');
await p2.waitForTimeout(300);
await p2.screenshot({ path: '/root/wind/shot-phone.png', fullPage: true });
console.log('\nKBED 200/16G24 -> best', await p2.textContent('#bestRwy'),
  'head', await p2.textContent('#bestHead'), 'cross', await p2.textContent('#bestCross'), await p2.textContent('#bestCrossLbl'));

console.log('\nconsole errors:', errs.length ? errs : 'none');
await b.close();
