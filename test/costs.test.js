import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swapNights, tradeCosts, profileName } from '../src/core/costs.js';

const T = (s) => Date.parse(s);
test('Swap-Nächte FTMO: Rollover 00:00 Athen, Mo–Fr, Mittwoch dreifach', () => {
  const o = { rolloverHour: 0 };
  assert.deepEqual(swapNights(T('2025-03-04T10:00:00Z'), T('2025-03-04T15:00:00Z'), 'Europe/Athens', 3, o), { nights: 0, charged: 0 });
  assert.deepEqual(swapNights(T('2025-03-04T10:00:00Z'), T('2025-03-05T08:00:00Z'), 'Europe/Athens', 3, o), { nights: 1, charged: 1 }); // Di -> Mi
  assert.deepEqual(swapNights(T('2025-03-05T10:00:00Z'), T('2025-03-06T08:00:00Z'), 'Europe/Athens', 3, o), { nights: 1, charged: 3 }); // Mi -> Do
  assert.deepEqual(swapNights(T('2025-03-07T10:00:00Z'), T('2025-03-10T08:00:00Z'), 'Europe/Athens', 3, o), { nights: 1, charged: 1 }); // Fr -> Mo
  assert.deepEqual(swapNights(T('2025-03-04T21:30:00Z'), T('2025-03-04T22:30:00Z'), 'Europe/Athens', 3, o), { nights: 1, charged: 1 }); // 00:00 Athen = 22:00 UTC
});

test('Swap-Nächte Capital: 17:00 New York, Indizes jede Kalendernacht', () => {
  const o = { rolloverHour: 17, weekendDaily: true };
  assert.deepEqual(swapNights(T('2025-03-04T21:30:00Z'), T('2025-03-04T22:30:00Z'), 'America/New_York', null, o), { nights: 1, charged: 1 }); // 17:00 NY = 22:00 UTC (EST)
  assert.deepEqual(swapNights(T('2025-03-07T15:00:00Z'), T('2025-03-10T15:00:00Z'), 'America/New_York', null, o), { nights: 3, charged: 3 }); // Fr -> Mo: Fr, Sa, So
  assert.deepEqual(swapNights(T('2025-07-01T20:30:00Z'), T('2025-07-01T21:30:00Z'), 'America/New_York', null, o), { nights: 1, charged: 1 }); // Sommer: 21:00 UTC
});

test('FTMO EURUSD: 5 USD/Lot Round-Turn, Swap Long −9,5 Punkte', () => {
  const t = { dir: 'BUY', entry: 1.1, entryT: T('2025-03-04T10:00:00Z'), exitT: T('2025-03-05T08:00:00Z'), size: 200000, pointValue: 1, riskMoney: 100, fill: 'LIMIT', reason: 'TP' };
  const c = tradeCosts(t, 'EURUSD', 'ftmo');
  assert.equal(c.commission, 10); assert.ok(Math.abs(c.swap - 19) < 1e-9); assert.ok(Math.abs(c.costR - 0.29) < 1e-9);
  assert.ok(tradeCosts({ ...t, dir: 'SELL' }, 'EURUSD', 'ftmo').swap < 0); // Short: Gutschrift
});

test('Capital US100: Swap in % vom Positionswert, Slippage nur beim SL', () => {
  const t = { dir: 'BUY', entry: 20000, entryT: T('2025-03-04T15:00:00Z'), exitT: T('2025-03-05T15:00:00Z'), size: 2, pointValue: 1, riskMoney: 100, fill: 'LIMIT', reason: 'SL' };
  const c = tradeCosts(t, 'US100', 'capital');
  assert.ok(Math.abs(c.swap - 0.0002221 * 20000 * 2) < 1e-9); assert.equal(c.commission, 0); assert.ok(c.slippage > 0 && c.slippage < 1.07 * 2); // Slippage skaliert mit dem Kursniveau
  assert.equal(tradeCosts({ ...t, reason: 'TP' }, 'US100', 'capital').slippage, 0);
  assert.equal(profileName({ family: 'NAS_FTMO' }), 'ftmo'); assert.equal(profileName({ family: 'NAS' }), 'capital');
});

test('FTMO-Indexswap skaliert mit dem Kursniveau (Referenzkurs 12.11.2026)', () => {
  const t = { dir: 'BUY', entry: 28426.63 / 4, entryT: T('2025-03-04T10:00:00Z'), exitT: T('2025-03-05T08:00:00Z'), size: 1, pointValue: 1, riskMoney: 100, fill: 'LIMIT', reason: 'TP' };
  assert.ok(Math.abs(tradeCosts(t, 'US100', 'ftmo').swap - 6.5588 / 4) < 1e-9);
});
