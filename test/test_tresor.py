"""Tests für tools/tresor.py."""
import os, sys, json, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import tresor as T


class Tresor(unittest.TestCase):
    def test_years(self):
        self.assertEqual(T.years('DE40'), {2014, 2017, 2020, 2023})
        self.assertIn(2008, T.years('EURUSD'))

    def test_drop(self):
        rows = [{'date': '2017-05-02'}, {'date': '2018-05-02'}, {'date': '2024-01-02'}]
        self.assertEqual([r['date'] for r in T.drop_sealed(rows, 'US100')], ['2018-05-02', '2024-01-02'])

    def test_open_needs_reason(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'p.jsonl')
            self.assertRaises(ValueError, T.open_tresor, 'DE40', 'kurz', path=p)
            T.open_tresor('DE40', 'Urteil Legacy-Bots, Kriterien siehe CLAUDE.md', ['de40-basis'], path=p)
            self.assertEqual(json.loads(open(p).read())['varianten'], ['de40-basis'])


if __name__ == '__main__':
    unittest.main()
