#!/usr/bin/env python3
"""Auswertung Kandidaten K1/K2/K5 (Auftrag 07.11.2026). Liest out/kandidaten/k2k5/runs/*.json (bin/k2k5.js).

Ausgabe out/kandidaten/k2k5/: report.html (Dashboard: nur bestandene Kombinationen + Übersichten), archiv.html,
ergebnis.json (alle Kombinationen), ausgeschlossen.md. Feste Seeds, reproduzierbar.

Kombination = Epic-Session × Strategie × Variante (K2 zusätzlich × Filtersatz).
Entscheidung (alle erfüllt): OOS-Netto-Exp. ≥ 0,1R und Benjamini-Hochberg (FDR 10 %) bestanden, ≥ 150 OOS-Trades,
≥ 7/10 Blöcke positiv, Robustheits-Heatmap (≥ 70 % der Nachbarn netto profitabel), Kostenanteil < 40 %,
K2 schlägt K1 (OOS, gleiche Session, gleiche Range-Länge), FTMO-Bestehensquote 0,5 % ≥ Basis (d_ftmo NAS F618ATR).
"""
import os, sys, json, glob, math, random, datetime, statistics, html
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ftmo_lib as FL

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out', 'kandidaten', 'k2k5')
BER = ZoneInfo('Europe/Berlin')
SEED = 7
FDR_Q, MIN_OOS, MIN_EXP, MIN_BLOCKS, MAX_COST, ROBUST = 0.10, 150, 0.10, 7, 0.40, 0.70
F_DEFAULT = {'F1': (0.6, 1.5), 'F2': (0.05, 0.25), 'F3': (1.0, 10.0), 'F4': (0.15, 0.6), 'F5': (0.5, None)}
F_IDX = {'F1': 8, 'F2': 9, 'F3': 10, 'F4': 11, 'F5': 12}
F1_GRID = [1.0, 1.25, 1.5, 2.0, None]   # Obergrenze F1 (None = aus), Untergrenze fest
F2_GRID = [0.15, 0.2, 0.25, 0.35, None]
TGT_GRID = [1.5, 2, 3]
K5_EMA, K5_STOP = [7, 9, 11, 15, 21], [1, 1.5, 2, 2.5, 3]
mean = lambda a: sum(a) / len(a) if a else None

# ---------------------------------------------------------------- Laden
RUNS = {}
for f in sorted(glob.glob(os.path.join(OUT, 'runs', '*.json'))):
    r = json.load(open(f)); RUNS[r['id']] = r
QUAL = json.load(open(os.path.join(OUT, 'quality.json')))
EPICS = json.load(open(os.path.join(ROOT, 'config', 'epics.json')))['epics']

def berlin_date(ms): return datetime.datetime.fromtimestamp(ms / 1000, BER).date().isoformat()

def passes(t, fs):
    for k, (lo, hi) in fs.items():
        x = t[F_IDX[k]]
        if x is None or (lo is not None and x < lo) or (hi is not None and x > hi): return False
    return True

# ---------------------------------------------------------------- Kennzahlen
def pf(R):
    gp = sum(r for r in R if r > 0); gl = -sum(r for r in R if r < 0)
    return gp / gl if gl > 0 else None

def metrics(tr, run):
    R = [t[3] for t in tr]; G = [t[4] for t in tr]
    if not R: return dict(n=0)
    cut = run['cut']; days = run['days']
    Ris = [t[3] for t in tr if t[0] < cut]; Roos = [t[3] for t in tr if t[0] >= cut]
    srt = sorted(R, reverse=True)
    eq = dd = peak = 0.0; streak = best_streak = 0
    for r in R:
        eq += r; peak = max(peak, eq); dd = max(dd, peak - eq)
        streak = streak + 1 if r <= 0 else 0; best_streak = max(best_streak, streak)
    nb = 10; idx = {d: i for i, d in enumerate(days)}; blocks = [[] for _ in range(nb)]
    for t in tr:
        i = idx.get(t[0])
        if i is not None: blocks[min(nb - 1, i * nb // len(days))].append(t[3])
    bexp = [mean(b) for b in blocks]
    gross, net = sum(G), sum(R)
    L = [t[3] for t in tr if t[2] > 0]; S = [t[3] for t in tr if t[2] < 0]
    weeks = len(days) / 5
    return dict(n=len(R), n_is=len(Ris), n_oos=len(Roos), win=sum(1 for r in R if r > 0) / len(R), exp=mean(R), exp_gross=mean(G),
                exp_is=mean(Ris), exp_oos=mean(Roos), pf=pf(R), pf_wo3=pf(srt[3:]), maxdd=dd, streak=best_streak,
                cost_share=(gross - net) / gross if gross > 0 else None, blocks=bexp, blocks_pos=sum(1 for b in bexp if b is not None and b > 0),
                n_long=len(L), exp_long=mean(L), n_short=len(S), exp_short=mean(S), per_week=len(R) / weeks)

def boot_p(Roos, rnd, B=1000):
    """Bootstrap-p für H0: OOS-Expectancy ≤ 0 (Anteil der Resamples mit Mittel ≤ 0)."""
    n = len(Roos)
    if n < 20 or mean(Roos) <= 0: return 1.0
    c = sum(1 for _ in range(B) if sum(rnd.choices(Roos, k=n)) <= 0)
    return (c + 1) / (B + 1)

# ---------------------------------------------------------------- Kalibrierung F1–F5 (nur IS, je Asset-Klasse)
CAND = {'F1': [(0.4, 1.5), (0.6, 1.5), (0.6, 2.0), (0.8, 1.5), (0.6, 1.2), (None, 1.0), (1.0, None)],
        'F2': [(0.05, 0.25), (0.03, 0.2), (0.05, 0.35), (0.1, 0.3), (None, 0.15), (0.15, None)],
        'F3': [(1.0, 10.0), (0.8, 10.0), (1.2, 10.0), (None, 1.0), (1.5, None)],
        'F4': [(0.15, 0.6), (0.1, 0.8), (0.2, 0.5), (None, 0.3), (0.3, None)],
        'F5': [(0.5, None), (0.4, None), (0.6, None), (0.7, None), (None, 0.5)]}

def calibrate():
    cal = {}
    for cls in sorted({r['asset_class'] for r in RUNS.values()}):
        pool = [t for r in RUNS.values() if r['asset_class'] == cls for k, v in r['variants'].items() if v['strategy'] == 'K2' for t in v['trades'] if t[0] < r['cut']]
        base = mean([t[3] for t in pool])
        cal[cls] = {'_basis_is': base, '_n_is': len(pool)}
        for f, cands in CAND.items():
            best = None
            for w in cands:
                sub = [t[3] for t in pool if passes(t, {f: w})]
                if len(sub) >= 0.25 * len(pool):
                    m = mean(sub)
                    if best is None or m > best[1]: best = (w, m, len(sub))
            cal[cls][f] = dict(window=best[0], exp_is=best[1], n=best[2], use=best[1] > base) if best else None
    return cal

# ---------------------------------------------------------------- Kombinationen bilden
def combos(cal):
    out = []
    for sid, r in RUNS.items():
        cls = r['asset_class']
        for vid, v in r['variants'].items():
            if v['strategy'] in ('K1', 'K5'):
                out.append(dict(key=f'{sid}|{vid}', session=sid, strategy=v['strategy'], vid=vid, filt='–', fs={}, params=v['params'], trades=v['trades']))
                continue
            sets = {'ohne': {}, **{f: {f: F_DEFAULT[f]} for f in F_DEFAULT}, 'F1-5': dict(F_DEFAULT)}
            cfs = {f: tuple(c['window']) for f, c in cal[cls].items() if not f.startswith('_') and c and c['use']}
            if cfs: sets['kalibriert'] = cfs
            for name, fs in sets.items():
                tr = [t for t in v['trades'] if passes(t, fs)] if fs else v['trades']
                out.append(dict(key=f'{sid}|{vid}|{name}', session=sid, strategy='K2', vid=vid, filt=name, fs=fs, params=v['params'], trades=tr))
    return out

# ---------------------------------------------------------------- Robustheit
def k2_cell_exp(run, base_params, fs, f1hi, f2hi, tgt):
    p = base_params
    vid = 'K2|or%d|%s|tol%s|%sR|be%d|fade%d' % (p['orMin'], p['tf'], p['tol'], ('%g' % tgt), int(p['be']), int(p['fade']))
    v = run['variants'].get(vid)
    if not v: return None
    f = dict(fs)
    f['F1'] = (f.get('F1', F_DEFAULT['F1'])[0] if 'F1' in fs else 0.6, f1hi) if f1hi is not None else None
    f['F2'] = (f.get('F2', F_DEFAULT['F2'])[0] if 'F2' in fs else 0.05, f2hi) if f2hi is not None else None
    f = {k: w for k, w in f.items() if w is not None}
    R = [t[3] for t in v['trades'] if passes(t, f)]
    return mean(R) if len(R) >= 20 else None

def snap(val, grid):
    if val is None: return len(grid) - 1
    vals = [g for g in grid if g is not None]
    return min(range(len(vals)), key=lambda i: abs(vals[i] - val))

def robust_k2(c):
    run = RUNS[c['session']]; p = c['params']; fs = c['fs']
    i1 = snap(fs['F1'][1], F1_GRID) if 'F1' in fs else len(F1_GRID) - 1
    i2 = snap(fs['F2'][1], F2_GRID) if 'F2' in fs else len(F2_GRID) - 1
    i3 = TGT_GRID.index(p['tgt'])
    neigh = []
    for a in (-1, 0, 1):
        for b in (-1, 0, 1):
            for d in (-1, 0, 1):
                if (a, b, d) == (0, 0, 0): continue
                x, y, z = i1 + a, i2 + b, i3 + d
                if 0 <= x < len(F1_GRID) and 0 <= y < len(F2_GRID) and 0 <= z < len(TGT_GRID):
                    neigh.append(k2_cell_exp(run, p, fs, F1_GRID[x], F2_GRID[y], TGT_GRID[z]))
    neigh = [e for e in neigh if e is not None]
    return (sum(1 for e in neigh if e > 0) / len(neigh) if neigh else None), len(neigh)

def k5_vid(p, ema, stop):
    return 'K5|%s|%s|ema%d|stop%g|%s|%s|flat%d' % (p['anchor'], p['tf'], ema, stop, ('%gR' % p['tgt']) if p['tgt'] else 'exitCross',
                                                 {0: 'beide', 1: 'long', -1: 'short'}[p['side']], int(p['flat']))

def robust_k5(c):
    run = RUNS[c['session']]; p = c['params']
    i, j = K5_EMA.index(p['ema']), K5_STOP.index(p['stopAtr'])
    neigh = []
    for a in (-1, 0, 1):
        for b in (-1, 0, 1):
            if (a, b) == (0, 0): continue
            if 0 <= i + a < len(K5_EMA) and 0 <= j + b < len(K5_STOP):
                g = run['grid'].get(k5_vid(p, K5_EMA[i + a], K5_STOP[j + b]))
                if g and g['n'] >= 20: neigh.append(g['exp'])
    return (sum(1 for e in neigh if e > 0) / len(neigh) if neigh else None), len(neigh)

def heat_k2(run, p, fs):
    return [[[k2_cell_exp(run, p, fs, F1_GRID[x], F2_GRID[y], TGT_GRID[z]) for y in range(len(F2_GRID))] for x in range(len(F1_GRID))] for z in range(len(TGT_GRID))]

def heat_k5(run, p):
    return [[(run['grid'].get(k5_vid(p, e, s)) or {}).get('exp') for s in K5_STOP] for e in K5_EMA]

# ---------------------------------------------------------------- FTMO
def weekdays(a, b):
    d, e, out = datetime.date.fromisoformat(a), datetime.date.fromisoformat(b), []
    while d <= e:
        if d.weekday() < 5: out.append(d.isoformat())
        d += datetime.timedelta(days=1)
    return out

def to_ftmo(trades, scale=1.0):
    return [dict(entry_date=berlin_date(t[1]), exit_date=berlin_date(t[7]), entry_time=str(t[1]), r=t[3] * scale, mae=min(t[5], 3) * scale) for t in trades]

def ftmo_eval(trades, day_list, risks=(0.25, 0.5, 1.0), runs=1000):
    dd = FL.to_days(trades, day_list)
    return {str(rk): FL.simulate(dd, day_list, rk, runs=runs, seed=SEED) for rk in risks}, dd

def calendar(dd, day_list, risk=0.5):
    """Challenge an jedem Handelstag gestartet (echte Reihenfolge): Ergebnis + Tage bis Bestehen."""
    out = {}
    for s in range(len(dd)):
        c = FL.challenge(dd, s, risk)
        res = 'pass' if c['p1'] == 'pass' and c['p2'] == 'pass' else ('offen' if 'offen' in (c['p1'], c['p2']) else 'fail')
        out[day_list[s]] = [res, c['days']]
    return out

def daily_series(trades):
    d = {}
    for t in trades: d[berlin_date(t[1])] = d.get(berlin_date(t[1]), 0.0) + t[3]
    return d

def corr(a, b, days):
    x = [a.get(d, 0.0) for d in days]; y = [b.get(d, 0.0) for d in days]
    if len(days) < 30 or statistics.pstdev(x) == 0 or statistics.pstdev(y) == 0: return None
    mx, my = mean(x), mean(y)
    return sum((p - mx) * (q - my) for p, q in zip(x, y)) / (len(x) * statistics.pstdev(x) * statistics.pstdev(y))

# ---------------------------------------------------------------- Hauptlauf
def main():
    rnd = random.Random(SEED)
    cal = calibrate()
    C = combos(cal)
    print(len(C), 'Kombinationen')
    for c in C:
        c['m'] = metrics(c['trades'], RUNS[c['session']])
        c['p'] = boot_p([t[3] for t in c['trades'] if t[0] >= RUNS[c['session']]['cut']], rnd) if c['m'].get('n') else 1.0
    # Benjamini-Hochberg über alle Kombinationen
    ps = sorted(((c['p'], i) for i, c in enumerate(C)), key=lambda x: x[0]); m = len(ps); kmax = 0
    for rank, (p, i) in enumerate(ps, 1):
        if p <= rank / m * FDR_Q: kmax = rank
    for rank, (p, i) in enumerate(ps, 1): C[i]['fdr'] = rank <= kmax
    print('FDR bestanden:', sum(c['fdr'] for c in C))
    # K1-Referenz je Session und Range-Länge
    k1 = {(c['session'], c['params']['orMin']): c['m'].get('exp_oos') for c in C if c['strategy'] == 'K1'}
    # Basis FTMO (d_ftmo NAS F618ATR)
    fb = json.load(open(os.path.join(ROOT, 'out', 'live', 'ftmo-basis', 'result.json')))
    base_tr = [[t['date'], t['entryT'], 1 if t['dir'] == 'BUY' else -1, t['R'], t['R'], t.get('maeR') or 1.0, t['reason'], t.get('exitT') or t['entryT']] for t in fb['trades']]
    all_days = weekdays(min(r['days'][0] for r in RUNS.values()), max(r['days'][-1] for r in RUNS.values()))
    base_ftmo, _ = ftmo_eval(to_ftmo(base_tr), weekdays(base_tr[0][0], base_tr[-1][0]), risks=(0.5,))
    base_pass = base_ftmo['0.5']['bootstrap']['both'] or 0
    base_daily = daily_series(base_tr)
    # Kriterien
    for c in C:
        mm = c['m']; c['crit'] = {}
        if not mm.get('n'): c['status'] = 'keine Trades'; continue
        rob = robust_k2(c) if c['strategy'] == 'K2' else robust_k5(c) if c['strategy'] == 'K5' else (None, 0)
        c['robust'] = rob
        cr = dict(exp=(mm['exp_oos'] or -9) >= MIN_EXP, fdr=c['fdr'], n_oos=mm['n_oos'] >= MIN_OOS, blocks=mm['blocks_pos'] >= MIN_BLOCKS,
                  robust=rob[0] is not None and rob[0] >= ROBUST, cost=mm['cost_share'] is not None and mm['cost_share'] < MAX_COST)
        if c['strategy'] == 'K2': cr['k1'] = (mm['exp_oos'] or -9) > (k1.get((c['session'], c['params']['orMin'])) or 0)
        c['crit'] = cr
    # FTMO nur für Kombinationen, die alle anderen Kriterien erfüllen (+ Top-10 nach OOS als Information)
    pre = [c for c in C if c.get('crit') and all(c['crit'].values())]
    info = sorted([c for c in C if c['m'].get('n_oos', 0) >= 50 and (c['m'].get('exp_oos') or -9) > 0], key=lambda c: -c['m']['exp_oos'])
    # Beste je Session × Strategie (IS-Auswahl, OOS unverändert) für Matrix, Korrelation und FTMO-Information
    best_is = {}
    for c in C:
        mm = c['m']
        if mm.get('n_is', 0) < 50 or mm.get('exp_is') is None: continue
        k = (c['session'], c['strategy'])
        if k not in best_is or mm['exp_is'] > best_is[k]['m']['exp_is']: best_is[k] = c
    ftmo_set = {c['key']: c for c in pre + list(best_is.values()) + info[:10]}
    for c in ftmo_set.values():
        r = RUNS[c['session']]
        if not r['ftmo']: c['ftmo'] = None; continue
        dl = weekdays(r['days'][0], r['days'][-1])
        c['ftmo'], dd = ftmo_eval(to_ftmo(c['trades']), dl)
        c['calendar'] = calendar(dd, dl) if c in pre or c in best_is.values() else None
    for c in C:
        if c.get('crit'):
            if 'ftmo' in c and c['ftmo']: c['crit']['ftmo'] = (c['ftmo']['0.5']['bootstrap']['both'] or 0) >= base_pass
        c['passed'] = bool(c.get('crit')) and all(c['crit'].values()) and ('ftmo' in c['crit'] or not RUNS[c['session']]['ftmo'])
        c['status'] = 'bestanden' if c['passed'] else ('zu wenig Daten' if c.get('crit') and not c['crit'].get('n_oos') else 'nicht bestanden')
    # Richtungskonsistenz je Asset-Klasse: gleiche Variante (vid+Filter) über Sessions der Klasse
    cons = {}
    for c in C:
        k = (RUNS[c['session']]['asset_class'], c['vid'], c['filt'])
        cons.setdefault(k, []).append((c['session'], c['m'].get('exp_oos')))
    for c in C:
        L = cons[(RUNS[c['session']]['asset_class'], c['vid'], c['filt'])]
        c['consistency'] = [sum(1 for _, e in L if e is not None and e > 0), len(L)]
    # Korrelation Tagesergebnisse (beste IS-Auswahl je Session × Strategie + bestandene) und mit d_ftmo F618ATR
    top = {c['key']: c for c in list(best_is.values()) + [c for c in C if c['passed']]}
    series = {k: daily_series(c['trades']) for k, c in top.items()}
    series['d_ftmo NAS F618ATR'] = base_daily
    keys = list(series)
    cm = {a: {b: corr(series[a], series[b], [d for d in all_days if d in set(series[a]) | set(series[b])] if False else all_days) for b in keys} for a in keys}
    # Portfolio: 3–5 beste unkorrelierte Kombinationen (Kandidaten: bestanden, sonst IS-Beste mit OOS > 0)
    pool = [c for c in C if c['passed']] or [c for c in best_is.values() if (c['m'].get('exp_oos') or 0) > 0 and RUNS[c['session']]['ftmo']]
    pool = sorted(pool, key=lambda c: -(c['m'].get('exp_is') or -9))
    chosen = []
    for c in pool:
        if all(abs(cm[c['key']][o['key']] or 0) < 0.3 and RUNS[c['session']]['epic'] + c['strategy'] != RUNS[o['session']]['epic'] + o['strategy'] for o in chosen): chosen.append(c)
        if len(chosen) == 5: break
    port = None
    if len(chosen) >= 2:
        trs = [x for c in chosen for x in to_ftmo(c['trades'], 1 / len(chosen))]
        dl = weekdays(min(t['entry_date'] for t in trs), max(t['entry_date'] for t in trs))
        pf_, ddp = ftmo_eval(trs, dl)
        allR = [t['r'] for t in trs]
        cut = max(RUNS[c['session']]['cut'] for c in chosen)
        tro = [t for t in trs if t['entry_date'] >= cut]
        dlo = weekdays(cut, max(t['entry_date'] for t in trs))
        pfo, _ = ftmo_eval(tro, dlo)
        port = dict(members=[c['key'] for c in chosen], from_pass=bool([c for c in C if c['passed']]), ftmo=pf_, ftmo_oos=pfo, oos_from=cut, n=len(trs), exp_day=sum(allR) / len(dl), calendar=calendar(ddp, dl))
    # Aggregat je Asset-Klasse (gleichgewichtet über Sessions, IS-beste Variante je Session und Strategie)
    agg = {}
    for (sid, strat), c in best_is.items():
        cls = RUNS[sid]['asset_class']
        agg.setdefault((cls, strat), []).append(c)
    agg_out = {}
    for (cls, strat), cs in agg.items():
        ds = [daily_series(c['trades']) for c in cs]
        cut = min(RUNS[c['session']]['cut'] for c in cs)
        days = sorted(set(d for s in ds for d in s))
        port_d = {d: mean([s.get(d, 0.0) for s in ds]) for d in days}
        is_ = [v for d, v in port_d.items() if d < cut]; oos = [v for d, v in port_d.items() if d >= cut]
        agg_out[f'{cls}|{strat}'] = dict(sessions=[c['key'] for c in cs], days=len(days), sumR=sum(port_d.values()), is_day=mean(is_), oos_day=mean(oos),
                                         oos_pos=sum(1 for c in cs if (c['m'].get('exp_oos') or 0) > 0), n=len(cs))
    write(C, cal, k1, base_ftmo, base_pass, best_is, cm, keys, port, agg_out, info)

# ---------------------------------------------------------------- Ausgabe
def fr(x, d=2, s=True):
    if x is None: return '–'
    return (('%+.' + str(d) + 'f') % x if s else ('%.' + str(d) + 'f') % x).replace('.', ',')
pct = lambda x: '–' if x is None else '%d %%' % round(x * 100)
esc = lambda s: html.escape(str(s))
def col(e):
    if e is None: return '#eee'
    t = max(-1, min(1, e / 0.2))
    return 'rgb(%d,%d,%d)' % ((255, int(255 - 120 * -t), int(255 - 120 * -t)) if t < 0 else (int(255 - 130 * t), 255 - int(40 * t), int(255 - 130 * t)))

def crit_html(c):
    lab = dict(exp='OOS ≥ +0,10R', fdr='FDR 10 %', n_oos='≥ 150 OOS-Trades', blocks='≥ 7/10 Blöcke', robust='Heatmap ≥ 70 %', cost='Kosten < 40 %', k1='schlägt K1', ftmo='FTMO ≥ Basis')
    return ' '.join('<span title="%s" class="%s">%s</span>' % (lab[k], 'ok' if v else 'no', '✓' if v else '✗') for k, v in c.get('crit', {}).items())

def row(c, rank=None):
    m = c['m']; r = RUNS[c['session']]
    f05 = (c.get('ftmo') or {}).get('0.5', {}).get('bootstrap', {}) if c.get('ftmo') else {}
    rob = c.get('robust') or (None, 0)
    return ('<tr><td class=num>%s</td><td><b>%s</b> %s<div class=sm>%s · %s</div></td><td class=num>%s / <b>%s</b></td><td class=num>%s</td><td class=num>%s</td><td class=num style="background:%s"><b>%s</b></td>'
            '<td class=num>%s</td><td class=num>%s</td><td class=num>%s</td><td class=num>%s / %s</td><td class=num>%s R</td><td class=num>%s</td><td class=num>%d/10</td><td class=num>%s</td><td class=num>%s · %s T</td><td class=num>%d/%d</td><td>%s</td></tr>') % (
        rank or '', esc(c['strategy']), esc(r['label']), esc(c['vid'].split('|', 1)[1] if '|' in c['vid'] else c['vid']), esc(c['filt']),
        m['n'], m['n_oos'], pct(m['win']), fr(m['exp']), col(m['exp_oos']), fr(m['exp_oos']), fr(m['exp_is']), pct(m['cost_share']) if (m['cost_share'] or 0) <= 1 else '&gt; 100 %',
        fr(m['pf'], 2, False), fr(m['pf_wo3'], 2, False), fr(m['exp_long']), fr(m['maxdd'], 1, False), m['streak'], m['blocks_pos'], pct(rob[0]),
        pct(f05.get('both')), f05.get('days_median') or '–', c['consistency'][0], c['consistency'][1], crit_html(c))

HEAD = ('<thead><tr><th>#</th><th>Kombination</th><th class=num>Trades / OOS</th><th class=num>Treffer</th><th class=num>Ø R netto</th><th class=num>Ø R OOS</th><th class=num>Ø R IS</th>'
        '<th class=num>Kosten</th><th class=num>PF / ohne Top-3</th><th class=num>Long Ø R</th><th class=num>max DD</th><th class=num>Verlust-serie</th><th class=num>Blöcke</th>'
        '<th class=num>Heatmap</th><th class=num>FTMO 0,5 %</th><th class=num>gleiche Richtung (Klasse)</th><th>Kriterien</th></tr></thead>')

def heat_html(c):
    r = RUNS[c['session']]
    if c['strategy'] == 'K2':
        H = heat_k2(r, c['params'], c['fs'])
        lab = lambda v: 'aus' if v is None else fr(v, 2, False)
        out = ''
        for z, tg in enumerate(TGT_GRID):
            out += '<div class=hm><div class=sm>Ziel %sR · Zeilen F1 max, Spalten F2 max</div><table><tr><th></th>%s</tr>%s</table></div>' % (
                fr(tg, 1, False), ''.join('<th>%s</th>' % lab(v) for v in F2_GRID),
                ''.join('<tr><th>%s</th>%s</tr>' % (lab(F1_GRID[x]), ''.join('<td style="background:%s">%s</td>' % (col(e), fr(e)) for e in H[z][x])) for x in range(len(F1_GRID))))
        return out
    if c['strategy'] == 'K5':
        H = heat_k5(r, c['params'])
        return '<div class=hm><div class=sm>Zeilen EMA-Länge, Spalten Stop × ATR (Ø R netto, ganzer Zeitraum)</div><table><tr><th></th>%s</tr>%s</table></div>' % (
            ''.join('<th>%s</th>' % fr(s, 1, False) for s in K5_STOP), ''.join('<tr><th>%d</th>%s</tr>' % (e, ''.join('<td style="background:%s">%s</td>' % (col(x), fr(x)) for x in H[i])) for i, e in enumerate(K5_EMA)))
    return ''

def cal_html(calmap):
    if not calmap: return ''
    years = sorted({d[:4] for d in calmap}); out = ''
    for y in years:
        cells = ''
        for d, (res, days) in sorted(calmap.items()):
            if d[:4] != y: continue
            colr = {'pass': '#2e9e5b', 'fail': '#d9534f', 'offen': '#ccc'}[res]
            cells += '<i title="%s: %s%s" style="background:%s"></i>' % (d, res, (' in %d Handelstagen' % days) if res == 'pass' else '', colr)
        out += '<div class=cal><span class=sm>%s</span>%s</div>' % (y, cells)
    return out

def write(C, cal, k1, base_ftmo, base_pass, best_is, cm, keys, port, agg, info):
    passed = sorted([c for c in C if c['passed']], key=lambda c: -c['m']['exp_oos'])
    sess = list(RUNS)
    # Matrix
    mat = ''
    for sid in sess:
        r = RUNS[sid]; cells = ''
        for st in ('K1', 'K2', 'K5'):
            c = best_is.get((sid, st)); nf = sum(1 for x in C if x['session'] == sid and x['strategy'] == st and x['fdr']); npass = sum(1 for x in C if x['session'] == sid and x['strategy'] == st and x['passed'])
            e = c['m']['exp_oos'] if c else None
            cells += '<td style="background:%s" class=num title="%s"><b>%s</b><div class=sm>FDR ✓ %d · bestanden %d</div></td>' % (col(e), esc(c['key'] if c else ''), fr(e), nf, npass)
        mat += '<tr><td><b>%s</b><div class=sm>%s · FTMO %s</div></td>%s</tr>' % (esc(r['label']), esc(r['asset_class']), esc(r['ftmo'] or 'nein'), cells)
    # Korrelation
    short = lambda k: k.replace('|', ' ')[:60]
    corr_tab = '<table class=corr><tr><th></th>%s</tr>%s</table>' % (''.join('<th title="%s">%d</th>' % (esc(k), i + 1) for i, k in enumerate(keys)),
        ''.join('<tr><th>%d %s</th>%s</tr>' % (i + 1, esc(short(a)), ''.join('<td style="background:%s">%s</td>' % (col(-abs(cm[a][b] or 0) * 0.2 if a != b else None), fr(cm[a][b], 2) if a != b else '') for b in keys)) for i, a in enumerate(keys)))
    agg_rows = ''.join('<tr><td>%s</td><td>%s</td><td class=num>%d</td><td class=num>%s</td><td class=num style="background:%s">%s</td><td class=num>%d/%d</td></tr>' % (
        esc(k.split('|')[0]), esc(k.split('|')[1]), v['days'], fr(v['is_day'], 3), col(v['oos_day']), fr(v['oos_day'], 3), v['oos_pos'], v['n']) for k, v in sorted(agg.items()))
    excl = [(e, q['reason']) for e, q in QUAL.items() if not q['ok']]
    port_html = ''
    if port:
        f = port['ftmo']
        fo = port['ftmo_oos']
        cellf = lambda F, k: '<td class=num>%s · %s T<div class=sm>offen %d/%d</div></td>' % (pct(F[k]['bootstrap']['both']), F[k]['bootstrap']['days_median'] or '–', F[k]['bootstrap']['offen'], F[k]['bootstrap']['n'])
        port_html = '<p>%s</p><table><tr><th>Mitglieder (Risiko je Trade geteilt)</th><th>Zeitraum</th><th class=num>0,25 %%</th><th class=num>0,5 %%</th><th class=num>1 %%</th></tr><tr><td rowspan=2>%s</td><td>ganzer Zeitraum (inkl. IS – <b>durch die IS-Auswahl geschönt</b>)</td>%s</tr><tr><td>nur OOS ab %s</td>%s</tr></table>%s' % (
            'Aus bestandenen Kombinationen.' if port['from_pass'] else '<b>Keine Kombination hat bestanden</b> – Portfolio nur zur Information aus den IS-besten Kombinationen mit OOS &gt; 0 (unkorreliert, |r| &lt; 0,3).',
            '<br>'.join(esc(m) for m in port['members']), ''.join(cellf(f, k) for k in ('0.25', '0.5', '1.0')), port['oos_from'], ''.join(cellf(fo, k) for k in ('0.25', '0.5', '1.0')),
            cal_html(port['calendar']))
    rec = ''
    for c in passed:
        e = c['m']['exp_oos']
        rec += '<li><b>%s</b>: %s</li>' % (esc(c['key']), 'als d_ftmo-Variante bauen (Forward-Test)' if e >= 0.2 and RUNS[c['session']]['ftmo'] else 'weiter testen (Forward-Test im Schatten)')
    best_info = ''.join(row(c, i + 1) for i, c in enumerate(info[:10]))
    detail = ''.join('<details><summary>%s – Heatmap und Challenge-Kalender</summary>%s%s</details>' % (esc(c['key']), heat_html(c), cal_html(c.get('calendar'))) for c in (passed or list(best_is.values())))
    calib = ''.join('<tr><td>%s</td><td class=num>%s (%d)</td>%s</tr>' % (esc(cls), fr(v['_basis_is']), v['_n_is'], ''.join('<td>%s</td>' % (
        ('%s–%s: %s%s' % (fr(x['window'][0], 2, False) if x['window'][0] is not None else '…', fr(x['window'][1], 2, False) if x['window'][1] is not None else '…', fr(x['exp_is']), '' if x['use'] else ' (nicht genutzt)')) if x else '–') for f, x in v.items() if not f.startswith('_'))) for cls, v in cal.items())
    css = '''body{font:14px -apple-system,system-ui,sans-serif;margin:24px;max-width:1500px;color:#222}table{border-collapse:collapse;width:100%;margin:6px 0 14px}td,th{border-bottom:1px solid #e3e3e3;padding:5px 7px;text-align:left;vertical-align:top}
.num{text-align:right}.sm{font-size:12px;color:#666}.ok{color:#18794e;font-weight:700}.no{color:#b42318}.box{background:#f6f7f9;border-radius:8px;padding:10px 14px;margin:10px 0}
.hm{display:inline-block;margin:4px 14px 10px 0;width:auto}.hm table{width:auto}.hm td{font-size:11px;min-width:42px;text-align:right}.cal{display:flex;flex-wrap:wrap;gap:1px;align-items:center;margin:4px 0}.cal i{width:7px;height:12px;display:inline-block}
.corr td,.corr th{font-size:11px;padding:3px}details{margin:6px 0}summary{cursor:pointer}'''
    H = '''<!DOCTYPE html><html lang=de><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Kandidaten K2 ORB-Retest / K5 VWAP-EMA</title><style>%s</style></head><body>
<h1>Kandidaten K2 „ORB-Retest“ und K5 „VWAP-EMA-Cross“ (Vergleich K1 einfacher ORB)</h1>
<p class=sm>Status <b>Kandidat</b> – nicht im Top-10-Ranking. Erstellt %s · Seed %d · Daten Capital M5 Bid/Ask · Kosten = Spread aus den Kerzen + Slippage (DE40/US100 0,5 Pkt, EURUSD 0,1 Pip je Seite), Swap/Kommission 0 (intraday) · IS/OOS 70/30 je Session.</p>
<div class=box><b>Ergebnis:</b> %d Kombinationen getestet, %d bestehen die FDR-Korrektur (10 %%), <b>%d bestehen alle Kriterien</b>. %s</div>
<h2>Epic-Universum</h2><p>Kursdaten im Lab: %s. Weitere Epics (US500, UK100, Gold, …) brauchen Capital-API-Zugang (tools/capital_hours.py / Download-Workflow) – nicht getestet.
EURUSD mit beiden Session-Definitionen: Auftrag (London 08:00, NY 08:00) und config/sessions.yaml (07:00 / 08:30, validiert). Krypto/Rohstoffe/Aktien: keine Daten.</p>
<p><b>Ausgeschlossene Epics:</b> %s</p>
<h2>Bestandene Kombinationen (Ranking)</h2>%s%s
<h2>Matrix Epic × Strategie</h2><p class=sm>Zelle = Variante mit der besten IS-Expectancy (≥ 50 IS-Trades), Farbe = deren OOS-Netto-Expectancy (unverändert geprüft). Darunter: Anzahl Varianten mit bestandener FDR-Korrektur bzw. allen Kriterien.</p>
<table><tr><th>Session</th><th>K1 einfacher ORB</th><th>K2 ORB-Retest</th><th>K5 VWAP-EMA</th></tr>%s</table>
<h2>Aggregat je Asset-Klasse</h2><p class=sm>Gleichgewichtetes Portfolio der IS-besten Variante je Session, Ø R je Tag. „OOS &gt; 0“ = wie viele Sessions der Klasse in OOS positiv sind (EURUSD: 4 Session-Definitionen desselben Epics, nicht unabhängig).</p>
<table><tr><th>Klasse</th><th>Strategie</th><th class=num>Tage</th><th class=num>Ø R/Tag IS</th><th class=num>Ø R/Tag OOS</th><th class=num>Sessions OOS &gt; 0</th></tr>%s</table>
<h2>Beste OOS-Kombinationen (nur Information, ≥ 50 OOS-Trades)</h2><p class=sm>Höchste OOS-Werte nach Auswahl über tausende Varianten sind zum großen Teil Zufall – maßgeblich ist die FDR-Spalte.</p><table>%s<tbody>%s</tbody></table>
<h2>Korrelation der Tagesergebnisse</h2><p class=sm>IS-beste Kombination je Session × Strategie (+ bestandene) und d_ftmo NAS100 F618ATR. Pearson auf Tages-R (Werktage, ohne Trade = 0).</p>%s
<h2>FTMO 2-Step 100k</h2><p class=sm>Basis d_ftmo NAS F618ATR: %s beide Phasen bei 0,5 %% (Block-Bootstrap nach Woche, 1000 Läufe). Kalender: Challenge an jedem Tag gestartet, grün bestanden, rot gescheitert, grau offen (0,5 %%). Alle FTMO-Werte der IS-besten Kombinationen enthalten den IS-Zeitraum, auf dem sie ausgewählt wurden – nur als Obergrenze lesen.</p>
<h3>Portfolio (Risiko je Trade geteilt)</h3>%s
<h3>Details</h3>%s
<h2>Kalibrierung F1–F5 (nur IS, je Asset-Klasse, gepoolt über alle K2-Varianten)</h2><table><tr><th>Klasse</th><th class=num>Ø R IS ohne Filter (n)</th><th>F1</th><th>F2</th><th>F3</th><th>F4</th><th>F5</th></tr>%s</table>
<p class=sm>F3 nutzt CFD-Tickvolumen (Anzahl Kursänderungen, kein echtes Volumen) – für FX nur schwacher Ersatz. Filter werden auf die gefundenen Setups angewendet (ein verworfener Ausbruch gibt keinen späteren Ausbruch frei – Näherung).</p>
<p class=sm>Alle %d Kombinationen mit allen Kennzahlen: <a href="archiv.html">archiv.html</a> · ergebnis.json.</p></body></html>''' % (
        css, datetime.date.today().strftime('%d.%m.%Y'), SEED, len(C), sum(c['fdr'] for c in C), len(passed),
        'Keine Kombination erfüllt alle Kriterien → K2 und K5 in dieser Form <b>verwerfen</b> bzw. nur mit neuen Daten (weitere Epics) erneut prüfen.' if not passed else 'Empfehlungen siehe Ranking.',
        ', '.join('%s (%s → %s, %s Monate)' % (e, q['from'], q['to'], q['months']) for e, q in QUAL.items()),
        ', '.join('%s: %s' % x for x in excl) or 'keine (alle drei Epics ≥ 18 Monate, &lt; 2 %% fehlende Kerzen)',
        ('<table>%s<tbody>%s</tbody></table>' % (HEAD, ''.join(row(c, i + 1) for i, c in enumerate(passed)))) if passed else '<div class=box>Keine Kombination hat alle Kriterien erfüllt.</div>',
        ('<ul>%s</ul>' % rec) if rec else '', mat, agg_rows, HEAD, best_info, corr_tab, pct(base_pass), port_html or '<p>Zu wenige unkorrelierte Kandidaten.</p>', detail, calib, len(C))
    open(os.path.join(OUT, 'report.html'), 'w').write(H)
    # Archiv (alle Kombinationen, kompakt)
    arch = sorted(C, key=lambda c: (c['session'], c['strategy'], -(c['m'].get('exp_oos') or -9)))
    rows = ''.join('<tr><td>%s</td><td>%s</td><td>%s</td><td class=num>%s</td><td class=num>%s</td><td class=num>%s</td><td class=num>%s</td><td class=num>%s</td><td class=num>%s</td><td>%s</td></tr>' % (
        esc(RUNS[c['session']]['label']), esc(c['vid']), esc(c['filt']), c['m'].get('n', 0), c['m'].get('n_oos', '–'), fr(c['m'].get('exp')), fr(c['m'].get('exp_oos')), ('%.3f' % c['p']), '✓' if c['fdr'] else '', esc(c['status'])) for c in arch)
    open(os.path.join(OUT, 'archiv.html'), 'w').write('<!DOCTYPE html><html lang=de><head><meta charset=utf-8><title>K1/K2/K5 Archiv</title><style>%s</style></head><body><h1>Archiv – alle Kombinationen</h1><table><tr><th>Session</th><th>Variante</th><th>Filter</th><th class=num>n</th><th class=num>OOS n</th><th class=num>Ø R</th><th class=num>Ø R OOS</th><th class=num>p (Bootstrap)</th><th>FDR</th><th>Status</th></tr>%s</table></body></html>' % (css, rows))
    slim = [dict(key=c['key'], session=c['session'], strategy=c['strategy'], variant=c['vid'], filter=c['filt'], filter_windows=c['fs'], status=c['status'], p=c['p'], fdr=c['fdr'],
                 robust=c.get('robust'), crit=c.get('crit'), consistency=c['consistency'], ftmo=(c.get('ftmo') or {}).get('0.5', {}).get('bootstrap') if c.get('ftmo') else None,
                 **{k: v for k, v in c['m'].items()}) for c in C]
    json.dump(dict(created=datetime.datetime.now().isoformat(timespec='seconds'), seed=SEED, calibration=cal, base_ftmo_pass=base_pass, portfolio={k: v for k, v in (port or {}).items() if k != 'calendar'},
                   aggregate=agg, combos=slim), open(os.path.join(OUT, 'ergebnis.json'), 'w'), default=str)
    ex = ['# K1/K2/K5 – ausgeschlossene Epics', '', '| Epic | Grund |', '|---|---|'] + ['| %s | %s |' % x for x in excl]
    ex += ['', 'Ohne Kursdaten im Lab (nicht getestet, Daten über die Capital-API nötig): ' + ', '.join(k for k in json.load(open(os.path.join(ROOT, 'config', 'epics.json')))['epics'].keys() if False) +
           'US500, US30, EU50, FR40, UK100, J225, AU200, HK50, GBPUSD, USDJPY, GOLD, SILVER, OIL_CRUDE, BTCUSD, ETHUSD, alle Aktien-CFDs.']
    open(os.path.join(OUT, 'ausgeschlossen.md'), 'w').write('\n'.join(ex) + '\n')
    print('bestanden:', len(passed), [c['key'] for c in passed][:10])
    for (sid, st), c in sorted(best_is.items()): print('IS-best', sid, st, c['key'], 'IS', fr(c['m']['exp_is']), 'OOS', fr(c['m']['exp_oos']), 'n_oos', c['m']['n_oos'], 'FDR', c['fdr'])

if __name__ == '__main__':
    main()
