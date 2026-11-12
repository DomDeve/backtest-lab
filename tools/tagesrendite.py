#!/usr/bin/env python3
"""Ergebnis pro Handelstag statt pro Trade: Tagesrenditen aus der Equity-Kurve eines Laufs (bin/live.js result.json).

  python3 -I tools/tagesrendite.py [--run out/live-kosten] [id …]   -> <run>/tagesrendite.md + tagesrendite.json

Je Werktag im Lauf-Zeitraum (auch Tage ohne Trade = 0 %): Summe R der an diesem Tag (Berlin, Ausstiegsdatum) geschlossenen Trades
× Risiko je Trade (riskPercent des Laufs) = Tagesrendite in % bei festem Risiko (die Läufe rechnen ohne Zinseszins; ein Konto in % des
aktuellen Stands würde bei Verlust-Bots negativ und die Prozentwerte unsinnig). Drawdown additiv auf 100 %. Kennzahlen: Ø, σ, Sharpe p. a. (√252), t-Wert, Anteil positiver Handelstage,
schlechtester/bester Tag, max. Drawdown der Tages-Equity, Tage ≤ −4 % / ≤ −5 % (FTMO-Tagesgrenze; nur realisiert – offene Verluste
innerhalb des Tages siehe tools/ftmo_lib.py), Ø je Jahr und Hälften. R im Lauf ist netto (Kosten aus src/core/costs.js).
"""
import os, sys, json, math, datetime, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def weekdays(a, b):
    d = datetime.date.fromisoformat(a); e = datetime.date.fromisoformat(b)
    while d <= e:
        if d.weekday() < 5: yield d.isoformat()
        d += datetime.timedelta(days=1)


def daily_returns(trades, risk_pct, frm, to):
    """Liste (Datum, Rendite in %) je Werktag = Σ R des Tages × risk_pct. trades: dicts mit exitDate, R."""
    r = collections.defaultdict(float)
    for t in trades: r[t['exitDate']] += t['R']
    return [(d, r.get(d, 0.0) * risk_pct) for d in weekdays(frm, to)]


def stats(rets):
    x = [r for _, r in rets]; n = len(x)
    if n < 2: return None
    m = sum(x) / n; sd = math.sqrt(sum((v - m) ** 2 for v in x) / (n - 1))
    eq, peak, dd = 100.0, 100.0, 0.0
    for v in x:
        eq += v; peak = max(peak, eq); dd = min(dd, (eq - peak) / 100)
    act = [v for v in x if v != 0]
    half = n // 2
    by_year = collections.defaultdict(list)
    for d, v in rets: by_year[d[:4]].append(v)
    return dict(days=n, active_days=len(act), mean=m, sd=sd, sharpe=(m / sd * math.sqrt(252)) if sd else None, t=(m / sd * math.sqrt(n)) if sd else None,
                pos_share=(sum(v > 0 for v in act) / len(act)) if act else None, worst=min(x), best=max(x), maxdd=100 * dd,
                days_le4=sum(v <= -4 for v in x), days_le5=sum(v <= -5 for v in x),
                half1=sum(x[:half]) / half, half2=sum(x[half:]) / (n - half), by_year={y: sum(v) / len(v) for y, v in sorted(by_year.items())})


def main():
    a = sys.argv[1:]; run = a[a.index('--run') + 1] if '--run' in a else 'out/live-kosten'
    want = [x for i, x in enumerate(a) if not x.startswith('--') and (i == 0 or a[i - 1] != '--run')]
    base = os.path.join(ROOT, run); res = {}
    for vid in sorted(os.listdir(base)):
        p = os.path.join(base, vid, 'result.json')
        if not os.path.exists(p) or (want and vid not in want): continue
        d = json.load(open(p)); T = sorted(d['trades'], key=lambda t: t['exitT'])
        if not T: continue
        risk = (d.get('engine') or {}).get('riskPercent', 1)
        s = stats(daily_returns(T, risk, d['period']['from'], d['period']['to']))
        R = [t['R'] for t in T]; mR = sum(R) / len(R); sdR = math.sqrt(sum((v - mR) ** 2 for v in R) / (len(R) - 1))
        res[vid] = dict(name=d['name'], trades=len(T), mean_R=mR, t_R=mR / sdR * math.sqrt(len(R)), **s)
    g = lambda x, k=3: '–' if x is None else ('%+.*f' % (k, x)).replace('.', ',')
    md = ['# Tagesrenditen (Ergebnis pro Handelstag)', '', f'Lauf `{run}` (R netto inkl. Kosten). Rendite je Werktag in % des Kontostands zu Tagesbeginn, Tage ohne Trade = 0.', '',
          '| Variante | Trades | Ø R | t (Trades) | Tage aktiv | Ø %/Tag | **t (Tage)** | Sharpe p. a. | Tage > 0 | schlechtester Tag | max. DD | Tage ≤ −4 % | 1./2. Hälfte %/Tag |',
          '|---|---|---|---|---|---|---|---|---|---|---|---|---|']
    for vid, r in res.items():
        md.append(f"| {r['name']} | {r['trades']} | {g(r['mean_R'])} | {g(r['t_R'], 1)} | {r['active_days']}/{r['days']} | {g(r['mean'])} | **{g(r['t'], 1)}** | {g(r['sharpe'], 2)} | "
                  f"{round(100 * r['pos_share']) if r['pos_share'] is not None else '–'} % | {g(r['worst'], 2)} % | {g(r['maxdd'], 1)} % | {r['days_le4']} | {g(r['half1'])} / {g(r['half2'])} |")
    json.dump(res, open(os.path.join(base, 'tagesrendite.json'), 'w'), indent=1)
    open(os.path.join(base, 'tagesrendite.md'), 'w').write('\n'.join(md) + '\n')
    print('\n'.join(md))


if __name__ == '__main__':
    main()
