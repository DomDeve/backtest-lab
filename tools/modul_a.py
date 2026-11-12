#!/usr/bin/env python3
"""Modul A (Robustheit) + Modul B (FTMO) für alle Varianten im Trade-Log. Liest nur out/tradelog/tradelog.sqlite.

Aufruf:  python3 tools/modul_a.py   -> out/analyse/robustheit.json + robustheit.html

Je Variante: IS/OOS (70/30), 10 Zeitblöcke, PF/Expectancy ohne besten bzw. 3 beste Trades, Bootstrap-95-%-KI,
Kostenanteil, Trades/Woche, Zufallskontrolle gegen die Basis (OOS), FTMO 2-Step (Modul B).
Entscheidungsregel (besser als Basis): OOS-Plus >= 0,05R, über p95 der Zufallskontrolle, >= 7/10 Blöcke positiv,
PF ohne besten Trade > 1, Kostenanteil < 40 %, FTMO-Bestehensquote (0,5 %) nicht schlechter, >= 1 Trade/Woche.
Ranking nur mit >= 300 OOS-Trades (sonst „nicht aussagekräftig“). Feste Seeds.
"""
import sqlite3, json, os, sys, random, datetime, statistics, html
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ftmo_lib as FL

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, 'out', 'tradelog', 'tradelog.sqlite')
OUT = os.path.join(ROOT, 'out', 'analyse')
MIN_OOS = 300
RISKS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0]
SEED = 7
mean = lambda v: sum(v) / len(v) if v else None

def pf(R):
    gp = sum(r for r in R if r > 0); gl = -sum(r for r in R if r < 0)
    return gp / gl if gl else None

def boot(R, rnd, B=1000):
    n = len(R)
    if n < 2: return None
    ms, ws = [], []
    for _ in range(B):
        s = [R[rnd.randrange(n)] for _ in range(n)]
        ms.append(sum(s) / n); ws.append(sum(1 for r in s if r > 0) / n)
    ms.sort(); ws.sort()
    return dict(exp=(ms[int(.025 * B)], ms[int(.975 * B) - 1]), win=(ws[int(.025 * B)], ws[int(.975 * B) - 1]))

def weekdays(a, b):
    d, e, out = datetime.date.fromisoformat(a), datetime.date.fromisoformat(b), []
    while d <= e:
        if d.weekday() < 5: out.append(d.isoformat())
        d += datetime.timedelta(days=1)
    return out

def random_p95(R, k, rnd, B=1000):
    """95. Perzentil des Ø R von k zufällig gezogenen Trades aus R (ohne Zurücklegen)."""
    if not R or k <= 0 or k > len(R): return None
    vals = sorted(sum(rnd.sample(R, k)) / k for _ in range(B))
    return vals[int(.95 * B) - 1]

def analyse(con, full_ftmo_ids):
    rnd = random.Random(SEED)
    V = {r[0]: dict(zip(['id', 'name', 'category', 'workflow', 'base', 'instrument', 'from', 'to', 'cut', 'n', 'risk'], r)) for r in con.execute('SELECT * FROM variants')}
    out = {}
    for vid, v in V.items():
        rows = con.execute('SELECT trade_date, exit_date, entry_time, r_net, r_gross, mae_r, sample FROM trades WHERE variant_id=? ORDER BY entry_time', (vid,)).fetchall()
        if not rows: continue
        R = [x[3] for x in rows]; Ris = [x[3] for x in rows if x[6] == 'IS']; Roos = [x[3] for x in rows if x[6] == 'OOS']
        days = weekdays(v['from'], v['to']); weeks = len(days) / 5
        # 10 zeitliche Blöcke (gleich lange Kalenderabschnitte)
        nb = 10; blocks = [[] for _ in range(nb)]
        for x in rows:
            i = min(nb - 1, int(days.index(x[0]) / len(days) * nb)) if x[0] in days else None
            if i is not None: blocks[i].append(x[3])
        bexp = [mean(b) for b in blocks]
        srt = sorted(R, reverse=True)
        gross = sum(x[4] for x in rows); net = sum(R)
        cost_share = (gross - net) / gross if gross > 0 else None
        a = dict(id=vid, name=v['name'], category=v['category'], workflow=v['workflow'], base=v['base'], instrument=v['instrument'],
                 n=len(R), n_is=len(Ris), n_oos=len(Roos), exp=mean(R), exp_is=mean(Ris), exp_oos=mean(Roos), win=sum(1 for r in R if r > 0) / len(R),
                 pf=pf(R), pf_wo1=pf(srt[1:]), pf_wo3=pf(srt[3:]), exp_wo1=mean(srt[1:]), exp_wo3=mean(srt[3:]),
                 blocks=bexp, blocks_pos=sum(1 for b in bexp if b is not None and b > 0), ci=boot(R, rnd),
                 cost_share=cost_share, gross_negative=gross <= 0, per_week=len(R) / weeks, aussagekraeftig=len(Roos) >= MIN_OOS)
        tl = [dict(entry_date=x[0], exit_date=x[1] or x[0], entry_time=x[2], r=x[3], mae=x[5]) for x in rows]
        dd = FL.to_days(tl, days)
        risks = RISKS if vid in full_ftmo_ids else [0.5]
        a['ftmo'] = {str(rk): FL.simulate(dd, days, rk, runs=1000 if vid in full_ftmo_ids else 300, seed=SEED) for rk in risks}
        out[vid] = a
        print(f"{vid:24s} n {a['n']:5d} OOS {a['n_oos']:4d} exp {a['exp']:+.3f} blocks+ {a['blocks_pos']}/10")
    # Vergleich mit der Basis (Live-Variante) + Entscheidungsregel
    for vid, a in out.items():
        b = out.get(a['base']) if a['base'] and a['base'] != vid else None
        if not b: a['decision'] = None; continue
        base_oos = [x[0] for x in con.execute("SELECT r_net FROM trades WHERE variant_id=? AND sample='OOS'", (b['id'],))]
        p95 = random_p95(base_oos, a['n_oos'], rnd) if a['n_oos'] <= len(base_oos) else None
        fa, fb = a['ftmo']['0.5']['bootstrap']['both'], b['ftmo']['0.5']['bootstrap']['both']
        crit = dict(oos_plus=(a['exp_oos'] or -9) - (b['exp_oos'] or 0) >= 0.05,
                    zufall=(p95 is not None and (a['exp_oos'] or -9) > p95) if p95 is not None else None,
                    bloecke=a['blocks_pos'] >= 7, pf_ohne_besten=(a['pf_wo1'] or 0) > 1,
                    kosten=a['cost_share'] is not None and a['cost_share'] < 0.4,
                    ftmo=(fa or 0) >= (fb or 0) - 0.01, frequenz=a['per_week'] >= 1)
        a['decision'] = dict(crit=crit, p95=p95, d_oos=(a['exp_oos'] or 0) - (b['exp_oos'] or 0),
                             besser=all(v is True for v in crit.values()))
    return out

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    con = sqlite3.connect(DB)
    live = [r[0] for r in con.execute("SELECT variant_id FROM variants WHERE category='live'")]
    res = analyse(con, set(live))
    json.dump(dict(created=datetime.datetime.now().isoformat(timespec='seconds'), min_oos=MIN_OOS, seed=SEED, risks=RISKS, variants=res),
              open(os.path.join(OUT, 'robustheit.json'), 'w'), default=str)
    print('geschrieben', os.path.join(OUT, 'robustheit.json'))
