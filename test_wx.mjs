// Exercises the live-weather path against mocked AWC and NWS responses.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:8899/';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

const AWC_KBED = [{
  metar_id: 1, icaoId: 'KBED', receiptTime: '2026-08-14 15:58:00', obsTime: Math.floor(Date.now() / 1000) - 600,
  reportTime: '2026-08-14 16:00:00', temp: 24.0, dewp: 11.0, wdir: 290, wspd: 14, wgst: 22,
  visib: '10+', altim: 1016.6, slp: null, qcField: 4, wxString: null,
  rawOb: 'KBED 141553Z 29014G22KT 10SM FEW045 24/11 A3002 RMK AO2 SLP164 T02390111',
  name: 'Laurence G Hanscom Fld, MA, US', lat: 42.4699, lon: -71.289, elev: 40,
}];

const NWS_KBED = {
  properties: {
    timestamp: new Date(Date.now() - 900e3).toISOString(),
    rawMessage: 'KBED 141553Z 18009KT 10SM CLR 22/09 A2995',
    windDirection: { value: 180 }, windSpeed: { value: 16.7 }, windGust: { value: null },
    temperature: { value: 22.0 }, dewpoint: { value: 9.0 }, barometricPressure: { value: 101420 },
  },
};

async function scenario(name, routes, act) {
  const page = await b.newPage({ viewport: { width: 900, height: 1200 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  for (const [pat, handler] of routes) await page.route(pat, handler);
  await page.goto(BASE + '?apt=KBED', { waitUntil: 'networkidle' });
  await page.waitForSelector('#aptId:not(:empty)');
  await page.waitForTimeout(900);
  console.log('\n== ' + name + ' ==');
  console.log('  status :', (await page.textContent('#metarStatus')).trim());
  console.log('  raw    :', (await page.textContent('#metarRaw')).trim() || '(hidden)');
  console.log('  best   : RWY', await page.textContent('#bestRwy'),
    '| head', await page.textContent('#bestHead'),
    '| cross', await page.textContent('#bestCross'), '|', await page.textContent('#bestCrossLbl'));
  const gw = await page.$('#bestGustWrap:not([hidden])');
  console.log('  gust X :', gw ? await page.textContent('#bestGust') : '(none)');
  console.log('  perf   : PA', await page.textContent('#daPA'), '| DA', await page.textContent('#daDA'),
    '| alt', await page.textContent('#daAlt'), '| T/D', await page.textContent('#daTemp'));
  if (act) await act(page);
  if (errs.length) console.log('  JS ERRORS:', errs);
  return page;
}

const json = (body) => (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

await scenario('AWC responds normally', [
  ['**aviationweather.gov/**', json(AWC_KBED)],
  ['**api.weather.gov/**', (r) => r.abort()],
]);

await scenario('AWC down, NWS fallback', [
  ['**aviationweather.gov/**', (r) => r.fulfill({ status: 503, body: 'nope' })],
  ['**api.weather.gov/**', json(NWS_KBED)],
]);

await scenario('AWC returns empty array', [
  ['**aviationweather.gov/**', json([])],
  ['**api.weather.gov/**', json(NWS_KBED)],
]);

await scenario('AWC sends VRB wind', [
  ['**aviationweather.gov/**', json([{ ...AWC_KBED[0], wdir: 'VRB', wspd: 4, wgst: null,
    rawOb: 'KBED 141553Z VRB04KT 10SM CLR 24/11 A3002' }])],
  ['**api.weather.gov/**', (r) => r.abort()],
]);

await b.close();
