import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newsTimes, inNewsWindow } from '../src/core/news.js';

test('News-Sperre ±15 Min (d_ftmo News-Filter) auf dem ForexFactory-Kalender', () => {
  const times = newsTimes({ currencies: ['USD', 'EUR'], impacts: ['high'] });
  const nfp = Date.parse('2015-06-05T12:30:00Z');
  assert.ok(times.includes(nfp), 'NFP 05.06.2015 12:30 UTC im Kalender');
  assert.ok(inNewsWindow(nfp - 15 * 60000, times)); assert.ok(inNewsWindow(nfp + 15 * 60000, times));
  assert.ok(!inNewsWindow(Date.parse('2015-06-06T12:30:00Z'), times)); // Samstag
  assert.ok(!inNewsWindow(nfp, newsTimes({ currencies: ['JPY'], impacts: ['high'] })));
});
