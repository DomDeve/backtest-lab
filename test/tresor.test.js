import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tresorYears, sealBars, openTresor } from '../src/core/tresor.js';

test('Tresor: versiegelte Jahre werden ausgeblendet', () => {
  const ys = tresorYears('DE40');
  assert.deepEqual([...ys].sort(), [2014, 2017, 2020, 2023]);
  const bars = ['2016-12-30T15:00:00Z', '2017-01-02T08:00:00Z', '2017-12-29T20:00:00Z', '2018-01-02T08:00:00Z'].map((s) => ({ t: Date.parse(s) }));
  const r = sealBars(bars, 'DE40');
  assert.equal(r.removed, 2);
  assert.deepEqual(r.bars.map((b) => new Date(b.t).getUTCFullYear()), [2016, 2018]);
});

test('Tresor: Öffnen nur mit Begründung, wird protokolliert', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tresor-')), 'p.jsonl');
  assert.throws(() => openTresor({ epic: 'US100', reason: '', file }));
  openTresor({ epic: 'US100', reason: 'Urteil Legacy-Bots nach Entwicklungsphase', variants: ['nas-f618atr'], file });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).varianten[0], 'nas-f618atr');
});
