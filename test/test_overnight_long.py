"""Overnight lange Historie: Renditen je Tag, Wochenend-Nächte, Finanzierung, SMA-Bedingung ohne Lookahead."""
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import overnight_long as O

def row(d, o, c, ok=True): return dict(date=d, open=o, high=max(o, c) + 1, low=min(o, c) - 1, close=c, open_ok=ok)

class T(unittest.TestCase):
    def test_series_und_varianten(self):
        rows = [row('2025-03-06', 100, 100), row('2025-03-07', 101, 101), row('2025-03-10', 103, 102), row('2025-03-11', 50, 50, ok=False), row('2025-03-12', 51, 52)]
        sr = O.series(rows)
        self.assertEqual([d['date'] for d in sr], ['2025-03-07', '2025-03-10', '2025-03-12'])  # Tag ohne brauchbare Eröffnung fehlt
        self.assertAlmostEqual(sr[0]['on'], 1.0); self.assertAlmostEqual(sr[1]['on'], (103 / 101 - 1) * 100)
        self.assertEqual([d['n'] for d in sr], [1, 3, 1])  # Freitag -> Montag = 3 Nächte
        self.assertAlmostEqual(sr[1]['id'], (102 / 103 - 1) * 100)
        self.assertFalse(any(d['sma'] for d in sr))  # < 200 Schlusskurse
        xs, ds = O.variant(sr, 'ON', 0.01, 'EUR', 3.65)
        self.assertAlmostEqual(xs[1], sr[1]['on'] - 0.01 - 3.65 * 3 / 365)
        xs, ds = O.variant(sr, 'ON-WT', 0, 'EUR', 0)
        self.assertEqual(ds, ['2025-03-07', '2025-03-12'])
        self.assertAlmostEqual(O.fin_rate('hist', 'USD', 2024), 5.1 + O.MARKUP)
        self.assertAlmostEqual(O.fin_rate('rf', 'USD', 2024), 5.1)

    def test_sma_nur_aus_vortagen(self):
        import datetime
        d0 = datetime.date(2020, 1, 1); rows = []
        for i in range(205):
            d = (d0 + datetime.timedelta(days=i)).isoformat(); rows.append(row(d, 100 + i, 100 + i))
        sr = O.series(rows)
        self.assertTrue(sr[-1]['sma'])  # steigende Reihe: Vortagesschluss > SMA200
        self.assertFalse(sr[197]['sma'])  # erst ab 200 Vortagesschlüssen

if __name__ == '__main__':
    unittest.main()
