"""Session-Tabelle (Python-Leser, zoneinfo). Aufruf: python3 -m unittest discover -s test -p 'test_*.py'"""
import os, sys, unittest, datetime
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import sessions as S

BER = ZoneInfo('Europe/Berlin')
def ny_open_berlin(d): return S.session_utc('US100', d, any_day=True)[0].astimezone(BER).strftime('%H:%M')

class Sessions(unittest.TestCase):
    def test_dst_sonderwochen_ny_1430_berlin(self):
        for d in ('2025-03-10', '2025-03-28', '2026-03-09', '2026-03-27', '2025-10-27', '2025-10-31', '2026-10-26', '2026-10-30'):
            self.assertEqual(ny_open_berlin(d), '14:30', d)
        for d in ('2025-03-31', '2026-03-31', '2026-10-23', '2026-11-02', '2026-07-15', '2026-01-15'):
            self.assertEqual(ny_open_berlin(d), '15:30', d)

    def test_wochenende_und_feiertag_keine_session(self):
        self.assertIsNone(S.session_utc('US100', '2026-11-07'))  # Samstag
        self.assertIsNone(S.session_utc('DE40', '2026-11-08'))   # Sonntag
        self.assertIsNone(S.session_utc('US100', '2026-11-26'))  # Thanksgiving
        self.assertIsNone(S.session_utc('DE40', '2026-12-24'))
        self.assertTrue(S.is_trading_day('DE40', '2026-11-26'))

    def test_fx_zwei_sessions_und_ausschluesse(self):
        lo = S.session_utc('EURUSD', '2026-07-01', 'london'); ny = S.session_utc('EURUSD', '2026-07-01', 'newyork')
        self.assertEqual((lo[0].hour, ny[0].hour, ny[0].minute), (6, 12, 30))  # 07:00 London BST, 08:30 NY EDT
        self.assertIn('EURUSD/newyork', S.orb_vwap_excluded())
        ex = S.orb_vwap_excluded()
        self.assertIn('BTCUSD', ex)
        self.assertIsNone(S.stock_home('XYZ', ''))
        self.assertEqual(S.stock_home('AAPL', 'Apple Inc')['calendar'], 'XNYS')

class CapitalHours(unittest.TestCase):
    def test_openinghours_und_abdeckung(self):
        import capital_hours as C
        oh = {d: ['00:00 - 21:00', '22:05 - 00:00'] for d in ('mon', 'tue', 'wed', 'thu')}
        oh.update(fri=['00:00 - 21:00'], sat=[], sun=['22:05 - 00:00'], zone='UTC')
        h = C.parse_hours(oh)
        self.assertEqual(h['days']['mon'], [(0, 1260), (1325, 1440)])
        cov = C.covered(h, 'US100', 'cash', datetime.date(2026, 3, 9))  # DST-Sonderwoche: 13:30–20:00 UTC
        self.assertTrue(all(cov.values()))
        h['days']['wed'] = [(0, 840)]  # Mittwoch nur bis 14:00 UTC -> Lücke
        self.assertFalse(C.covered(h, 'US100', 'cash', datetime.date(2026, 3, 9))['wed'])

if __name__ == '__main__':
    unittest.main()
