#!/usr/bin/env python3
"""Freigabe-Prüfung vor jedem Livegang: feste Kriterien je Kandidat aus config/freigabe.json.

  python3 -I tools/freigabe.py   -> out/freigabe/bericht.md + ergebnis.json

Kriterien (Schwellen in config/freigabe.json, vorher festgelegt):
  K1 Coinflip:        Richtung trägt Information, p < 0,05 (tools/coinflip.js)
  K2 Auswahl:         p < 0,05 auch wenn in jedem Münzwurf-Lauf die beste Variante des Marktes genommen wird (tools/coinflip.js --select)
  K3 Plateau-Pflicht: jede getunte Größe: alle Nachbarwerte positiv und ≥ 50 % des Kandidaten (Ø R); ohne getunte Größe „entfällt“
  K4 Tagesrenditen:   t (Tage) ≥ 2, beide Hälften positiv, kein Tag ≤ −4 % (tools/tagesrendite.py, netto)
  K5 Tresor:          einmal geöffnet und bestanden (Eintrag in config/freigabe.json + config/tresor_protokoll.jsonl)
  K6 Forward-Test:    bestanden (Eintrag)
Freigabe nur, wenn alle Kriterien erfüllt sind (entfällt zählt als erfüllt).
Quellen: global unter "quellen"; ein Kandidat kann einzelne Quellen mit eigenem "quellen"-Eintrag ersetzen.
"""
import os, json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
J = lambda p: json.load(open(os.path.join(ROOT, p))) if os.path.exists(os.path.join(ROOT, p)) else None


def mean_r(run, vid):
    d = J(os.path.join(run, vid, 'result.json'))
    if not d or not d['trades']: return None
    return sum(t['R'] for t in d['trades']) / len(d['trades'])


def check(c, K, src):
    src = {**src, **(c.get('quellen') or {})}  # Kandidat darf eigene Quellen haben (z. B. Review-Läufe auf Dukascopy)
    out = {}
    cf = {r['id']: r for r in (J(src['coinflip']) or {}).get('results', [])}.get(c['id'])
    out['K1 Coinflip'] = (None, 'kein Lauf') if not cf else (cf['p'] < K['coinflip_p'], 'p %.3f' % cf['p'])
    sel = (J(src['auswahl']) or {}).get('markets', {}).get(c.get('auswahl') or c['markt'], {})
    v = next((x for x in sel.get('variants', []) if x['id'] == c['id']), None)
    out['K2 Auswahl'] = (None, 'kein Lauf') if not v else (v['pSel'] < K['auswahl_p'], 'p %.3f (beste von %d)' % (v['pSel'], sel['nVariants']))
    pl = c.get('plateau')
    if not pl: out['K3 Plateau'] = (True, 'entfällt (keine getunte Größe)')
    else:
        me = mean_r(pl['run'], c['id']); nb = {n: mean_r(pl['run'], n) for n in pl['nachbarn']}
        ok = me is not None and all(x is not None and x > 0 and x >= K['plateau_min_anteil'] * me for x in nb.values())
        out['K3 Plateau'] = (ok, '%s: Kandidat %+.3f, Nachbarn %s' % (pl['groesse'], me or 0, ', '.join('%s %+.3f' % (n.split('-')[-1], x or 0) for n, x in nb.items())))
    td = (J(src['tage']) or {}).get(c['id'])
    if not td: out['K4 Tage'] = (None, 'kein Lauf')
    else:
        ok = td['t'] >= K['tage_t'] and td['half1'] > 0 and td['half2'] > 0 and td['worst'] > K['tag_schlechtester_pct']
        out['K4 Tage'] = (ok, 't %.1f, Hälften %+.3f/%+.3f %%/Tag, schlechtester Tag %.2f %%' % (td['t'], td['half1'], td['half2'], td['worst']))
    out['K5 Tresor'] = (c['tresor'].get('bestanden'), c['tresor'].get('text', '')) if c.get('tresor') else (None, 'noch nicht geöffnet')
    out['K6 Forward'] = (c['forward'].get('bestanden'), c['forward'].get('text', '')) if c.get('forward') else (None, 'noch nicht gelaufen')
    return out


def main():
    cfg = J('config/freigabe.json'); K, src = cfg['kriterien'], cfg['quellen']; res = {}
    md = ['# Freigabe-Prüfung', '', 'Feste Kriterien aus `config/freigabe.json`. ✅ erfüllt · ❌ nicht erfüllt · ⏳ offen. Freigabe nur, wenn alles ✅.', '']
    sym = lambda x: '✅' if x is True else ('❌' if x is False else '⏳')
    for c in cfg['kandidaten']:
        r = check(c, K, src); free = all(v[0] is True for v in r.values()); res[c['id']] = dict(freigabe=free, **{k: dict(ok=v[0], text=v[1]) for k, v in r.items()})
        md += ['## %s – %s' % (c['id'], 'FREIGEGEBEN' if free else 'nicht freigegeben'), '', '| Kriterium | | Wert |', '|---|---|---|']
        md += ['| %s | %s | %s |' % (k, sym(v[0]), v[1]) for k, v in r.items()] + ['']
    os.makedirs(os.path.join(ROOT, 'out', 'freigabe'), exist_ok=True)
    json.dump(res, open(os.path.join(ROOT, 'out', 'freigabe', 'ergebnis.json'), 'w'), indent=1, ensure_ascii=False)
    open(os.path.join(ROOT, 'out', 'freigabe', 'bericht.md'), 'w').write('\n'.join(md) + '\n'); print('\n'.join(md))


if __name__ == '__main__':
    main()
