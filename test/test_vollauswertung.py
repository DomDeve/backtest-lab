"""Hold-out-Trennung: Selektionszeitraum je Symbol, davor und danach = Hold-out."""
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import vollauswertung as V

class T(unittest.TestCase):
    def test_seg(self):
        tr = [dict(date='2024-03-01', R=1), dict(date='2024-09-02', R=-1), dict(date='2026-10-13', R=2), dict(date='2026-10-20', R=-1)]
        s = V.seg(tr, 'US100')
        self.assertEqual((s['pre']['n'], s['sel']['n'], s['post']['n'], s['hold']['n']), (1, 2, 1, 2))
        self.assertAlmostEqual(s['hold']['avg'], 0.0); self.assertAlmostEqual(s['sel']['avg'], 0.5)
        s = V.seg(tr, 'DE40')  # DE40: Selektion ab 02.01.2024
        self.assertEqual((s['pre']['n'], s['sel']['n'], s['post']['n']), (0, 3, 1))

if __name__ == '__main__':
    unittest.main()
