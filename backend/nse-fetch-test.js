/* ============================================================
   nse-fetch-test.js — Standalone NSE 1-min candle test
   Purpose: verify openchart-js fetches 3-7 days of 1-min data
            for all active NSE stocks without NSE blocking us.
   ============================================================ */

import NSEData from 'openchart-js';
import moment from 'moment';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

export async function runNseTest() {
  const ALL_STOCKS = JSON.parse(
    readFileSync(join(__dir, 'brokers/angelone/Angel_nifty500.json'), 'utf8')
  );
  const STOCKS = ALL_STOCKS.filter(s => !s.disabled);

  console.log(`📋 NSE test: ${STOCKS.length} stocks`);

  const nse = new NSEData();
  console.log('⏳ Downloading NSE master...');
  await nse.download();
  console.log('✅ NSE master downloaded');

  const endDate = moment().subtract(1, 'days').toDate();
  const startDate = moment().subtract(7, 'days').toDate();

  const results = [];
  let ok = 0, empty = 0, failed = 0;
  const t0 = Date.now();

  for (let i = 0; i < STOCKS.length; i++) {
    const symbol = STOCKS[i].sym.replace(/-EQ$/, '');

    try {
      const data = await nse.historical(symbol, 'NSE', startDate, endDate, '1m');

      if (!data || !data.length) {
        empty++;
        results.push({ symbol, ok: false, reason: 'no_data' });
      } else {
        ok++;
        results.push({
          symbol,
          ok: true,
          candles: data.length,
          first: data[0],
          last: data[data.length - 1]
        });
      }
    } catch (e) {
      failed++;
      results.push({ symbol, ok: false, reason: String(e.message || e) });
    }

    if ((i + 1) % 25 === 0 || i === STOCKS.length - 1) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`📊 ${i + 1}/${STOCKS.length} | ok=${ok} empty=${empty} failed=${failed} | ${elapsed}s`);
    }

    await new Promise(r => setTimeout(r, 300));
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`✅ NSE test DONE in ${elapsed}s | ok=${ok} empty=${empty} failed=${failed}`);

  // Error breakdown
  const errors = {};
  results.forEach(r => {
    if (!r.ok && r.reason) errors[r.reason] = (errors[r.reason] || 0) + 1;
  });

  return {
    elapsed,
    ok,
    empty,
    failed,
    total: STOCKS.length,
    errors,
    sample_ok: results.filter(r => r.ok).slice(0, 10),
    sample_fail: results.filter(r => !r.ok).slice(0, 10)
  };
}
