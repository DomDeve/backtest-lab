#!/usr/bin/env python3
"""Konfluenz-Analyse („Multi-Edge“) für die Live-Strategien aus d_ilikebigbots und d_ftmo.

Aufruf:  python3 tools/konfluenz.py   -> out/konfluenz/report.html (+ archiv.html, features.json, ergebnis.json)

Grundlage: Backtest-Trades der Live-Code-Engine (out/live/<id>/result.json, Original-Code, nicht neu gerechnet).
Zu jedem Trade werden zum Signalzeitpunkt Merkmale auf M15 berechnet – nur aus Kerzen, die da schon geschlossen
waren; Fraktal-Swings (2 Kerzen links/rechts) erst ab ihrer Bestätigung (2 Kerzen nach dem Swing).
Signalzeitpunkt = Einstiegszeit - Wartezeit bis zur Füllung (Limit) bzw. = Einstiegszeit (Market), auf das 5-Min-Raster.
Toleranzen ATR-normalisiert (ATR14 M15, Wilder). Filter = nur Trades mit Merkmal behalten (keine Folgeeffekte).

Merkmale: K1 MA-Band (EMA20/SMA20 ± w·ATR), K2 Retest eines gebrochenen Swing-Levels (± t·ATR, letzte N Swings),
K3 Impuls vor dem Rücksetzer >= k·ATR. Zusätzlich Z1 H1/H4-EMA50-Richtung, Z2 Volumen Rücksetzer/Impuls,
Z3 Abstand zum nächsten Konfluenz-Level (ATR), Z4 Stunde/Wochentag.
"""
import csv, json, math, os, random, bisect, datetime, collections, html

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIVE = os.path.join(ROOT, 'out', 'live')
OUT = os.path.join(ROOT, 'out', 'konfluenz')
STRATS = [  # (id, Name, Symbol, Workflow)
    ('nas-f618atr', 'NAS F618ATR', 'US100', 'd_ilikebigbots'), ('nas-fib50-lb2', 'NAS Fib50 LB2', 'US100', 'd_ilikebigbots'),
    ('nas-fib50-lb3', 'NAS Fib50 LB3', 'US100', 'd_ilikebigbots'), ('nas-fib61-lb1', 'NAS Fib61 LB1', 'US100', 'd_ilikebigbots'),
    ('nas-fib61-lb2', 'NAS Fib61 LB2', 'US100', 'd_ilikebigbots'), ('nas-fib61-lb3', 'NAS Fib61 LB3', 'US100', 'd_ilikebigbots'),
    ('ftmo-basis', 'NAS F618ATR FTMO', 'US100', 'd_ftmo'),
    ('de40-basis', 'DE40 LVN Basis', 'DE40', 'd_ilikebigbots'), ('de40-confl3', 'DE40 LVN Confluence 3', 'DE40', 'd_ilikebigbots'),
    ('de40-dist150', 'DE40 LVN Distance 150', 'DE40', 'd_ilikebigbots'), ('de40-q07', 'DE40 LVN Quality 0.7', 'DE40', 'd_ilikebigbots'),
    ('de40-adx25', 'DE40 LVN ADX 25', 'DE40', 'd_ilikebigbots'), ('de40-combo', 'DE40 LVN Combo', 'DE40', 'd_ilikebigbots'),
    ('eu-c1', 'EURUSD C1', 'EURUSD', 'd_ilikebigbots'), ('eu-c2', 'EURUSD C2', 'EURUSD', 'd_ilikebigbots'), ('eu-c3', 'EURUSD C3', 'EURUSD', 'd_ilikebigbots'),
    ('eu-c4', 'EURUSD C4', 'EURUSD', 'd_ilikebigbots'), ('eu-c5', 'EURUSD C5', 'EURUSD', 'd_ilikebigbots'), ('eu-c6', 'EURUSD C6', 'EURUSD', 'd_ilikebigbots'),
]
DIRS = {'US100': 'data/raw/us100', 'DE40': 'data/raw/de40', 'EURUSD': 'data/raw/eurusd'}
M15 = 900000

# ---------------------------------------------------------------- Kerzen
def load_m5(sym):
    d = os.path.join(ROOT, DIRS[sym]); rows = {}
    for f in sorted(os.listdir(d)):
        if 'MINUTE_5_' not in f or not f.endswith('.csv'): continue
        with open(os.path.join(d, f)) as fh:
            r = csv.reader(fh); next(r)
            for x in r:
                try:
                    t = int(datetime.datetime.strptime(x[0][:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)
                    v = [float(y) for y in x[1:9]]
                    rows[t] = ((v[0] + v[4]) / 2, (v[1] + v[5]) / 2, (v[2] + v[6]) / 2, (v[3] + v[7]) / 2, float(x[9]) if len(x) > 9 and x[9] else 0.0)
                except (ValueError, IndexError): continue
    return sorted(rows.items())

def aggregate(m5, ms):
    out = []
    for t, (o, h, l, c, v) in m5:
        k = t - t % ms
        if out and out[-1][0] == k:
            b = out[-1]; b[2] = max(b[2], h); b[3] = min(b[3], l); b[4] = c; b[5] += v
        else: out.append([k, o, h, l, c, v])
    return out

def ema(vals, n):
    k = 2 / (n + 1); out = []; e = None
    for x in vals: e = x if e is None else x * k + e * (1 - k); out.append(e)
    return out

class Frame:
    def __init__(self, bars, ms):
        self.ms = ms; self.t = [b[0] for b in bars]; self.o = [b[1] for b in bars]; self.h = [b[2] for b in bars]
        self.l = [b[3] for b in bars]; self.c = [b[4] for b in bars]; self.v = [b[5] for b in bars]
        n = len(bars)
        self.ema20 = ema(self.c, 20); self.ema50 = ema(self.c, 50)
        self.sma20 = [None] * n; s = 0
        for i in range(n):
            s += self.c[i]
            if i >= 20: s -= self.c[i - 20]
            if i >= 19: self.sma20[i] = s / 20
        self.atr = [None] * n; a = None
        for i in range(1, n):
            tr = max(self.h[i] - self.l[i], abs(self.h[i] - self.c[i - 1]), abs(self.l[i] - self.c[i - 1]))
            a = tr if a is None else (a * 13 + tr) / 14
            if i >= 14: self.atr[i] = a
        # Fraktal-Swings (2 links, 2 rechts), bestätigt bei i+2; Bruch = erster Schluss jenseits danach
        self.sh, self.sl = [], []
        for i in range(2, n - 2):
            if all(self.h[i] > self.h[j] for j in (i - 2, i - 1, i + 1, i + 2)):
                brk = next((j for j in range(i + 3, min(n, i + 2000)) if self.c[j] > self.h[i]), None)
                self.sh.append((i, self.h[i], brk))
            if all(self.l[i] < self.l[j] for j in (i - 2, i - 1, i + 1, i + 2)):
                brk = next((j for j in range(i + 3, min(n, i + 2000)) if self.c[j] < self.l[i]), None)
                self.sl.append((i, self.l[i], brk))
        self.sh_i = [s[0] for s in self.sh]; self.sl_i = [s[0] for s in self.sl]

    def last_closed(self, T):
        return bisect.bisect_right(self.t, T - self.ms) - 1

# ---------------------------------------------------------------- Merkmale je Trade
def features(tr, fr, h1, h4):
    wait = (tr['features'] or {}).get('post_waitMin') or 0
    T = tr['entryT'] - wait * 60000
    T = T - T % 300000 + 10000  # Cron-Lauf ~10 s nach Kerzenschluss
    i = fr.last_closed(T)
    if i < 60 or fr.atr[i] is None: return None
    atr = fr.atr[i]; e = tr['entry']; long = tr['dir'] == 'BUY'
    f = {'T': T, 'atr': atr}
    lo, hi = min(fr.ema20[i], fr.sma20[i]), max(fr.ema20[i], fr.sma20[i])
    for w in (0.1, 0.25, 0.5): f[f'K1_{w}'] = int(lo - w * atr <= e <= hi + w * atr)
    # K2: gebrochene Swing-Levels (Long: alte Hochs, per Schluss überschritten), nur bestätigt bis i
    sw, idx = (fr.sh, fr.sh_i) if long else (fr.sl, fr.sl_i)
    k = bisect.bisect_right(idx, i - 2)  # bestätigt: Swing-Index + 2 <= i
    levels = {}
    for N in (5, 10):
        levels[N] = [p for (_, p, b) in sw[max(0, k - N):k] if b is not None and b <= i]
    for N in (5, 10):
        for t in (0.2, 0.3, 0.5): f[f'K2_{t}_{N}'] = int(any(abs(e - p) <= t * atr for p in levels[N]))
    # K3: Impuls letzter Gegen-Swing -> Extrem bis i, in Trade-Richtung
    sw2, idx2 = (fr.sl, fr.sl_i) if long else (fr.sh, fr.sh_i)
    k2 = bisect.bisect_right(idx2, i - 2)
    imp = None; ext_i = None; s_i = None
    if k2:
        s_i, s_p, _ = sw2[k2 - 1]
        rng = range(s_i, i + 1)
        ext_i = max(rng, key=lambda j: fr.h[j]) if long else min(rng, key=lambda j: fr.l[j])
        imp = (fr.h[ext_i] - s_p) if long else (s_p - fr.l[ext_i])
    for kk in (0.5, 1.0, 1.5, 2.0): f[f'K3_{kk}'] = int(imp is not None and imp >= kk * atr)
    f['imp_atr'] = imp / atr if imp is not None else None
    # Z1: Richtung EMA50 auf H1 / H4 (letzte geschlossene Kerze vs. Vorkerze)
    for name, F in (('H1', h1), ('H4', h4)):
        j = F.last_closed(T)
        up = F.ema50[j] > F.ema50[j - 1] if j > 50 else None
        f[f'Z1_{name}'] = None if up is None else int(up == long)
    # Z2: Volumen Rücksetzer / Impuls
    f['Z2'] = None
    if ext_i is not None and ext_i < i:
        vp = [fr.v[j] for j in range(ext_i + 1, i + 1)]; vi = [fr.v[j] for j in range(s_i, ext_i + 1)]
        if vi and sum(vi) > 0 and vp: f['Z2'] = (sum(vp) / len(vp)) / (sum(vi) / len(vi))
    # Z3: Abstand zum nächsten Konfluenz-Level (EMA20, SMA20, gebrochene Swings N=10) in ATR
    cands = [fr.ema20[i], fr.sma20[i]] + levels[10]
    f['Z3'] = min(abs(e - p) for p in cands) / atr
    return f

# ---------------------------------------------------------------- Statistik
mean = lambda v: sum(v) / len(v) if v else float('nan')
def basic(R):
    n = len(R)
    if not n: return dict(n=0)
    gp = sum(r for r in R if r > 0); gl = -sum(r for r in R if r < 0)
    run = mx = 0
    for r in R: run = run + 1 if r < 0 else 0; mx = max(mx, run)
    return dict(n=n, win=sum(1 for r in R if r > 0) / n, exp=mean(R), pf=gp / gl if gl else None, streak=mx)

def boot_ci(R, rnd, B=1000):
    if len(R) < 2: return (None, None, None, None)
    ms, ws = [], []
    n = len(R)
    for _ in range(B):
        s = [R[rnd.randrange(n)] for _ in range(n)]
        ms.append(mean(s)); ws.append(sum(1 for r in s if r > 0) / n)
    ms.sort(); ws.sort()
    return (ws[int(.025 * B)], ws[int(.975 * B) - 1], ms[int(.025 * B)], ms[int(.975 * B) - 1])

def random_control(R, rnd, B=1000):
    """Für jede Teilmengen-Größe k: Verteilung der Ø R zufälliger k Trades (über Präfixsummen gemischter Reihen)."""
    n = len(R); sums = [[0.0] * (n + 1) for _ in range(B)]
    for b in range(B):
        x = R[:]; rnd.shuffle(x); s = 0.0; row = sums[b]
        for k in range(n): s += x[k]; row[k + 1] = s
    def p95(k):
        if k <= 0 or k > n: return None
        vals = sorted(sums[b][k] / k for b in range(B)); return vals[int(.95 * B) - 1]
    return p95

# ---------------------------------------------------------------- FTMO (wie Fair-Price-Report)
def run_phase(days, i, risk, target):
    eq, traded, k = 100.0, 0, i
    while k < len(days) and k - i < 500:
        start = eq; day = days[k]
        if day: traded += 1
        for t in day:
            worst = eq * (1 - t[1] * risk / 100)
            if start - worst >= 5: return 'fail_tag', k - i + 1, k
            if worst <= 90: return 'fail_gesamt', k - i + 1, k
            eq *= 1 + t[0] * risk / 100
            if start - eq >= 5: return 'fail_tag', k - i + 1, k
            if eq <= 90: return 'fail_gesamt', k - i + 1, k
        if eq >= 100 + target and traded >= 4: return 'pass', k - i + 1, k
        k += 1
    return 'offen', k - i, k

def ftmo(days, risk, runs=2000, seed=5):
    rnd = random.Random(seed); res = []
    for _ in range(runs):
        seq = [days[rnd.randrange(len(days))] for _ in range(1000)]
        r1, d1, e1 = run_phase(seq, 0, risk, 10)
        if r1 != 'pass': res.append((r1, None, d1, None)); continue
        r2, d2, _ = run_phase(seq, e1 + 1, risk, 5); res.append(('pass', r2, d1, d2))
    both = [r[2] + r[3] for r in res if r[0] == 'pass' and r[1] == 'pass']
    fails = [r[0] if r[0] != 'pass' else r[1] for r in res if r[0].startswith('fail') or (r[1] or '').startswith('fail')]
    return dict(both=len(both) / runs, dmean=mean(both) if both else None, dmed=sorted(both)[len(both) // 2] if both else None,
                ftag=sum(1 for f in fails if f == 'fail_tag') / len(fails) if fails else None)

def weekdays(a, b):
    d, e, out = datetime.date.fromisoformat(a), datetime.date.fromisoformat(b), []
    while d <= e:
        if d.weekday() < 5: out.append(d.isoformat())
        d += datetime.timedelta(days=1)
    return out

# ---------------------------------------------------------------- Filter-Katalog
DEF = dict(K1='K1_0.25', K2='K2_0.3_5', K3='K3_1.0')
def filters():
    F = []
    for w in (0.1, 0.25, 0.5): F.append((f'K1 MA-Band ±{w} ATR', lambda f, w=w: f[f'K1_{w}'] == 1))
    for N in (5, 10):
        for t in (0.2, 0.3, 0.5): F.append((f'K2 Retest ±{t} ATR, letzte {N} Swings', lambda f, t=t, N=N: f[f'K2_{t}_{N}'] == 1))
    for k in (0.5, 1.0, 1.5, 2.0): F.append((f'K3 Impuls ≥ {k} ATR', lambda f, k=k: f[f'K3_{k}'] == 1))
    sc = lambda f: f[DEF['K1']] + f[DEF['K2']] + f[DEF['K3']]
    F += [('Score ≥ 1', lambda f: sc(f) >= 1), ('Score ≥ 2', lambda f: sc(f) >= 2), ('Score = 3', lambda f: sc(f) == 3),
          ('K1 + K2', lambda f: f[DEF['K1']] and f[DEF['K2']]), ('K1 + K3', lambda f: f[DEF['K1']] and f[DEF['K3']]), ('K2 + K3', lambda f: f[DEF['K2']] and f[DEF['K3']]),
          ('Z1 H1-EMA50 in Trade-Richtung', lambda f: f['Z1_H1'] == 1), ('Z1 H4-EMA50 in Trade-Richtung', lambda f: f['Z1_H4'] == 1),
          ('Z2 Volumen Rücksetzer/Impuls < 1', lambda f: f['Z2'] is not None and f['Z2'] < 1),
          ('Z3 Abstand Konfluenz-Level ≤ 0,5 ATR', lambda f: f['Z3'] <= 0.5)]
    return F

# ---------------------------------------------------------------- Hauptlauf
def analyse():
    os.makedirs(OUT, exist_ok=True)
    frames = {}
    for sym in DIRS:
        m5 = load_m5(sym)
        frames[sym] = (Frame(aggregate(m5, M15), M15), Frame(aggregate(m5, 3600000), 3600000), Frame(aggregate(m5, 4 * 3600000), 4 * 3600000))
        print(sym, len(m5), 'M5-Kerzen')
    rnd = random.Random(42)
    result, archive = [], []
    for sid, name, sym, wf in STRATS:
        r = json.load(open(os.path.join(LIVE, sid, 'result.json')))
        fr, h1, h4 = frames[sym]
        T = []
        for t in r['trades']:
            f = features(t, fr, h1, h4)
            if f is None: continue
            f.update(R=t['R'], mae=min(max(t.get('maeR') or 1, 0), 3), date=t['date'], exitDate=t.get('exitDate', t['date']), dir=t['dir'],
                     hour=(t['features'] or {}).get('hour'), wd=t['wd'])
            T.append(f)
        a, b = r['period']['from'], r['period']['to']
        days = weekdays(a, b); weeks = len(days) / 5
        mid = days[len(days) // 2]; cut = days[int(len(days) * 0.7)]
        R = [t['R'] for t in T]
        base = basic(R); base['perWeek'] = len(R) / weeks
        base_is = mean([t['R'] for t in T if t['date'] < cut]); base_oos = mean([t['R'] for t in T if t['date'] >= cut])
        base_h = (mean([t['R'] for t in T if t['date'] < mid]), mean([t['R'] for t in T if t['date'] >= mid]))
        hy = lambda d: d[:4] + ('-H1' if d[5:7] <= '06' else '-H2')
        hys = sorted({hy(t['date']) for t in T})
        p95 = random_control(R, rnd)
        # Score-Tabelle
        sc = lambda f: f[DEF['K1']] + f[DEF['K2']] + f[DEF['K3']]
        score = []
        for s in range(4):
            Rs = [t['R'] for t in T if sc(t) == s]
            st = basic(Rs); st['ci'] = boot_ci(Rs, rnd); st['s'] = s; score.append(st)
        # Einzelmerkmale mit vs. ohne
        feats = []
        for lab, fn in [('K1 MA-Band ±0,25', lambda f: f[DEF['K1']] == 1), ('K2 Retest ±0,3 / 5 Swings', lambda f: f[DEF['K2']] == 1), ('K3 Impuls ≥ 1 ATR', lambda f: f[DEF['K3']] == 1),
                        ('Z1 H1 in Richtung', lambda f: f['Z1_H1'] == 1), ('Z1 H4 in Richtung', lambda f: f['Z1_H4'] == 1),
                        ('Z2 Volumen < 1', lambda f: f['Z2'] is not None and f['Z2'] < 1), ('Z3 ≤ 0,5 ATR', lambda f: f['Z3'] <= 0.5)]:
            w = [t['R'] for t in T if fn(t)]; wo = [t['R'] for t in T if not fn(t)]
            feats.append(dict(label=lab, n_with=len(w), e_with=mean(w), n_without=len(wo), e_without=mean(wo)))
        if sym == 'EURUSD': feats = [x for x in feats if not x['label'].startswith('Z2')]
        # Filter
        flist = []
        for lab, fn in filters():
            if sym == 'EURUSD' and lab.startswith('Z2'): continue
            keep = [t for t in T if fn(t)]
            if len(keep) < 10: continue
            Rk = [t['R'] for t in keep]
            e_is = mean([t['R'] for t in keep if t['date'] < cut]); e_oos = mean([t['R'] for t in keep if t['date'] >= cut])
            h = (mean([t['R'] for t in keep if t['date'] < mid]), mean([t['R'] for t in keep if t['date'] >= mid]))
            per_hy = {y: (mean([t['R'] for t in keep if hy(t['date']) == y]) - mean([t['R'] for t in T if hy(t['date']) == y])) for y in hys}
            p = p95(len(Rk))
            x = dict(label=lab, n=len(Rk), exp=mean(Rk), d=mean(Rk) - base['exp'], share=len(Rk) / len(R), perWeek=len(Rk) / weeks,
                     d_is=e_is - base_is, d_oos=e_oos - base_oos, n_oos=sum(1 for t in keep if t['date'] >= cut),
                     d_h1=h[0] - base_h[0], d_h2=h[1] - base_h[1], p95=p, hy=per_hy)
            x['a'] = x['d_oos'] >= 0.05; x['b'] = p is not None and x['exp'] > p; x['c'] = x['d_h1'] > 0 and x['d_h2'] > 0; x['dd'] = x['perWeek'] >= 1
            x['_keep'] = keep
            flist.append(x)
        # FTMO für die 2–3 besten (zuerst alle, die a–d erfüllen, sonst nach OOS-Plus)
        ok = sorted([x for x in flist if x['a'] and x['b'] and x['c'] and x['dd']], key=lambda x: -x['d_oos'])
        cand = ok[:3] if ok else sorted([x for x in flist if x['d_oos'] > 0], key=lambda x: -x['d_oos'])[:2]
        def seq(tr):
            by = collections.defaultdict(list)
            for t in tr: by[t['exitDate']].append((t['R'], t['mae']))
            return [by.get(d, []) for d in days]
        ftm = {'ungefiltert': {rk: ftmo(seq(T), rk) for rk in (0.25, 0.5, 1.0)}}
        for x in cand:
            ftm[x['label']] = {rk: ftmo(seq(x['_keep']), rk) for rk in (0.25, 0.5, 1.0)}
            base05, f05 = ftm['ungefiltert'][0.5], ftm[x['label']][0.5]
            x['e'] = f05['both'] >= base05['both'] - 0.01
            x['slower'] = (f05['dmed'] or 1e9) > 1.25 * (base05['dmed'] or 1e9)
        for x in flist:
            x.pop('_keep', None)
            x['accept'] = bool(x['a'] and x['b'] and x['c'] and x['dd'] and x.get('e'))
        acc = sorted([x for x in flist if x['accept']], key=lambda x: -x['d_oos'])
        insample = [x for x in flist if x['d_is'] >= 0.05 and not x['accept']]
        if acc: rec = ('übernehmen', f"Filter übernehmen: {acc[0]['label']}")
        elif insample: rec = ('nur-IS', 'Effekt nur in-sample – verworfen')
        else: rec = ('kein', 'kein Effekt')
        why = []
        if acc:
            a0 = acc[0]
            why.append(f"OOS {a0['d_oos']:+.2f}R, über p95 der Zufallsfilter ({a0['exp']:+.2f} > {a0['p95']:+.2f}R), beide Hälften besser, {a0['perWeek']:.1f} Trades/Woche, FTMO nicht schlechter"
                       + (' – aber deutlich langsamer bis Bestehen' if a0.get('slower') else ''))
        else:
            best = max(flist, key=lambda x: x['d_oos']) if flist else None
            if best:
                fails = [m for m, ok_ in (('OOS-Plus < 0,05R', best['a']), ('nicht über p95 Zufall', best['b']), ('nicht in beiden Hälften', best['c']), ('< 1 Trade/Woche', best['dd'])) if not ok_]
                why.append(f"bester Filter „{best['label']}“: OOS {best['d_oos']:+.2f}R – scheitert an: {', '.join(fails) or 'FTMO-Bestehensquote'}")
        result.append(dict(id=sid, name=name, sym=sym, wf=wf, n=len(T), n_all=len(r['trades']), base=base, base_is=base_is, base_oos=base_oos,
                           score=score, feats=feats, filters=flist, ftmo=ftm, rec=rec, why=why, cut=cut, hys=hys))
        for x in flist:
            if not x['accept']: archive.append(dict(strategy=name, **{k: v for k, v in x.items() if k != 'hy'}))
        print(f"{name:24s} {len(T):5d}/{len(r['trades'])} Trades  Basis {base['exp']:+.3f}R  -> {rec[1]}")
    json.dump(result, open(os.path.join(OUT, 'ergebnis.json'), 'w'), default=str)
    json.dump(archive, open(os.path.join(OUT, 'archiv.json'), 'w'), default=str)
    return result, archive

if __name__ == '__main__':
    analyse()
