#!/usr/bin/env python3
"""Legacy-Bots + aussichtsreiche Varianten auf den vollen M5-Daten (out/live-voll, bin/live.js run --out out/live-voll).

  python3 -I tools/vollauswertung.py   -> out/live-voll/hold-out.md + hold-out.json

Trennung nach dem Zeitraum, auf dem die Varianten gefunden wurden (Selektion, Läufe 03.–05.11.2026):
  US100 + FTMO: 02.09.2024 – 13.10.2026  -> Hold-out = 02.01.–30.08.2024 und ab 14.10.2026
  DE40:         02.01.2024 – 13.10.2026  -> Hold-out = ab 14.10.2026
  EURUSD:       02.09.2024 – 13.10.2026  -> Hold-out = ab 14.10.2026
Ein Filter/eine Variante „hält“, wenn sie im Hold-out besser als ihre Basis ist (gleiche Tage, Δ Ø R > 0).
"""
import os, json, glob, math

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, 'out', 'live-voll')
SEL = {'US100': ('2024-09-02', '2026-10-13'), 'DE40': ('2024-01-02', '2026-10-13'), 'EURUSD': ('2024-09-02', '2026-10-13')}
LEGACY = ['nas-fib50-lb2', 'nas-fib50-lb3', 'nas-fib61-lb1', 'nas-fib61-lb2', 'nas-fib61-lb3', 'nas-f618atr', 'ftmo-basis',
          'de40-basis', 'de40-confl3', 'de40-dist150', 'de40-q07', 'de40-adx25', 'de40-combo', 'eu-c1', 'eu-c2', 'eu-c3', 'eu-c4', 'eu-c5', 'eu-c6']
# Basis je Testvariante (für Varianten ohne base-Feld)
BASE = {'ftmo-slmax80': 'ftmo-basis', 'nas-f618-ma0': 'nas-f618atr', 'nas-f50lb2-ma0': 'nas-fib50-lb2', 'nas-f50lb3-ma0': 'nas-fib50-lb3',
        'nas-f61lb1-ma0': 'nas-fib61-lb1', 'nas-f61lb2-ma0': 'nas-fib61-lb2', 'nas-f61lb3-ma0': 'nas-fib61-lb3', 'nas-f618-ma0-er04': 'nas-f618atr',
        'nas-f618-ma0-h15': 'nas-f618atr', 'nas-f61lb1-ma0-h15': 'nas-fib61-lb1', 'nas-f50lb2-ma0-h15': 'nas-fib50-lb2', 'nas-f618-h15': 'nas-f618atr',
        'nas-f618-l2r1ext-h15': 'nas-f618atr', 'nas-f50lb2-h15mo': 'nas-fib50-lb2', 'de40-basis-mf': 'de40-basis', 'de40-confl3-mf': 'de40-confl3',
        'de40-dist150-mf': 'de40-dist150', 'de40-q07-mf': 'de40-q07', 'de40-adx25-mf': 'de40-adx25', 'de40-combo-mf': 'de40-combo',
        'eu-sbf': 'eu-c4', 'eu-sbf-tp075': 'eu-c4', 'eu-sbf-mifr-adx': 'eu-sbf', 'eu-sbf-tp075-mifr': 'eu-sbf-tp075', 'eu-c4-mifr-adx': 'eu-c4', 'eu-c6-mifr-adx': 'eu-c6'}

def st(rs):
    n = len(rs)
    if not n: return dict(n=0, avg=None, t=None, sum=0)
    m = sum(rs) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in rs) / (n - 1)) if n > 1 else 0
    return dict(n=n, avg=m, t=(m / sd * math.sqrt(n)) if sd else None, sum=sum(rs))

def seg(trades, sym):
    a, b = SEL[sym]
    sel = [t['R'] for t in trades if a <= t['date'] <= b]
    pre = [t['R'] for t in trades if t['date'] < a]
    post = [t['R'] for t in trades if t['date'] > b]
    return dict(all=st([t['R'] for t in trades]), sel=st(sel), pre=st(pre), post=st(post), hold=st(pre + post))

def f(x, d=3):
    return '–' if x is None else ('%+.*f' % (d, x)).replace('.', ',')

def main():
    R = {}
    for p in sorted(glob.glob(os.path.join(DIR, '*', 'result.json'))):
        d = json.load(open(p))
        R[d['id']] = dict(name=d['name'], symbol=d['symbol'], group=d['group'], period=d['period'], seg=seg(d['trades'], d['symbol']),
                          base=d.get('base') or BASE.get(d['id']))
    md = ['# Legacy-Bots und aussichtsreiche Varianten – volle M5-Daten', '',
          'Live-Code-Engine (`bin/live.js run --out out/live-voll`), Kerzen bis 03.11.2026. **Hold-out** = Zeitraum, der bei der Suche der Varianten '
          'nicht verwendet wurde: US100/FTMO 02.01.–30.08.2024 und ab 14.10.2026, DE40 und EURUSD nur ab 14.10.2026 (≈ 3 Wochen, wenige Trades).', '',
          '## Legacy-Bots (live)', '', '| Bot | Zeitraum | Trades | Ø R gesamt | t | Ø R Selektion | Hold-out Trades | Ø R Hold-out | t Hold-out | davon 2024 Jan–Aug |',
          '|---|---|---|---|---|---|---|---|---|---|']
    for k in LEGACY:
        if k not in R: md.append('| %s | fehlt | | | | | | | | |' % k); continue
        s = R[k]['seg']
        md.append('| %s | %s → %s | %d | %s | %s | %s | %d | %s | %s | %s (%d) |' % (R[k]['name'], R[k]['period']['from'], R[k]['period']['to'], s['all']['n'], f(s['all']['avg']), f(s['all']['t'], 1),
                  f(s['sel']['avg']), s['hold']['n'], f(s['hold']['avg']), f(s['hold']['t'], 1), f(s['pre']['avg']), s['pre']['n']))
    md += ['', '## Aussichtsreiche Varianten gegen ihre Basis', '',
           '| Variante | Basis | Trades | Ø R gesamt | t | Δ Selektion | Hold-out Trades | Ø R Hold-out | Basis Hold-out | **Δ Hold-out** | hält? |', '|---|---|---|---|---|---|---|---|---|---|---|']
    held = []
    for k, v in R.items():
        if k in LEGACY: continue
        b = R.get(v['base'])
        s = v['seg']
        if not b: md.append('| %s | %s (fehlt) | %d | %s | %s | | | | | | |' % (v['name'], v['base'], s['all']['n'], f(s['all']['avg']), f(s['all']['t'], 1))); continue
        bs = b['seg']
        dsel = (s['sel']['avg'] or 0) - (bs['sel']['avg'] or 0)
        dh = None if s['hold']['avg'] is None or bs['hold']['avg'] is None else s['hold']['avg'] - bs['hold']['avg']
        ok = dh is not None and dh > 0 and s['hold']['n'] >= 20
        verdict = 'zu wenige Trades' if s['hold']['n'] < 20 else ('ja' if ok else 'nein')
        held.append(dict(id=k, base=v['base'], d_sel=dsel, d_hold=dh, n_hold=s['hold']['n'], hold=s['hold']['avg'], verdict=verdict, avg=s['all']['avg'], t=s['all']['t']))
        md.append('| %s | %s | %d | %s | %s | %s | %d | %s | %s | **%s** | %s |' % (v['name'], b['name'], s['all']['n'], f(s['all']['avg']), f(s['all']['t'], 1), f(dsel),
                  s['hold']['n'], f(s['hold']['avg']), f(bs['hold']['avg']), f(dh), verdict))
    json.dump(dict(sel=SEL, variants=R, compare=held), open(os.path.join(DIR, 'hold-out.json'), 'w'), indent=1)
    open(os.path.join(DIR, 'hold-out.md'), 'w').write('\n'.join(md) + '\n')
    print('\n'.join(md))

if __name__ == '__main__':
    main()
