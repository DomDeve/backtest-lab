#!/usr/bin/env python3
"""Auswertung der Läufe auf der langen Dukascopy-Historie (Entwicklungsjahre, Tresor-Jahre versiegelt).

  python3 -I tools/langauswertung.py [--run out/live-lang]   -> <run>/lang.md + lang.json

Je Variante: Trades, Ø R netto, t, Ø R je Jahr (Tresor-Jahre fehlen per Konstruktion), Anteil positiver Jahre, Zeitdrittel,
Jahre 2015–2017 (Indizes ohne Nachtkurse) getrennt ausgewiesen, Vergleich zur Basis (gleiche Jahre).
"""
import os, sys, json, math, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NIGHT_GAP = {'2015', '2016', '2017'}  # Dukascopy-Indizes nur 07–21 UTC


def st(x):
    n = len(x)
    if n < 2: return (sum(x) / n if n else None), None
    m = sum(x) / n; sd = math.sqrt(sum((v - m) ** 2 for v in x) / (n - 1))
    return m, (m / sd * math.sqrt(n) if sd else None)


def summarize(trades, index=True):
    R = [t['R'] for t in trades]; m, t = st(R)
    by = collections.defaultdict(list)
    for x in trades: by[x['date'][:4]].append(x['R'])
    years = {y: dict(n=len(v), avg=sum(v) / len(v)) for y, v in sorted(by.items())}
    srt = sorted(trades, key=lambda x: x['entryT']); k = len(srt) // 3
    thirds = [st([x['R'] for x in part])[0] for part in (srt[:k], srt[k:2 * k], srt[2 * k:])] if k else []
    clean = [x['R'] for x in trades if not (index and x['date'][:4] in NIGHT_GAP)]
    return dict(n=len(R), avg=m, t=t, years=years, pos_years=sum(v['avg'] > 0 for v in years.values()), n_years=len(years),
                thirds=thirds, avg_ohne_1517=st(clean)[0] if clean else None)


def main():
    a = sys.argv[1:]; run = a[a.index('--run') + 1] if '--run' in a else 'out/live-lang'
    base = os.path.join(ROOT, run); res = {}
    for vid in sorted(os.listdir(base)):
        p = os.path.join(base, vid, 'result.json')
        if not os.path.exists(p): continue
        d = json.load(open(p))
        if not d['trades']: continue
        res[vid] = dict(name=d['name'], symbol=d['symbol'], base=d.get('base'), period=d['period'], **summarize(d['trades'], d['symbol'] != 'EURUSD'))
    g = lambda x, k=3: '–' if x is None else ('%+.*f' % (k, x)).replace('.', ',')
    years = sorted({y for r in res.values() for y in r['years']})
    md = ['# Lange Historie (Dukascopy, Entwicklungsjahre)', '', f'Lauf `{run}`; R netto (Kosten, FTMO mit News-Sperre). Tresor-Jahre fehlen (versiegelt). '
          '2015–2017: Indizes ohne Nachtkurse (Spalte „ohne 15–17“).', '',
          '| Variante | Trades | Ø R | t | Jahre > 0 | Drittel | ohne 15–17 | ' + ' | '.join(years) + ' |', '|---|---|---|---|---|---|---|' + '---|' * len(years)]
    for vid, r in res.items():
        md.append(f"| {r['name']} | {r['n']} | {g(r['avg'])} | {g(r['t'], 1)} | {r['pos_years']}/{r['n_years']} | {' / '.join(g(x, 2) for x in r['thirds'])} | {g(r['avg_ohne_1517'])} | "
                  + ' | '.join(g(r['years'][y]['avg'], 2) if y in r['years'] else '' for y in years) + ' |')
    json.dump(res, open(os.path.join(base, 'lang.json'), 'w'), indent=1, ensure_ascii=False)
    open(os.path.join(base, 'lang.md'), 'w').write('\n'.join(md) + '\n'); print('\n'.join(md))


if __name__ == '__main__':
    main()
