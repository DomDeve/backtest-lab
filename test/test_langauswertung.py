"""Tests für tools/langauswertung.py."""
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import langauswertung as LA


class T(unittest.TestCase):
    def test_summary(self):
        tr = [{'date': '2016-03-01', 'entryT': 1, 'R': -1.0}, {'date': '2018-03-01', 'entryT': 2, 'R': 2.0}, {'date': '2018-04-01', 'entryT': 3, 'R': 1.0}]
        s = LA.summarize(tr)
        self.assertEqual(s['n'], 3); self.assertEqual(s['pos_years'], 1); self.assertEqual(s['n_years'], 2)
        self.assertAlmostEqual(s['avg_ohne_1517'], 1.5)       # 2016 (ohne Nachtkurse) für Indizes herausgerechnet
        self.assertAlmostEqual(LA.summarize(tr, index=False)['avg_ohne_1517'], 2 / 3)


if __name__ == '__main__':
    unittest.main()
