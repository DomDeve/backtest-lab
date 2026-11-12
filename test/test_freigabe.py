"""Tests für tools/freigabe.py: Quellen je Kandidat überschreiben die globalen Quellen."""
import os, sys, json, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import freigabe as F

K = dict(coinflip_p=0.05, auswahl_p=0.05, plateau_min_anteil=0.5, tage_t=2.0, tag_schlechtester_pct=-4.0)


class T(unittest.TestCase):
    def test_quellen_je_kandidat(self):
        with tempfile.TemporaryDirectory() as d:
            w = lambda n, o: (json.dump(o, open(os.path.join(d, n), 'w')), os.path.join(d, n))[1]
            g_cf = w('cf_global.json', {'results': [{'id': 'x', 'p': 0.5}]})
            k_cf = w('cf_review.json', {'results': [{'id': 'x', 'p': 0.01}]})
            k_sel = w('sel.json', {'markets': {'m': {'nVariants': 3, 'variants': [{'id': 'x', 'pSel': 0.2}]}}})
            k_td = w('td.json', {'x': {'t': 2.5, 'half1': 0.01, 'half2': 0.02, 'worst': -4.3}})
            src = {'coinflip': g_cf, 'auswahl': g_cf, 'tage': g_cf}
            c = {'id': 'x', 'markt': 'm', 'plateau': None, 'tresor': None, 'forward': None}
            self.assertFalse(F.check(c, K, src)['K1 Coinflip'][0])          # global: p 0,5
            r = F.check(dict(c, quellen={'coinflip': k_cf, 'auswahl': k_sel, 'tage': k_td}), K, src)
            self.assertTrue(r['K1 Coinflip'][0])                            # Kandidat: p 0,01
            self.assertFalse(r['K2 Auswahl'][0])                            # p 0,2
            self.assertFalse(r['K4 Tage'][0])                               # schlechtester Tag −4,3 %
            self.assertIn('kein Lauf', F.check(c, K, src)['K4 Tage'][1])     # globale Quelle unverändert


if __name__ == '__main__':
    unittest.main()
