"""FTMO-Regeln mit konstruierten Trade-Folgen prüfen.  Aufruf: python3 -m unittest discover -s test -p 'test_*.py'"""
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
from ftmo_lib import run_phase, challenge, to_days, week_blocks, summarize

T = lambda r, mae=None, span=0: (r, 1.0 if mae is None else mae, span)

class FtmoRegeln(unittest.TestCase):
    def test_tagesverlust_genau_5000_ist_verstoss(self):
        # zwei Verluste à 2.500 $ (2,5 % vom Startkapital) am selben Tag = genau 5.000 $ -> Verstoß
        res = run_phase([[T(-1), T(-1)]], 0, 2.5, 10, risk_mode='initial')
        self.assertEqual(res[0], 'fail_tag')

    def test_knapp_unter_5000_kein_verstoss(self):
        res = run_phase([[T(-1), T(-0.99, 0.99)]], 0, 2.5, 10, risk_mode='initial')
        self.assertEqual(res[0], 'offen')

    def test_reset_um_mitternacht(self):
        # je 4 % Verlust an zwei Tagen: kein Tagesverstoß, Gesamtverlust 8 % < 10 %
        res = run_phase([[T(-1)], [T(-1)]], 0, 4, 10, risk_mode='initial')
        self.assertEqual(res[0], 'offen')

    def test_offene_position_ueber_nacht(self):
        # Tag 1: Position (Risiko 4 %) offen über Nacht, Verlust am Tag 2 realisiert; Tag 2 weiterer Trade -2 %:
        # Saldo um 00:00 = 100 (Verlust noch offen) -> am Tag 2 -4 -2 = -6 -> Tagesverstoß
        days = [[T(-1, 1.0, 1)], [T(-0.5)]]
        res = run_phase(days, 0, 4, 10, risk_mode='initial')
        self.assertEqual(res[0], 'fail_tag')
        self.assertEqual(res[2], 1)

    def test_offener_verlust_intrabar_zaehlt(self):
        # Trade endet im Plus, war aber zwischendurch 1,3R im Minus bei 4 % Risiko -> 5,2 % offener Tagesverlust
        res = run_phase([[T(2.0, 1.3)]], 0, 4, 10, risk_mode='initial')
        self.assertEqual(res[0], 'fail_tag')

    def test_gesamtverlust_statisch(self):
        days = [[T(-1)], [T(-1)], [T(-1)], [T(-1)]]  # je 3 % -> nach Tag 4: -12 % (Tag 4 erreicht -10 %)
        res = run_phase(days, 0, 3, 10, risk_mode='initial')
        self.assertEqual(res[0], 'fail_gesamt')
        self.assertEqual(res[2], 3)

    def test_mindestens_4_handelstage(self):
        # +10 % am ersten Tag reicht nicht; bestanden erst nach dem 4. Handelstag
        days = [[T(10)], [T(0.1)], [], [T(0.1)], [T(0.1)]]
        res = run_phase(days, 0, 1, 10, risk_mode='initial')
        self.assertEqual(res[0], 'pass')
        self.assertEqual(res[2], 4)

    def test_phase2_frisches_konto(self):
        days = [[T(2.5)]] * 4 + [[T(1.25)]] * 4
        c = challenge(days, 0, 1, risk_mode='initial')
        self.assertEqual((c['p1'], c['p2']), ('pass', 'pass'))
        self.assertEqual((c['d1'], c['d2']), (4, 4))

    def test_to_days_und_wochenbloecke(self):
        tl = [dict(entry_date='2026-01-05', exit_date='2026-01-06', r=1, mae=0.2), dict(entry_date='2026-01-12', exit_date='2026-01-12', r=-1, mae=1)]
        dl = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12']
        d = to_days(tl, dl)
        self.assertEqual(d[0], [(1, 0.2, 1)])
        self.assertEqual(len(week_blocks(d, dl)), 2)

    def test_summary_quoten(self):
        res = [dict(p1='pass', p2='pass', days=10, d1=6, d2=4, min_eq=97), dict(p1='fail_tag', p2=None, days=3, d1=3, d2=None, min_eq=94),
               dict(p1='pass', p2='fail_gesamt', days=20, d1=8, d2=12, min_eq=90)]
        s = summarize(res)
        self.assertAlmostEqual(s['p1'], 2 / 3)
        self.assertAlmostEqual(s['p2'], 0.5)
        self.assertAlmostEqual(s['fail_tag'], 0.5)

if __name__ == '__main__':
    unittest.main()
