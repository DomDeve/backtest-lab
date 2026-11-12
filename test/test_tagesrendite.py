"""Tests für tools/tagesrendite.py."""
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import tagesrendite as TR


class T(unittest.TestCase):
    def test_daily(self):
        tr = [{'exitDate': '2025-03-03', 'R': 1.0}, {'exitDate': '2025-03-03', 'R': -0.5}, {'exitDate': '2025-03-05', 'R': -2.0}]
        r = TR.daily_returns(tr, 0.5, '2025-03-01', '2025-03-07')  # Sa/So nicht dabei, Risiko 0,5 % je Trade
        self.assertEqual([d for d, _ in r], ['2025-03-03', '2025-03-04', '2025-03-05', '2025-03-06', '2025-03-07'])
        self.assertAlmostEqual(r[0][1], 0.25); self.assertEqual(r[1][1], 0.0); self.assertAlmostEqual(r[2][1], -1.0)

    def test_stats(self):
        s = TR.stats([('2025-01-0%d' % i, v) for i, v in enumerate([1, -5, 2, 0], 1)])
        self.assertEqual(s['days_le5'], 1); self.assertEqual(s['active_days'], 3); self.assertAlmostEqual(s['worst'], -5)
        self.assertLess(s['maxdd'], -4.9)


if __name__ == '__main__':
    unittest.main()
