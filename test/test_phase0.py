"""Phase-0-Abgleich mit konstruierten Live-/Backtest-Trades."""
import os, sys, json, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import phase0

class Phase0(unittest.TestCase):
    def test_zuordnung_dubletten_und_match(self):
        rows = [dict(bot='NAS F618ATR', bot_id='F618ATR', direction='SELL', entry_price=100, stop_loss=110, exit_price=80, result='WIN', opened_at='2026-01-05T15:00:00'),
                dict(bot='NAS F618ATR', bot_id='F618ATR', direction='SELL', entry_price=100, stop_loss=110, exit_price=80, result='WIN', opened_at='2026-01-05T15:00:20'),  # Dublette
                dict(bot='NAS F618ATR', bot_id='F618ATR', direction='BUY', entry_price=100, stop_loss=90, exit_price=None, result='CANCELLED', opened_at='2026-01-06T10:00:00'),
                dict(bot='GBP Test', bot_id='X', direction='BUY', entry_price=1, stop_loss=0.9, exit_price=1.1, result='WIN', opened_at='2026-01-05T10:00:00')]
        f = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False); json.dump(rows, f); f.close()
        live, sk = phase0.load_live(f.name)
        self.assertEqual(len(live), 1)
        self.assertEqual(sk['dubletten'], 1); self.assertEqual(sk['nicht_gefuellt'], 1); self.assertEqual(sk['ohne_variante'], 1)
        self.assertAlmostEqual(live[0]['R'], 2.0)
        # Backtest 10 min später, gleiche Richtung -> Match; zweiter Backtest-Trade bleibt „nur Backtest“
        d = tempfile.mkdtemp(); os.makedirs(os.path.join(d, 'nas-f618atr'))
        t0 = live[0]['t']
        json.dump(dict(period=dict(to='2026-12-31'), trades=[dict(dir='SELL', entryT=t0 + 600000, entry=101, exit=81, R=2.0), dict(dir='BUY', entryT=t0 + 3600000, entry=90, exit=95, R=0.5)]),
                  open(os.path.join(d, 'nas-f618atr', 'result.json'), 'w'))
        old = phase0.LIVE; phase0.LIVE = d
        try: res = phase0.compare(live)['nas-f618atr']
        finally: phase0.LIVE = old
        self.assertEqual((res['matched'], res['only_live'], res['only_backtest']), (1, 0, 1))
        self.assertAlmostEqual(res['match_rate'], 0.5)
        self.assertAlmostEqual(res['d_entry'], 1.0)
        self.assertEqual(res['status'], 'abgedeckt')

if __name__ == '__main__':
    unittest.main()
