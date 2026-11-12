#!/usr/bin/env python3
"""Einheitliches Trade-Log (SQLite) aus den Live-Code-Backtests – Grundlage aller Analyse-Module (A–E).

Aufruf:  python3 tools/tradelog.py            -> out/tradelog/tradelog.sqlite
Analysen lesen nur dieses Log und ändern die Engine nicht.

Quelle: out/live/<id>/result.json (Original-Code-Nodes + Patch-Varianten). Kategorie:
  live      = Code-Node aus d_ilikebigbots / d_ftmo
  variante  = getestete Patch-Variante einer Live-Strategie (Katalog src/live/variants.js)
  kandidat  = neue Strategie (z. B. Sweep eu-sbf*) – eigener Bereich, bis sie ihre Basis schlägt
Kein Lookahead: alle Merkmale aus Kerzen, die zum Signalzeitpunkt geschlossen waren (Swings erst nach Bestätigung).
Reproduzierbar: Tabelle `runs` speichert Parameter, Kostenmodell, Datenstand (Dateien, Größe, Änderungszeit).
"""
import sqlite3, json, os, sys, bisect, datetime, hashlib, zoneinfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import konfluenz as K
import sessions as SESS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIVE_DIR = os.path.join(ROOT, 'out', 'live')
OUT_DIR = os.path.join(ROOT, 'out', 'tradelog')
DB = os.path.join(OUT_DIR, 'tradelog.sqlite')
BER = zoneinfo.ZoneInfo('Europe/Berlin')
LIVE_IDS = {s[0]: s for s in K.STRATS}
SYM_DIR = {'US100': 'us100', 'DE40': 'de40', 'EURUSD': 'eurusd'}
MFE_MAX_BARS = 3 * 288  # mfe_r_before_sl: höchstens 3 Tage verfolgen
IS_SHARE = 0.7

SCHEMA = """
CREATE TABLE trades (
  strategy TEXT, variant_id TEXT, category TEXT, workflow TEXT, base_id TEXT, instrument TEXT, direction TEXT,
  signal_time TEXT, entry_time TEXT, exit_time TEXT, entry REAL, sl REAL, tp REAL, exit_price REAL, exit_reason TEXT,
  bars_held INTEGER, session TEXT, weekday INTEGER, hour INTEGER, is_news_day INTEGER, sample TEXT, trade_date TEXT, exit_date TEXT,
  r_gross REAL, cost_spread_r REAL, cost_commission_r REAL, cost_slippage_r REAL, cost_swap_r REAL, r_net REAL,
  mfe_r REAL, mae_r REAL, mfe_r_before_sl REAL,
  atr_pct REAL, vol_regime TEXT, adx REAL, htf_bias INTEGER,
  k1_ma_band INTEGER, k2_retest INTEGER, k3_impulse INTEGER, conf_score INTEGER, wick_gap_atr REAL,
  swept_before_tp INTEGER, stopped_then_target_hit INTEGER, sweep_entry_r_alt REAL,
  risk_pts REAL, size REAL, risk_money REAL, overnight_nights INTEGER
);
CREATE TABLE variants (variant_id TEXT PRIMARY KEY, name TEXT, category TEXT, workflow TEXT, base_id TEXT, instrument TEXT,
  period_from TEXT, period_to TEXT, is_cut TEXT, n_trades INTEGER, risk_percent REAL);
CREATE TABLE runs (created TEXT, params TEXT, costs TEXT, data_files TEXT, engine_results TEXT);
CREATE INDEX ix_trades_variant ON trades(variant_id);
"""

def ber(ms): return datetime.datetime.fromtimestamp(ms / 1000, BER)
def iso(ms): return ber(ms).isoformat(timespec='seconds') if ms else None

def session_of(sym, sb):
    """Tagesabschnitt eines Signals (sb = Berlin-datetime). Eröffnungen aus config/sessions.yaml (DST-sicher je Datum)."""
    t = sb.hour * 60 + sb.minute
    def at(epic, which='open', name=None):  # Session-Uhrzeit dieses Datums in Berlin-Minuten
        w = SESS.session_utc(epic, sb.date(), name, any_day=True)
        x = (w[0] if which == 'open' else w[1]).astimezone(BER); return x.hour * 60 + x.minute
    ny = at('US100')
    if sym == 'US100': return 'EU' if t < ny else ('US-Eröffnung' if t < ny + 90 else 'US')
    if sym == 'DE40':
        xo = at('DE40'); return 'Eröffnung' if t < xo + 90 else ('Vormittag' if t < xo + 240 else ('Mittag' if t < ny else 'US-Eröffnung'))
    nyo, lc = at('EURUSD', 'open', 'newyork'), at('EURUSD', 'close', 'london')
    return 'London' if t < nyo else ('Überschneidung' if t < lc else 'New York')


def category(vid, r):
    if vid in LIVE_IDS: return 'live'
    if vid.startswith('eu-sbf'): return 'kandidat'
    return 'variante'

def root_live(vid, results):
    seen = set(); b = vid
    while b and b not in LIVE_IDS and b not in seen:
        seen.add(b); b = (results.get(b) or {}).get('base')
    return b if b in LIVE_IDS else None

# ---------------------------------------------------------------- Kerzen (Bid/Ask für Exkursionen, Tages-ATR für Regime)
def load_bidask(sym):
    import csv
    d = os.path.join(ROOT, 'data', 'raw', SYM_DIR[sym]); rows = {}
    for f in sorted(os.listdir(d)):
        if 'MINUTE_5_' not in f or not f.endswith('.csv'): continue
        with open(os.path.join(d, f)) as fh:
            rd = csv.reader(fh); next(rd)
            for x in rd:
                try:
                    t = int(datetime.datetime.strptime(x[0][:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)
                    rows[t] = tuple(float(y) for y in x[1:9])
                except (ValueError, IndexError): continue
    items = sorted(rows.items())
    return [t for t, _ in items], [v for _, v in items]  # v = bo,bh,bl,bc,ao,ah,al,ac

def daily_atr_pct(times, vals):
    """Je Berlin-Datum: ATR14 der VORTAGE und dessen Perzentil unter den letzten 250 Tageswerten (ohne Lookahead)."""
    days = {}
    for t, v in zip(times, vals):
        d = ber(t).date().isoformat(); h, l, c = (v[1] + v[5]) / 2, (v[2] + v[6]) / 2, (v[3] + v[7]) / 2
        if d not in days: days[d] = [h, l, c]
        else: x = days[d]; x[0] = max(x[0], h); x[1] = min(x[1], l); x[2] = c
    ds = sorted(days); out = {}; atr = None; hist = []; prev_c = None
    for d in ds:
        out[d] = None if atr is None else (atr, sum(1 for a in hist[-250:] if a <= atr) / len(hist[-250:]) if hist else None)
        h, l, c = days[d]
        tr = h - l if prev_c is None else max(h - l, abs(h - prev_c), abs(l - prev_c))
        atr = tr if atr is None else (atr * 13 + tr) / 14
        hist.append(atr); prev_c = c
    return out

def vol_regime(p):
    if p is None: return None
    return 'ruhig' if p < 0.25 else ('mittel' if p < 0.75 else ('hoch' if p < 0.95 else 'extrem'))

def adx_series(fr, n=14):
    out = [None] * len(fr.c); trs = pd = md = 0.0; dx = []; adx = None
    for i in range(1, len(fr.c)):
        tr = max(fr.h[i] - fr.l[i], abs(fr.h[i] - fr.c[i - 1]), abs(fr.l[i] - fr.c[i - 1]))
        up, dn = fr.h[i] - fr.h[i - 1], fr.l[i - 1] - fr.l[i]
        p = up if up > dn and up > 0 else 0; m = dn if dn > up and dn > 0 else 0
        if i <= n: trs += tr; pd += p; md += m
        else: trs = trs - trs / n + tr; pd = pd - pd / n + p; md = md - md / n + m
        if i < n: continue
        pi = 100 * pd / trs if trs else 0; mi = 100 * md / trs if trs else 0
        x = 100 * abs(pi - mi) / (pi + mi) if pi + mi else 0
        if adx is None:
            dx.append(x)
            if len(dx) == n: adx = sum(dx) / n
        else: adx = (adx * (n - 1) + x) / n
        out[i] = adx
    return out

def excursions(times, vals, t):
    """mfe_r_before_sl (bis SL, ohne TP, max. 3 Tage), stopped_then_target_hit, swept_before_tp (Swing-Level vor Exit unterschritten)."""
    i0 = bisect.bisect_left(times, t['entryT'])
    if i0 >= len(times): return None, None
    long = t['dir'] == 'BUY'; e, sl, tp, rp = t['entry'], t['stop'], t.get('tp'), t['riskPts'] or abs(t['entry'] - t['stop'])
    mfe = 0.0; hit_sl = None
    for j in range(i0, min(len(times), i0 + MFE_MAX_BARS)):
        v = vals[j]
        lo, hi = (v[2], v[1]) if long else (v[6], v[5])  # Long: Bid-Seite, Short: Ask-Seite
        mfe = max(mfe, (hi - e) if long else (e - lo))
        if (lo <= sl) if long else (hi >= sl): hit_sl = j; break
    # Stop-Hunt: nach dem SL-Ausstieg erreicht der Kurs noch am selben Handelstag (Berlin) das TP-Level
    stopped_then_tp = None
    if tp and t['reason'].startswith('SL') and t.get('exitT'):
        stopped_then_tp = 0
        j = bisect.bisect_left(times, t['exitT']); day = ber(t['exitT']).date()
        while j < len(times) and ber(times[j]).date() == day:
            v = vals[j]
            if (v[1] >= tp) if long else (v[6] <= tp): stopped_then_tp = 1; break
            j += 1
    return (mfe / rp if rp else None), stopped_then_tp

def file_state():
    out = []
    for sym, d in SYM_DIR.items():
        p = os.path.join(ROOT, 'data', 'raw', d)
        for f in sorted(os.listdir(p)):
            if f.endswith('.csv'):
                st = os.stat(os.path.join(p, f)); out.append(dict(file=f'{d}/{f}', size=st.st_size, mtime=datetime.datetime.fromtimestamp(st.st_mtime).isoformat(timespec='seconds')))
    return out

def build():
    os.makedirs(OUT_DIR, exist_ok=True)
    costs = json.load(open(os.path.join(ROOT, 'config', 'kosten.json')))
    results = {}
    for vid in sorted(os.listdir(LIVE_DIR)):
        p = os.path.join(LIVE_DIR, vid, 'result.json')
        if os.path.isfile(p): results[vid] = json.load(open(p))
    if os.path.exists(DB): os.remove(DB)
    con = sqlite3.connect(DB); con.executescript(SCHEMA)
    cache = {}
    for sym in SYM_DIR:
        times, vals = load_bidask(sym)
        m5 = [(t, ((v[0] + v[4]) / 2, (v[1] + v[5]) / 2, (v[2] + v[6]) / 2, (v[3] + v[7]) / 2, 0.0)) for t, v in zip(times, vals)]
        fr = K.Frame(K.aggregate(m5, K.M15), K.M15)
        cache[sym] = dict(times=times, vals=vals, fr=fr, h1=K.Frame(K.aggregate(m5, 3600000), 3600000), h4=K.Frame(K.aggregate(m5, 4 * 3600000), 4 * 3600000),
                          adx=adx_series(fr), datr=daily_atr_pct(times, vals))
        print(sym, len(times), 'M5-Kerzen')
    for vid, r in results.items():
        sym = r.get('symbol')
        if sym not in cache: continue
        C = cache[sym]; cat = category(vid, r); base = root_live(vid, results)
        wf = LIVE_IDS[base][3] if base else None
        cfg = costs[sym]
        a, b = r['period']['from'], r['period']['to']
        da, db = datetime.date.fromisoformat(a), datetime.date.fromisoformat(b)
        cut = (da + (db - da) * IS_SHARE).isoformat()
        con.execute('INSERT INTO variants VALUES (?,?,?,?,?,?,?,?,?,?,?)', (vid, r['name'], cat, wf, base, sym, a, b, cut, len(r['trades']), r['engine'].get('riskPercent')))
        rows = []
        for t in r['trades']:
            if t.get('R') is None: continue
            f = K.features(t, C['fr'], C['h1'], C['h4']) or {}
            sig = f.get('T') or t['entryT']
            sb = ber(sig); i = C['fr'].last_closed(sig) if f else -1
            rp = t.get('riskPts') or abs(t['entry'] - t['stop'])
            size, risk_money = t.get('size') or 0, t.get('riskMoney') or 0
            spread = t.get('spreadEntry') or 0
            c_spread = spread / rp if rp else 0
            c_slip = cfg['slippage_pts'] * 2 / rp if rp else 0
            c_comm = (cfg['commission_per_lot'] * size * 2 / risk_money) if risk_money else 0
            nights = max(0, (ber(t['exitT']).date() - ber(t['entryT']).date()).days) if t.get('exitT') else 0
            swap_pts = 0.0
            if nights:
                d = ber(t['entryT']).date()
                for k in range(nights):
                    swap_pts += cfg['swap_pts_per_night'] * (3 if (d + datetime.timedelta(days=k)).isoweekday() == costs['triple_swap_weekday'] else 1)
            c_swap = swap_pts / rp if rp else 0
            r_net = t['R'] - c_comm - c_slip - c_swap
            r_gross = r_net + c_spread + c_comm + c_slip + c_swap
            mfe_b, stp = excursions(C['times'], C['vals'], t)
            dk = sb.date().isoformat(); da_ = C['datr'].get(dk)
            atr_pct = da_[1] if da_ else None
            k1, k2, k3 = f.get(K.DEF['K1']), f.get(K.DEF['K2']), f.get(K.DEF['K3'])
            wick = None
            if f and i >= 0:
                fr = C['fr']; wick = (abs(t['entry'] - (fr.l[i] if t['dir'] == 'BUY' else fr.h[i])) / f['atr']) if f.get('atr') else None
            rows.append((r['name'], vid, cat, wf, base, sym, t['dir'], iso(sig), iso(t['entryT']), iso(t.get('exitT')), t['entry'], t['stop'], t.get('tp'), t.get('exit'), t.get('reason'),
                         t.get('barsHeld'), session_of(sym, sb), sb.isoweekday(), sb.hour, None, 'IS' if t['date'] < cut else 'OOS', t['date'], t.get('exitDate'),
                         r_gross, c_spread, c_comm, c_slip, c_swap, r_net, t.get('mfeR'), t.get('maeR'), mfe_b,
                         atr_pct, vol_regime(atr_pct), C['adx'][i] if i >= 0 else None, f.get('Z1_H4'),
                         k1, k2, k3, (k1 + k2 + k3) if None not in (k1, k2, k3) else None, wick,
                         None, stp, None, rp, size, risk_money, nights))
        con.executemany('INSERT INTO trades VALUES (' + ','.join('?' * 48) + ')', rows)
        print(f'{vid:24s} {cat:9s} {len(rows):5d} Trades')
    con.execute('INSERT INTO runs VALUES (?,?,?,?,?)', (datetime.datetime.now().isoformat(timespec='seconds'),
        json.dumps(dict(is_share=IS_SHARE, mfe_max_bars=MFE_MAX_BARS, konfluenz=K.DEF, swing='Fraktal 2/2, bestätigt nach 2 Kerzen', atr='ATR14 M15 Wilder')),
        json.dumps(costs), json.dumps(file_state()), json.dumps({v: r.get('generatedAt') or os.path.getmtime(os.path.join(LIVE_DIR, v, 'result.json')) for v, r in results.items()})))
    con.commit(); con.close()
    print('geschrieben', DB)

if __name__ == '__main__':
    build()
