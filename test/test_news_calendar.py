"""Tests für tools/news_calendar.py (Rohzeilen -> Kalender, Sperrfenster, News-Tage)."""
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import news_calendar as N

NFP = 1433507400  # 05.06.2015 12:30 UTC
RAW = [[1, 9, NFP, 'USD', 'high', 'US Non-Farm Employment Change', '280K', '226K', '221K', '', '2:30pm', False],
       [2, 9, NFP, 'USD', 'high', 'US Unemployment Rate', '5.5%', '5.4%', '5.4%', '', '', False],      # leere Zeit = wie davor
       [3, 9, NFP - 3600 * 12, 'EUR', 'holiday', 'IT Bank Holiday', '', '', '', '', 'All Day', False],
       [4, 9, NFP + 3600, 'EUR', 'medium', 'GE Prelim CPI m/m', '0.1%', '', '', '', 'Tentative', True]]


class T(unittest.TestCase):
    def test_rows(self):
        r = N.rows_from_raw(RAW)
        self.assertEqual(r[0]['utc'], '2015-06-05T12:30:00Z')
        self.assertEqual([x['exact_time'] for x in r], [1, 1, 0, 0])

    def test_blocked(self):
        times = N.news_times(N.rows_from_raw(RAW), 'US100')
        self.assertEqual(times, [NFP])
        self.assertTrue(N.blocked(NFP - 120, times)); self.assertTrue(N.blocked(NFP + 120, times))
        self.assertFalse(N.blocked(NFP - 121, times)); self.assertFalse(N.blocked(NFP + 121, times))
        self.assertEqual(N.news_times(N.rows_from_raw(RAW), 'DE40'), [])  # USD-Termin sperrt DE40 nicht

    def test_days(self):
        rows = N.rows_from_raw(RAW)
        self.assertEqual(N.news_days(rows, 'DE40', ('holiday',)), {'2015-06-05'})
        self.assertEqual(N.news_days(rows, 'EURUSD'), {'2015-06-05'})


if __name__ == '__main__':
    unittest.main()
