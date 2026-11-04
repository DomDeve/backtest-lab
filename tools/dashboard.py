#!/usr/bin/env python3
"""Dashboard aller Substrategien aus den Live-Code-Läufen (out/live/<id>/result.json).

Aufruf:  python3 tools/dashboard.py            -> out/live/dashboard.html

Ideen-Stufen (Belastbarkeit absteigend):
  A  Backtest-Variante (eigener Lauf mit Original-Code + Patch), besser in beiden Zeithälften
  B  Filter von der Engine nachgerechnet (echter Re-Run, Folgeeffekte enthalten), robust in beiden Hälften
  C  Ausstiegs-Variante auf denselben Einstiegen, robust in beiden Hälften
  D  Näherung: Trades eines Segments aus der Trade-Liste entfernt (ohne Folgeeffekte), besser in beiden
     Hälften und allen drei Zeitdritteln. Data-Mining -> nur Hypothese.
Alles ist In-Sample. Nichts davon live übernehmen ohne Forward-Test (Schatten-Zwilling).
"""
import csv, json, math, os, html, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out', 'live')

# ---------------------------------------------------------------- Stammdaten
SUBS = [
    # id, Epic, Kurzname, Ort (Workflow · Node)
    ('ftmo-basis', 'US100', 'NAS F618ATR FTMO', 'd_ftmo · Code-Node v5.0-F618ATR-FTMO (FTMO via cTrader-Bridge)'),
    ('nas-f618atr', 'US100', 'NAS F618ATR', 'd_ilikebigbots · „Code Strategie NAS F618ATR“'),
    ('nas-fib50-lb2', 'US100', 'NAS Fib50 LB2', 'd_ilikebigbots · „Code Strategie NAS Fib50 LB2“'),
    ('nas-fib50-lb3', 'US100', 'NAS Fib50 LB3', 'd_ilikebigbots · „Code Strategie NAS Fib50 LB3“'),
    ('nas-fib61-lb1', 'US100', 'NAS Fib61 LB1', 'd_ilikebigbots · „Code Strategie NAS Fib61 LB1“'),
    ('nas-fib61-lb2', 'US100', 'NAS Fib61 LB2', 'd_ilikebigbots · „Code Strategie NAS Fib61 LB2“'),
    ('nas-fib61-lb3', 'US100', 'NAS Fib61 LB3', 'd_ilikebigbots · „Code Strategie NAS Fib61 LB3“'),
    ('de40-basis', 'DE40', 'DE40 LVN Basis', 'd_ilikebigbots · „Code Strategie DE40 Basis“ (Telegram „DAX ORB V2“)'),
    ('de40-confl3', 'DE40', 'DE40 LVN Confluence 3', 'd_ilikebigbots · „Code Strategie DE40 Confluence 3“ (Telegram „DAX ORB V“)'),
    ('de40-dist150', 'DE40', 'DE40 LVN Distance 150', 'd_ilikebigbots · „Code Strategie DE40 Distance 150“ (Telegram „DAX ORB V3“)'),
    ('de40-q07', 'DE40', 'DE40 LVN Quality 0.7', 'd_ilikebigbots · „Code Strategie DE40 Quality 0.7“ (Telegram „DAX ORB V4“)'),
    ('de40-adx25', 'DE40', 'DE40 LVN ADX 25', 'd_ilikebigbots · „Code Strategie DE40 ADX 25“ (Telegram „DAX ORB V5“)'),
    ('de40-combo', 'DE40', 'DE40 LVN Combo', 'd_ilikebigbots · „Code Strategie DE40 Combo“ (Telegram „DAX ORB V6“)'),
    ('eu-c1', 'EURUSD', 'EURUSD C1 Legacy TP1', 'd_ilikebigbots · „Code Strategie EURUSD C1“'),
    ('eu-c2', 'EURUSD', 'EURUSD C2 Pullback TP1', 'd_ilikebigbots · „Code Strategie EURUSD C2“'),
    ('eu-c3', 'EURUSD', 'EURUSD C3 Pullback TP1.5', 'd_ilikebigbots · „Code Strategie EURUSD C3“'),
    ('eu-c4', 'EURUSD', 'EURUSD C4 Break&Retest Market TP1.5', 'd_ilikebigbots · „Code Strategie EURUSD C4“'),
    ('eu-c5', 'EURUSD', 'EURUSD C5 Break&Retest Limit TP1.5', 'd_ilikebigbots · „Code Strategie EURUSD C5“'),
    ('eu-c6', 'EURUSD', 'EURUSD C6 Break&Retest Market TP1', 'd_ilikebigbots · „Code Strategie EURUSD C6“'),
]

# Einordnung + Handlung je Substrategie (von Hand formuliert, Zahlen aus den Läufen)
VERDICT = {
    'ftmo-basis': ('weiter', 'Weiterführen, Zwilling SL_MAX 80',
        'Bester Bot im Portfolio, Vorteil statistisch belegt. Das Geld kommt aus Trades mit kleinem SL; Trades mit SL > ~80 Pkt verdienen nichts. '
        'Nach Kalenderhälften stabil (+0,29R / +0,25R); nach Trade-Anzahl geteilt fällt die 2. Hälfte aber auf etwa die Hälfte – Risiko nicht erhöhen.'),
    'nas-f618atr': ('weiter', 'Weiterführen',
        'Gleiche Logik wie FTMO, belastbar positiv. Short-Trades tragen den Großteil des Ergebnisses. Die ATR-Pause ist der Kern: ohne sie fällt Ø auf etwa die Hälfte. '
        'Der Vorteil lässt nach: 1. Kalenderhälfte +0,31R, 2. Hälfte +0,19R je Trade.'),
    'nas-fib50-lb2': ('pruefen', 'Nur mit Filtern weiter testen',
        'Leicht positiv, aber statistisch nicht belegt. Montag und Long-Trades ziehen das Ergebnis nach unten.'),
    'nas-fib50-lb3': ('stopp', 'Abschalten (durch F618ATR ersetzt)',
        'Ø praktisch null. Filter heben den Schnitt höchstens auf ~+0,09R – kein eigenständiger Vorteil gegenüber F618ATR.'),
    'nas-fib61-lb1': ('stopp', 'Abschalten (durch F618ATR ersetzt)',
        'Kein Vorteil, Drawdown ~50R. Der Unterschied zu F618ATR ist der fehlende ATR-Filter – genau das zeigt auch der beste Filter hier (ruhige Tage raus).'),
    'nas-fib61-lb2': ('stopp', 'Abschalten (durch F618ATR ersetzt)',
        'Kein Vorteil, nur 40 % der Quartale positiv. Auch die beste getestete Achse (MA-Abstand) bringt nur Ø +0,05R.'),
    'nas-fib61-lb3': ('stopp', 'Abschalten (durch F618ATR ersetzt)',
        'Kein Vorteil. Filter verbessern nur auf ~+0,05R.'),
    'de40-basis': ('ueberarbeiten', 'Überarbeiten: TP verkürzen, sonst abschalten',
        'Negativ, aber mit klarer Ursache: rund zwei Drittel der Verlierer liegen zuerst ≥ 1R im Plus. Ein näheres Ziel (1,5R) dreht die Basis in beiden Zeithälften ins Plus. '
        'Das gilt für alle sechs LVN-Varianten – mit TP 1,5R liegen sie zwischen +0,14R (ADX 25) und +0,22R (Distance 150). Montag ist durchgehend der schlechteste Tag.'),
    'de40-confl3': ('stopp', 'Abschalten, LVN auf Basis + Distance 150 bündeln',
        'Negativ und schlechter als die Basis. Mit TP 1,5R wäre Ø ≈ +0,17R.'),
    'de40-dist150': ('ueberarbeiten', 'TP-Zwilling 1,5R neben der Basis',
        'Negativ, aber mit TP 1,5R die beste LVN-Variante (Ø ≈ +0,22R, Δ in beiden Hälften +0,27/+0,34R). Kandidat für den TP-Zwilling neben der Basis.'),
    'de40-q07': ('stopp', 'Abschalten, LVN auf Basis + Distance 150 bündeln',
        'Negativ, 2. Hälfte deutlich schwächer. Mit TP 1,5R Ø ≈ +0,21R.'),
    'de40-adx25': ('stopp', 'Abschalten, LVN auf Basis + Distance 150 bündeln',
        'Negativ, ADX-Filter verbessert die Basis nicht. Mit TP 1,5R nur Ø ≈ +0,14R – schwächste LVN-Variante.'),
    'de40-combo': ('stopp', 'Abschalten, LVN auf Basis + Distance 150 bündeln',
        'Negativ und schlechter als die Basis. Mit TP 1,5R Ø ≈ +0,20R.'),
    'eu-c1': ('stopp', 'Abschalten',
        'Statistisch belegt negativ. Kosten fressen das Ziel: ein TP von 1R bringt netto nur ~0,9R, und die Trefferquote reicht dafür nicht.'),
    'eu-c2': ('stopp', 'Abschalten', 'Belegt negativ. Besser als C1, aber weit von null entfernt.'),
    'eu-c3': ('stopp', 'Abschalten', 'Bester EURUSD-Bot, trotzdem belegt negativ. Freitag und Signale nach 16 Uhr besonders schwach.'),
    'eu-c4': ('stopp', 'Abschalten', 'Belegt negativ.'),
    'eu-c5': ('pruefen', 'Abschalten oder nur als Zwilling „TP 0,75R“',
        'Belegt negativ. Einziger EURUSD-Lichtblick: Mit TP 0,75R statt 1,5R wird C5 in beiden Zeithälften positiv. Vorsicht: Das Modell füllt Limits schon bei Berührung '
        '(optimistisch), und bei Zielen von wenigen Pips entscheidet genau das. Erst im Forward-Test glauben.'),
    'eu-c6': ('stopp', 'Abschalten', 'Belegt negativ.'),
}
VLABEL = {'weiter': ('Weiterführen', 'good'), 'forward': ('Forward-Test', 'good'), 'pruefen': ('Prüfen', 'warning'),
          'ueberarbeiten': ('Überarbeiten', 'serious'), 'stopp': ('Abschalten', 'critical')}
WD = {1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr'}

# ---------------------------------------------------------------- Hilfen
esc = lambda s: html.escape(str(s), quote=True)
def fr(x, d=2, sign=True):
    if x is None or (isinstance(x, float) and math.isnan(x)): return '–'
    s = f'{x:+.{d}f}' if sign else f'{x:.{d}f}'
    return s.replace('.', ',')
def fR(x, d=2): return fr(x, d) + 'R'
def fn(x, d=0): return f'{x:,.{d}f}'.replace(',', ' ').replace('.', ',')
def mean(v): return sum(v) / len(v) if v else float('nan')

def load(id_):
    with open(os.path.join(OUT, id_, 'result.json')) as f: return json.load(f)

with open(os.path.join(OUT, 'vergleich_varianten.csv')) as f:
    VAR = list(csv.DictReader(f))
VARMAP = {r['id']: r for r in VAR}

def trade_hour(t):
    hm = t.get('signalHm') or t.get('entryHm') or '00:00'
    return int(hm[:2])

def split_points(r):
    a = datetime.date.fromisoformat(r['period']['from']); b = datetime.date.fromisoformat(r['period']['to'])
    span = (b - a).days
    iso = lambda k: (a + datetime.timedelta(days=round(span * k))).isoformat()
    return iso(0.5), (iso(1 / 3), iso(2 / 3))

# ---------------------------------------------------------------- Ideen Stufe D (Näherung)
def approx_filters(trades, mid, thirds):
    """Entfernt einzelne Segmente aus der Trade-Liste. Nur Kandidaten, die in beiden Hälften und allen drei
    Dritteln besser werden. Liefert (Ideen, Anzahl getesteter Kandidaten)."""
    def part(ts):
        h1 = [t['R'] for t in ts if t['date'] < mid]; h2 = [t['R'] for t in ts if t['date'] >= mid]
        th = [[t['R'] for t in ts if t['date'] < thirds[0]], [t['R'] for t in ts if thirds[0] <= t['date'] < thirds[1]],
              [t['R'] for t in ts if t['date'] >= thirds[1]]]
        return h1, h2, th
    base = [t['R'] for t in trades]; bh1, bh2, bth = part(trades)
    cands = []
    for d in ('BUY', 'SELL'):
        cands.append(('dir', f'nur {"SELL" if d == "BUY" else "BUY"} (keine {d}-Trades)', lambda t, d=d: t['dir'] != d))
    for w in range(1, 6):
        cands.append(('wd', f'kein Handel am {WD[w]}', lambda t, w=w: t.get('wd') != w))
    hours = sorted({trade_hour(t) for t in trades})
    for h in hours:
        cands.append(('hour', f'keine Signale {h:02d}:00–{h:02d}:55', lambda t, h=h: trade_hour(t) != h))
    for h in hours:
        cands.append(('hour', f'keine Signale {h:02d}:00–{h + 1:02d}:55', lambda t, h=h: trade_hour(t) not in (h, h + 1)))
    for h in hours:
        cands.append(('hour', f'keine Signale ab {h:02d}:00', lambda t, h=h: trade_hour(t) < h))
    out = []
    for kind, label, keep in cands:
        kept = [t for t in trades if keep(t)]; rem = len(trades) - len(kept)
        if rem < 15 or len(kept) < 0.6 * len(trades): continue
        h1, h2, th = part(kept)
        d1, d2 = mean(h1) - mean(bh1), mean(h2) - mean(bh2)
        dth = [mean(a) - mean(b) for a, b in zip(th, bth)]
        if d1 > 0 and d2 > 0 and all(x > 0 for x in dth):
            ra = [t['R'] for t in trades if not keep(t)]
            out.append(dict(kind=kind, label=label, n=len(kept), removed=rem, remAvg=mean(ra), avg=mean([t['R'] for t in kept]),
                            sum=sum(t['R'] for t in kept), d=mean([t['R'] for t in kept]) - mean(base), d1=d1, d2=d2))
    out.sort(key=lambda x: -x['d'])
    best, seen = [], set()
    for o in out:  # je Art nur die beste
        # nur Segmente, die selbst Geld verlieren – sonst steigt Ø, aber Σ R sinkt
        if o['kind'] in seen or o['d'] < 0.03 or o['remAvg'] >= 0: continue
        seen.add(o['kind']); best.append(o)
    return best, len(cands)

# ---------------------------------------------------------------- Ideen sammeln
def ideas_for(id_, r, trades, mid, thirds):
    s = r['summary']; base = s['avgR']; ideas, donts = [], []
    # A: Test-Varianten mit dieser Basis
    for v in VAR:
        if v['base'] != id_: continue
        if v['id'] in dict((x[0], 1) for x in SUBS): continue  # Live-Geschwister nicht als Idee
        d, d1, d2 = float(v['delta_avg_r']), float(v['delta_h1']), float(v['delta_h2'])
        txt = (f'Backtest-Lauf mit Original-Code: {v["trades"]} Trades, Ø {fR(float(v["avg_r"]))} (Basis {fR(base)}), '
               f'Σ {fR(float(v["sum_r"]), 1)}, PF {fr(float(v["profit_factor"]), 2, False)}, p = {fr(float(v["p_value"]), 4, False)}. '
               f'Δ je Trade 1./2. Hälfte: {fR(d1)} / {fR(d2)}.')
        if v['better_both_halves'] == 'ja':
            ideas.append(dict(level='A', d=d, title=f'Variante „{v["name"]}“', text=txt))
        elif d1 < -0.03 and d2 < -0.03:
            donts.append(f'„{v["name"]}“: Ø {fR(d)} schlechter, in beiden Hälften ({fR(d1)} / {fR(d2)}).')
    # B: Filter (echter Re-Run durch die Engine)
    for t in r.get('filterTests') or []:
        if not t['robust']: continue
        d = t['newAvgR'] - base
        if d < 0.02: continue
        seg = t['segment']
        q = t.get('q')
        qtxt = f' Mehrfachtest-korrigiert q = {fr(q, 2, False)} → Zufallsfund nicht ausgeschlossen.' if q and q > 0.1 else ''
        ideas.append(dict(level='B', d=d, title=f'Keine Trades bei {seg}',
            text=f'Von der Engine nachgerechnet (mit Folgeeffekten): {s["n"]} → {t["newN"]} Trades, Ø {fR(base)} → {fR(t["newAvgR"])}, '
                 f'Σ {fR(s["sumR"], 1)} → {fR(t["newSumR"], 1)}. Δ je Trade 1./2. Hälfte {fR(t["deltaAvgR_H1"])} / {fR(t["deltaAvgR_H2"])}, '
                 f'Segment konsistent in {t["foldsConsistent"]} Zeitdritteln.{qtxt}'))
    # C: Ausstiege
    ex = r.get('exits') or {}
    for v in ex.get('variants', []):
        if v['robust'] and v['deltaAvgR'] >= 0.02:
            ideas.append(dict(level='C', d=v['deltaAvgR'], title=f'Ausstieg: {v["label"]}',
                text=f'Gleiche Einstiege, anderer Ausstieg: Ø {fR(base)} → {fR(v["avgR"])}, Trefferquote {fn(v["winRate"] * 100)} %. '
                     f'Δ 1./2. Hälfte {fR(v["deltaH1"])} / {fR(v["deltaH2"])}.'))
        elif v['deltaH1'] < 0 and v['deltaH2'] < 0 and v['deltaAvgR'] <= -0.03:
            donts.append(f'Ausstieg „{v["label"]}“: {fR(v["deltaAvgR"])} je Trade, schadet in beiden Hälften.')
    # D: Näherungen
    approx, ntests = approx_filters(trades, mid, thirds)
    for a in approx:
        ideas.append(dict(level='D', d=a['d'], title=a['label'][0].upper() + a['label'][1:],
            text=f'Die {a["removed"]} betroffenen Trades lagen bei Ø {fR(a["remAvg"])}. Ohne sie: {a["n"]} Trades, Ø {fR(a["avg"])}, '
                 f'Σ {fR(a["sum"], 1)}. Δ 1./2. Hälfte {fR(a["d1"])} / {fR(a["d2"])}, besser in allen 3 Dritteln. '
                 f'Näherung ohne Folgeeffekte, einer von {ntests} geprüften Kandidaten.'))
    order = {'A': 0, 'B': 1, 'C': 2, 'D': 3}
    ideas.sort(key=lambda i: (order[i['level']], -i['d']))
    return ideas, donts

# ---------------------------------------------------------------- Daten aufbereiten
rows = []
for id_, epic, short, where in SUBS:
    r = load(id_)
    trades = [t for t in r['trades'] if t.get('R') is not None]
    mid, thirds = split_points(r)
    s, st = r['summary'], r['stability']
    ideas, donts = ideas_for(id_, r, trades, mid, thirds)
    h1 = mean([t['R'] for t in trades if t['date'] < mid]); h2 = mean([t['R'] for t in trades if t['date'] >= mid])
    by = lambda f: {k: [t['R'] for t in trades if f(t) == k] for k in sorted({f(t) for t in trades})}
    rows.append(dict(id=id_, epic=epic, short=short, where=where, r=r, s=s, st=st, trades=trades, mid=mid,
                     ideas=ideas, donts=donts, verdict=VERDICT[id_], h1=h1, h2=h2,
                     dir=by(lambda t: t['dir']), wd=by(lambda t: t.get('wd')), hour=by(trade_hour),
                     var=VARMAP.get(id_), risk=r.get('risk', {}), mfe=(r.get('exits') or {}).get('mfe', {})))

# ---------------------------------------------------------------- SVG-Bausteine
def equity_svg(rw, w=640, h=150):
    rs = [t['R'] for t in rw['trades']]; cum, c = [], 0
    for x in rs: c += x; cum.append(c)
    lo, hi = min(0, min(cum)), max(0, max(cum)); pad = (hi - lo) * 0.08 or 1; lo -= pad; hi += pad
    X = lambda i: 40 + (w - 50) * i / max(1, len(cum) - 1)
    Y = lambda v: 10 + (h - 30) * (hi - v) / (hi - lo)
    pts = ' '.join(f'{X(i):.1f},{Y(v):.1f}' for i, v in enumerate(cum))
    midi = next((i for i, t in enumerate(rw['trades']) if t['date'] >= rw['mid']), len(cum) - 1)
    data = [[t['date'], round(v, 2), round(t['R'], 2)] for t, v in zip(rw['trades'], cum)]
    ticks = ''.join(f'<text x="34" y="{Y(v) + 4:.1f}" class="ax" text-anchor="end">{fn(v)}</text>'
                    f'<line x1="40" x2="{w - 10}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" class="grid"/>'
                    for v in nice_ticks(lo, hi))
    return (f'<svg class="eq" viewBox="0 0 {w} {h}" data-eq=\'{json.dumps(data)}\' data-x0="40" data-x1="{w - 10}" role="img" '
            f'aria-label="Kapitalkurve in R, Endstand {fR(cum[-1], 1)}">{ticks}'
            f'<line x1="40" x2="{w - 10}" y1="{Y(0):.1f}" y2="{Y(0):.1f}" class="zero"/>'
            f'<line x1="{X(midi):.1f}" x2="{X(midi):.1f}" y1="10" y2="{h - 20}" class="half"/>'
            f'<text x="{X(midi) + 4:.1f}" y="{h - 8}" class="ax">2. Hälfte ab {rw["mid"][:7]}</text>'
            f'<text x="40" y="{h - 8}" class="ax">{rw["trades"][0]["date"][:7]}</text>'
            f'<text x="{w - 10}" y="{h - 8}" class="ax" text-anchor="end">{rw["trades"][-1]["date"][:7]}</text>'
            f'<polyline points="{pts}" class="eqline"/>'
            f'<line class="cross" x1="0" x2="0" y1="10" y2="{h - 20}" visibility="hidden"/>'
            f'<circle class="dot" r="4" visibility="hidden"/></svg>')

def nice_ticks(lo, hi, n=4):
    span = hi - lo; step = 10 ** math.floor(math.log10(span / n)) if span > 0 else 1
    for m in (1, 2, 5, 10):
        if span / (step * m) <= n: step *= m; break
    v = math.ceil(lo / step) * step; out = []
    while v <= hi: out.append(v); v += step
    return out

def spark(rw, w=120, h=28):
    cum, c = [], 0
    for t in rw['trades']: c += t['R']; cum.append(c)
    lo, hi = min(0, min(cum)), max(0, max(cum)); rng = (hi - lo) or 1
    pts = ' '.join(f'{2 + (w - 4) * i / max(1, len(cum) - 1):.1f},{2 + (h - 4) * (hi - v) / rng:.1f}' for i, v in enumerate(cum))
    z = 2 + (h - 4) * hi / rng
    cls = 'pos' if cum[-1] >= 0 else 'neg'
    return (f'<svg class="spark" viewBox="0 0 {w} {h}" aria-label="Kapitalkurve {fR(cum[-1], 1)}">'
            f'<line x1="2" x2="{w - 2}" y1="{z:.1f}" y2="{z:.1f}" class="zero"/><polyline points="{pts}" class="sp {cls}"/></svg>')

def bars_svg(groups, labeler, title, w=300, h=130, minn=15):
    """Ø R je Gruppe, divergierend um 0 (blau = Gewinn, rot = Verlust)."""
    keys = list(groups.keys())
    if not keys: return ''
    vals = [mean(groups[k]) for k in keys]
    m = max(0.3, max(abs(v) for v in vals)); bw = (w - 30) / len(keys)
    Y0 = 12 + (h - 34) / 2; sc = (h - 34) / 2 / m
    out = [f'<figure class="bars"><figcaption>{esc(title)}</figcaption><svg viewBox="0 0 {w} {h}" role="img" aria-label="{esc(title)}">',
           f'<line x1="24" x2="{w - 4}" y1="{Y0:.1f}" y2="{Y0:.1f}" class="zero"/>',
           f'<text x="20" y="{12 + 4}" class="ax" text-anchor="end">{fr(m, 1)}</text>',
           f'<text x="20" y="{h - 22 + 4}" class="ax" text-anchor="end">{fr(-m, 1)}</text>']
    for i, (k, v) in enumerate(zip(keys, vals)):
        n = len(groups[k]); x = 26 + i * bw; bh = abs(v) * sc
        y = Y0 - bh if v >= 0 else Y0
        cls = ('pos' if v >= 0 else 'neg') + (' low' if n < minn else '')
        tip = f'{labeler(k)}: Ø {fR(v)} · {n} Trades · Σ {fR(sum(groups[k]), 1)}' + (' · wenig Daten' if n < minn else '')
        out.append(f'<rect x="{x - 1:.1f}" y="10" width="{bw:.1f}" height="{h - 30}" class="hit" data-tip="{esc(tip)}"/>')
        out.append(f'<rect x="{x + 1:.1f}" y="{y:.1f}" width="{max(2, bw - 4):.1f}" height="{max(1, bh):.1f}" rx="2" class="bar {cls}" pointer-events="none"/>')
        out.append(f'<text x="{x + bw / 2 - 1:.1f}" y="{h - 8}" class="ax" text-anchor="middle">{esc(labeler(k))}</text>')
    out.append('</svg></figure>')
    return ''.join(out)

def quarter_svg(rw, w=300, h=130):
    q = rw['st']['quarters']
    g = {x['period'].replace('20', '', 1): [x['sumR']] for x in q}
    keys = list(g.keys()); vals = [g[k][0] for k in keys]
    m = max(1, max(abs(v) for v in vals)); bw = (w - 30) / len(keys)
    Y0 = 12 + (h - 34) / 2; sc = (h - 34) / 2 / m
    out = [f'<figure class="bars"><figcaption>Σ R je Quartal</figcaption><svg viewBox="0 0 {w} {h}" role="img" aria-label="Summe R je Quartal">',
           f'<line x1="24" x2="{w - 4}" y1="{Y0:.1f}" y2="{Y0:.1f}" class="zero"/>',
           f'<text x="20" y="16" class="ax" text-anchor="end">{fn(m)}</text><text x="20" y="{h - 18}" class="ax" text-anchor="end">{fn(-m)}</text>']
    for i, (x, v) in enumerate(zip(q, vals)):
        X = 26 + i * bw; bh = abs(v) * sc; y = Y0 - bh if v >= 0 else Y0
        tip = f'{x["period"]}: Σ {fR(v, 1)} · {x["n"]} Trades · Ø {fR(x["avgR"])}'
        out.append(f'<rect x="{X - 1:.1f}" y="10" width="{bw:.1f}" height="{h - 30}" class="hit" data-tip="{esc(tip)}"/>')
        out.append(f'<rect x="{X + 1:.1f}" y="{y:.1f}" width="{max(2, bw - 4):.1f}" height="{max(1, bh):.1f}" rx="2" class="bar {"pos" if v >= 0 else "neg"}" pointer-events="none"/>')
        if len(q) <= 12 or i % 2 == 0:
            out.append(f'<text x="{X + bw / 2 - 1:.1f}" y="{h - 8}" class="ax" text-anchor="middle">{esc(x["period"][2:].replace("-", ""))}</text>')
    out.append('</svg></figure>')
    return ''.join(out)

def heat_cell(v, n, minn=15):
    if n == 0: return '<td class="hc empty">·</td>'
    a = min(1, abs(v) / 0.6) * 0.75 + 0.05
    col = f'rgba(42,120,214,{a:.2f})' if v >= 0 else f'rgba(227,73,72,{a:.2f})'
    low = ' low' if n < minn else ''
    return f'<td class="hc{low}" style="background:{col}" data-tip="Ø {fR(v)} · {n} Trades">{fr(v)}</td>'

# ---------------------------------------------------------------- HTML
LEVEL = {'A': ('A', 'Backtest-Variante'), 'B': ('B', 'Filter nachgerechnet'), 'C': ('C', 'Ausstieg, gleiche Einstiege'), 'D': ('D', 'Näherung / Hypothese')}

def kpis(rw):
    s, st = rw['s'], rw['st']
    items = [('Trades', f'{s["n"]}', f'{fr(s["tradesPerMonth"], 1, False)}/Monat'),
             ('Ø je Trade', fR(s['avgR']), f'90 %: {fR(s["avgRci90"][0])} … {fR(s["avgRci90"][1])}'),
             ('Σ R', fR(s['sumR'], 1), f'PF {fr(s["profitFactor"], 2, False)} · Treffer {fn(s["winRate"] * 100)} %'),
             ('p-Wert', fr(s['pValue'], 3, False), 'belegt' if s['pValue'] < 0.05 else 'nicht belegt'),
             ('1. / 2. Hälfte', f'{fR(rw["h1"])} / {fR(rw["h2"])}', f'{fn(st["positiveQuartersPct"])} % der Quartale positiv'),
             ('Max. Drawdown', f'{fn(s["maxDDR"], 1)}R', f'Verlustserie {s["maxLoseStreak"]}')]
    return '<div class="kpis">' + ''.join(f'<div class="kpi"><div class="kl">{a}</div><div class="kv">{b}</div><div class="ks">{c}</div></div>' for a, b, c in items) + '</div>'

def segtable(pats, title):
    if not pats: return ''
    trs = ''.join(f'<tr><td>{esc(p["fieldLabel"])}</td><td>{esc(p["valueLabel"])}</td><td class="num">{p["n"]}</td>'
                  f'<td class="num {"pos" if p["avgR"] >= 0 else "neg"}t">{fR(p["avgR"])}</td><td class="num">{fR(p["restAvgR"])}</td>'
                  f'<td class="num">{p["foldsConsistent"]}/{p["foldsTested"]}</td></tr>' for p in pats[:5])
    return (f'<div class="seg"><h4>{title}</h4><table><thead><tr><th>Merkmal</th><th>Bereich</th><th class="num">n</th><th class="num">Ø R</th>'
            f'<th class="num">Rest Ø</th><th class="num">Drittel</th></tr></thead><tbody>{trs}</tbody></table></div>')

def card(rw):
    vkey, action, text = rw['verdict']; vl, vcls = VLABEL[vkey]
    ideas = rw['ideas']; s = rw['s']; risk = rw['risk']; mfe = rw['mfe']
    notes = []
    if mfe.get('losersReached1R', 0) >= 0.3:
        notes.append(f'{fn(mfe["losersReached1R"] * 100)} % der Verlierer lagen zwischendurch ≥ 1R im Plus (Ø maximaler Buchgewinn {fR(mfe["avgMfeR"])}).')
    cur = risk.get('current') or {}
    if cur:
        sug = (risk.get('suggestion') or {}).get('suggested')
        notes.append(f'Monte-Carlo-Drawdown bei {fr(cur["riskPct"], 1, False)} % Risiko: typisch {fn(cur["p50"], 1)} %, 95 %-Fall {fn(cur["p95"], 1)} %'
                     + (f'; für ≤ 5 % Risiko eines 10-%-Drawdowns höchstens {fr(sug, 1, False)} % je Trade.' if sug else '.'))
    v = rw['var']
    if v and v.get('base'):
        notes.append(f'Gegenüber {esc(v["base"])}: Δ {fR(float(v["delta_avg_r"]))} je Trade (1./2. Hälfte {fR(float(v["delta_h1"]))} / {fR(float(v["delta_h2"]))}).')
    pot = ''
    best = [i for i in ideas if i['level'] in 'ABC']
    if best:
        b = max(best, key=lambda i: i['d'])
        pot = f'<div class="pot">Mit der stärksten belastbaren Idee (Stufe {b["level"]}): Ø {fR(s["avgR"])} → <b>{fR(s["avgR"] + b["d"])}</b></div>'
    ilist = ''.join(
        f'<li class="idea"><span class="lvl l{i["level"]}" title="{LEVEL[i["level"]][1]}">{i["level"]}</span>'
        f'<div><div class="it">{esc(i["title"])} <span class="delta {"pos" if i["d"] >= 0 else "neg"}t">{fR(i["d"])} je Trade</span></div>'
        f'<div class="ix">{esc(i["text"])}</div></div></li>' for i in ideas) or '<li class="none">Keine Idee, die in beiden Zeithälften besser ist.</li>'
    dl = ''.join(f'<li>{esc(d)}</li>' for d in rw['donts'][:6])
    dirb = bars_svg(rw['dir'], lambda k: k, 'Ø R nach Richtung', w=160)
    wdb = bars_svg(rw['wd'], lambda k: WD.get(k, k), 'Ø R nach Wochentag (Einstieg)', w=240)
    hb = bars_svg(rw['hour'], lambda k: f'{k}', 'Ø R nach Signal-Stunde', w=420)
    pats = rw['r'].get('patterns') or {}
    return f'''
<section class="card" id="{rw["id"]}" data-epic="{rw["epic"]}">
  <header>
    <div><span class="epic">{rw["epic"]}</span><h3>{esc(rw["short"])}</h3><div class="where">{esc(rw["where"])}</div></div>
    <div class="badge {vcls}"><span class="ico" aria-hidden="true"></span>{vl}</div>
  </header>
  <p class="lead"><b>{esc(action)}.</b> {esc(text)}</p>
  {kpis(rw)}
  <div class="charts"><figure class="eqwrap"><figcaption>Kapitalkurve (kumuliert in R)</figcaption>{equity_svg(rw)}</figure>{quarter_svg(rw)}</div>
  <div class="charts">{dirb}{wdb}{hb}</div>
  <div class="cols">
    <div class="ideas"><h4>Verbesserungsideen</h4>{pot}<ol>{ilist}</ol>
      {f'<h4 class="dont">Nicht tun (schadet in beiden Hälften)</h4><ul class="donts">{dl}</ul>' if dl else ''}
      {''.join(f'<p class="note">{n}</p>' for n in notes)}
    </div>
    <div>{segtable(pats.get("strengths"), "Stärken (hier verdient der Bot)")}{segtable(pats.get("weaknesses"), "Schwächen (hier verliert der Bot)")}</div>
  </div>
</section>'''

def overview():
    out = []
    for epic in ('US100', 'DE40', 'EURUSD'):
        rs = sorted([x for x in rows if x['epic'] == epic], key=lambda x: -x['s']['avgR'])
        out.append(f'<tr class="grp" data-epic="{epic}"><th colspan="10">{epic}</th></tr>')
        for x in rs:
            s, st = x['s'], x['st']; vl, vcls = VLABEL[x['verdict'][0]]
            b = x['ideas'][0] if x['ideas'] else None
            top = f'{esc(b["title"])} <span class="muted">(Stufe {b["level"]}, {fR(b["d"])})</span>' if b else '–'
            out.append(f'<tr data-epic="{epic}"><td><a href="#{x["id"]}">{esc(x["short"])}</a></td><td class="num">{s["n"]}</td>'
                       f'<td class="num {"pos" if s["avgR"] >= 0 else "neg"}t">{fR(s["avgR"])}</td><td class="num">{fR(s["sumR"], 1)}</td>'
                       f'<td class="num">{fr(s["profitFactor"], 2, False)}</td><td class="num">{fr(s["pValue"], 3, False)}</td>'
                       f'<td class="num">{fR(x["h1"])} / {fR(x["h2"])}</td><td>{spark(x)}</td>'
                       f'<td><span class="badge sm {vcls}"><span class="ico" aria-hidden="true"></span>{vl}</span></td>'
                       f'<td class="topidea">{top}</td></tr>')
    return ''.join(out)

def heatmaps():
    hours = list(range(7, 22))
    th = ''.join(f'<th>{h}</th>' for h in hours)
    hr = ''.join(f'<tr data-epic="{x["epic"]}"><td class="rl"><a href="#{x["id"]}">{esc(x["short"])}</a></td>' +
                 ''.join(heat_cell(mean(x['hour'].get(h, [])), len(x['hour'].get(h, []))) for h in hours) + '</tr>' for x in rows)
    wr = ''.join(f'<tr data-epic="{x["epic"]}"><td class="rl"><a href="#{x["id"]}">{esc(x["short"])}</a></td>' +
                 ''.join(heat_cell(mean(x['wd'].get(w, [])), len(x['wd'].get(w, []))) for w in range(1, 6)) +
                 ''.join(heat_cell(mean(x['dir'].get(d, [])), len(x['dir'].get(d, []))) for d in ('BUY', 'SELL')) + '</tr>' for x in rows)
    return (f'<div class="heat"><table><caption>Ø R nach Wochentag des Einstiegs und Richtung</caption><thead><tr><th></th>'
            + ''.join(f'<th>{WD[w]}</th>' for w in range(1, 6)) + '<th>BUY</th><th>SELL</th></tr></thead><tbody>' + wr + '</tbody></table></div>'
            f'<div class="heat"><table><caption>Ø R nach Signal-Stunde (Berlin)</caption><thead><tr><th></th>{th}</tr></thead><tbody>{hr}</tbody></table></div>')

PATTERNS = [
    ('Kleiner Risikoabstand = bester Trade',
     'Bei NAS F618ATR bringt das Viertel mit dem kleinsten SL-Abstand Ø +0,48R (Capital, ≤ 33 Pkt) bzw. +0,60R (FTMO, ≤ 36 Pkt), das Viertel mit dem größten ≈ 0 oder Verlust. '
     'Auch bei Fib61 LB2 ist der kleine SL das einzige positive Segment (≤ 32 Pkt: +0,12R; 43–59 Pkt: −0,17R). '
     'Für FTMO als echter Backtest bestätigt: SL_MAX 80 statt 200 → Ø +0,27 → +0,38R, Plateau 60–120 stabil.',
     'SL-Obergrenze 80 Pkt als Schatten-Zwilling – zuerst FTMO, danach F618ATR Capital.'),
    ('Ziel zu weit bei DE40 LVN, richtig bei F618ATR',
     'Bei LVN lagen rund zwei Drittel der Verlierer zuerst ≥ 1R im Plus; TP 1–1,5R statt Original dreht die Basis von −0,05R auf etwa +0,15R (beide Hälften). '
     'Bei F618ATR schadet ein früherer TP dagegen in beiden Hälften.',
     'LVN: Zwilling „TP 1,5R“. F618ATR: TP unverändert lassen.'),
    ('Einstand-Stop hilft fast nirgends',
     'SL auf Einstand ab +1R bzw. +1,5R verschlechtert F618ATR, FTMO und alle LVN-Varianten in beiden Zeithälften. Ausnahmen nur bei schwachen Bots (Fib61 LB3 +0,05R, EURUSD C1 +0,02R) – ohne Wirkung auf das Gesamtbild.',
     'Nicht einbauen.'),
    ('Engerer SL hilft bei den Fib-Einstiegen auf US100',
     'SL 0,75× auf denselben Einstiegen: FTMO +0,07R (robust), Fib61 LB1 und LB2 je +0,06R (robust). Bei F618ATR Capital nur +0,03R und nicht in beiden Hälften. Bei LVN schadet er.',
     'Zwilling „SL 0,75×“ für FTMO.'),
    ('Montag und Freitag sind die schwachen Tage',
     'Montag: LVN-Basis Ø −0,55R, Fib50 LB2 −0,27R; „ohne Montag“ ist bei LVN-Basis und Fib50 LB2 als Filter nachgerechnet robust. Freitag: alle EURUSD-Varianten −0,26 bis −0,35R.',
     'Wochentag-Filter nur als Zwilling – sie verbessern, machen aber keinen der negativen Bots profitabel.'),
    ('US100: Short > Long',
     'Bei allen NAS-Varianten sind SELL-Trades besser (F618ATR Capital +0,43R vs. +0,10R, FTMO +0,37R vs. +0,18R). Long ist bei F618ATR trotzdem positiv.',
     'Kein Long-Verbot, aber Long mit strengerer Bedingung (z. B. M15-Trend) als Zwilling prüfen.'),
    ('Eröffnungen sind Rauschen',
     'NAS F618ATR verliert mit Signalen in der Stunde der US-Eröffnung (15 Uhr, Ø −0,37R); ohne Signale 15:00–16:55 Ø +0,24 → +0,32R (Näherung, beide Hälften). '
     'FTMO verliert mit späten Signalen 18–19 Uhr (Ø −0,32R).',
     'Zwillinge: NAS-Signale 15:00–15:55 sperren (Capital), keine Signale nach 18:00 (FTMO).'),
    ('Volatilität wirkt als Band, nicht als Untergrenze',
     'F618ATR: ATR-Schwelle 1,4–1,6 % optimal, 1,2 % und ≥ 1,8 % schlechter, ohne Pause Ø halbiert. FTMO verdient am meisten bei ATR14 ≤ 425 Pkt (+0,50R), '
     'F618ATR Capital ist bei ATR14 > 598 Pkt schwach. Fib50 LB2 und Fib61 LB1 verlieren dagegen an ruhigen Tagen (ATR14 ≤ ~330).',
     'Für F618ATR eine ATR-Obergrenze zusätzlich zur Untergrenze testen.'),
    ('EURUSD scheitert an den Kosten',
     'TP 1R bringt netto nur +0,92R, TP 1,5R nur +1,36–1,38R; das Drittel mit den kleinsten Stops (≤ ~6 Pips) ist das schlechteste. Kein Filter und kein Ausstieg hebt eine Variante über null.',
     'Abschalten. Neuansatz nur mit deutlich größeren Stops/Zielen relativ zum Spread.'),
    ('Vorteil der Top-Strategie nimmt ab',
     'F618ATR Capital: 1. Kalenderhälfte +0,31R, 2. Hälfte +0,19R je Trade. FTMO nach Kalender stabil (+0,29 / +0,25R), nach Trade-Anzahl geteilt aber +0,36 → +0,17R – die schwächere Phase sind die letzten Monate.',
     'Rollierende 3-Monats-Kennzahl überwachen; Risiko nicht erhöhen.'),
]

def tiles():
    pos = [x for x in rows if x['s']['avgR'] > 0 and x['s']['pValue'] < 0.05]
    best = max(rows, key=lambda x: x['s']['avgR'])
    neg = [x for x in rows if x['s']['avgR'] < 0]
    t = [('Substrategien', str(len(rows)), '3 Epics · d_ilikebigbots + d_ftmo'),
         ('Belastbar positiv', str(len(pos)), ', '.join(x['short'] for x in pos)),
         ('Bester Ø je Trade', fR(best['s']['avgR']), best['short']),
         ('Negativ', str(len(neg)), 'davon EURUSD ' + str(sum(1 for x in neg if x['epic'] == 'EURUSD')) + ', DE40 ' + str(sum(1 for x in neg if x['epic'] == 'DE40')))]
    return '<div class="tiles">' + ''.join(f'<div class="tile"><div class="kl">{a}</div><div class="hero">{b}</div><div class="ks">{c}</div></div>' for a, b, c in t) + '</div>'

CSS = r'''
.viz-root{color-scheme:light;--surface-0:#f4f3f0;--surface-1:#fcfcfb;--border:#e2e1dc;--text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#77766f;
 --pos:#2a78d6;--neg:#e34948;--grid:#ebeae6;--good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;--accent:#2a78d6}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--surface-0:#111110;--surface-1:#1a1a19;--border:#33332f;
 --text-primary:#f0efec;--text-secondary:#c3c2b7;--text-muted:#9a998f;--pos:#3987e5;--neg:#e66767;--grid:#2a2a27;--accent:#3987e5}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--surface-0:#111110;--surface-1:#1a1a19;--border:#33332f;--text-primary:#f0efec;--text-secondary:#c3c2b7;
 --text-muted:#9a998f;--pos:#3987e5;--neg:#e66767;--grid:#2a2a27;--accent:#3987e5}
*{box-sizing:border-box}body{margin:0}
.viz-root{background:var(--surface-0);color:var(--text-primary);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh}
.wrap{max-width:1240px;margin:0 auto;padding:24px 20px 60px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:36px 0 12px}h3{font-size:17px;margin:2px 0}h4{font-size:13px;margin:14px 0 6px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.04em}
.sub{color:var(--text-secondary);margin:0 0 16px}.muted{color:var(--text-muted)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.box{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}
.tile{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.hero{font-size:28px;font-weight:650;font-variant-numeric:tabular-nums}
.kl{font-size:12px;color:var(--text-secondary)}.ks{font-size:12px;color:var(--text-muted)}
.filters{display:flex;gap:6px;position:sticky;top:0;background:var(--surface-0);padding:10px 0;z-index:5;border-bottom:1px solid var(--border)}
.filters button{font:inherit;border:1px solid var(--border);background:var(--surface-1);color:var(--text-primary);padding:5px 12px;border-radius:999px;cursor:pointer}
.filters button[aria-pressed="true"]{background:var(--text-primary);color:var(--surface-1);border-color:var(--text-primary)}
table{border-collapse:collapse;width:100%}th,td{padding:5px 8px;text-align:left;border-bottom:1px solid var(--border);vertical-align:middle}
th{font-size:12px;color:var(--text-secondary);font-weight:600}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.grp th{background:var(--surface-0);font-size:13px;color:var(--text-primary);padding-top:12px}
.post{color:var(--pos)}.negt{color:var(--neg)}
.post,.negt{font-weight:600}
.topidea{font-size:12.5px;max-width:320px}
.spark{width:120px;height:28px;display:block}.sp{fill:none;stroke-width:1.5}.sp.pos{stroke:var(--pos)}.sp.neg{stroke:var(--neg)}
.zero{stroke:var(--text-muted);stroke-width:1;stroke-dasharray:2 3}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;padding:3px 10px;border-radius:999px;border:1px solid var(--border);background:var(--surface-1);white-space:nowrap}
.badge.sm{font-size:11.5px;padding:1px 8px}
.badge .ico{width:9px;height:9px;border-radius:50%;display:inline-block}
.badge.good .ico{background:var(--good)}.badge.warning .ico{background:var(--warning);border-radius:1px;transform:rotate(45deg)}
.badge.serious .ico{background:var(--serious);border-radius:1px}.badge.critical .ico{background:var(--critical);clip-path:polygon(50% 0,100% 100%,0 100%);border-radius:0}
.card{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin:18px 0}
.card header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.epic{font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--text-muted)}.where{font-size:12px;color:var(--text-muted)}
.lead{margin:10px 0 12px;color:var(--text-primary)}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}
.kpi{border:1px solid var(--border);border-radius:8px;padding:8px 10px}.kv{font-size:17px;font-weight:650;font-variant-numeric:tabular-nums}
.charts{display:flex;flex-wrap:wrap;gap:14px;margin-top:12px;align-items:flex-start}
figure{margin:0}figcaption{font-size:12px;color:var(--text-secondary);margin-bottom:2px}
.eqwrap{flex:1 1 560px}.eq{width:100%;height:auto;display:block}.eqline{fill:none;stroke:var(--pos);stroke-width:2}
.grid{stroke:var(--grid);stroke-width:1}.half{stroke:var(--text-muted);stroke-width:1;stroke-dasharray:4 3}
.cross{stroke:var(--text-muted);stroke-width:1}.dot{fill:var(--pos);stroke:var(--surface-1);stroke-width:2}
.ax{font-size:10px;fill:var(--text-muted)}
.bars svg{display:block;height:130px;width:auto}
.bar.pos{fill:var(--pos)}.bar.neg{fill:var(--neg)}.bar.low{opacity:.4}
.hit{fill:transparent}.hit:hover{fill:var(--grid)}
.cols{display:grid;grid-template-columns:1.25fr 1fr;gap:22px;margin-top:6px}
.ideas ol{list-style:none;padding:0;margin:0}
.idea{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)}
.it{font-weight:600}.ix{font-size:12.5px;color:var(--text-secondary)}.delta{font-size:12px;margin-left:6px;white-space:nowrap}
.lvl{flex:0 0 22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:1.5px solid var(--text-secondary);color:var(--text-primary)}
.lvl.lA{background:var(--text-primary);color:var(--surface-1);border-color:var(--text-primary)}
.lvl.lB{border-style:solid}.lvl.lC{border-style:double;border-width:3px}.lvl.lD{border-style:dashed;color:var(--text-muted)}
.none{color:var(--text-muted);padding:8px 0}
.pot{font-size:13px;background:var(--surface-0);border-radius:6px;padding:6px 10px;margin-bottom:6px}
.donts{margin:0;padding-left:18px;font-size:12.5px;color:var(--text-secondary)}
.note{font-size:12.5px;color:var(--text-secondary);margin:8px 0 0}
.seg table{font-size:12.5px}.seg td,.seg th{padding:3px 6px}
.heat{overflow-x:auto;margin-bottom:18px}.heat table{font-size:12px}.heat caption{text-align:left;font-size:13px;font-weight:600;padding:4px 0 6px}
.hc{text-align:center;font-variant-numeric:tabular-nums;min-width:46px;color:var(--text-primary)}.hc.low{opacity:.5}.hc.empty{color:var(--text-muted)}
.rl{white-space:nowrap}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12.5px;color:var(--text-secondary);margin:8px 0}
.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{width:12px;height:12px;border-radius:3px;display:inline-block}
.pat{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.pat .box h4{margin:0 0 4px;color:var(--text-primary);text-transform:none;letter-spacing:0;font-size:14px}
.pat .box p{margin:4px 0;font-size:13px;color:var(--text-secondary)}.pat .box p.do{color:var(--text-primary)}
#tip{position:fixed;pointer-events:none;background:var(--text-primary);color:var(--surface-1);font-size:12px;padding:5px 8px;border-radius:6px;z-index:20;display:none;max-width:320px}
.hidden{display:none!important}
@media (max-width:900px){.tiles{grid-template-columns:repeat(2,1fr)}.kpis{grid-template-columns:repeat(3,1fr)}.cols,.pat{grid-template-columns:1fr}}
'''

JS = r'''
const tip=document.getElementById('tip');
function show(t,e){tip.textContent=t;tip.style.display='block';const x=Math.min(e.clientX+12,innerWidth-tip.offsetWidth-8);tip.style.left=x+'px';tip.style.top=(e.clientY+14)+'px'}
document.addEventListener('mousemove',e=>{const el=e.target.closest('[data-tip]');if(el)show(el.dataset.tip,e);else if(!e.target.closest('.eq'))tip.style.display='none'});
document.querySelectorAll('svg.eq').forEach(svg=>{const d=JSON.parse(svg.dataset.eq),pl=svg.querySelector('.eqline'),pts=pl.getAttribute('points').split(' ').map(p=>p.split(',').map(Number));
 const cr=svg.querySelector('.cross'),dot=svg.querySelector('.dot');
 svg.addEventListener('mousemove',e=>{const r=svg.getBoundingClientRect(),vb=svg.viewBox.baseVal,x=(e.clientX-r.left)*vb.width/r.width;
  let i=0,b=1e9;pts.forEach((p,k)=>{const dd=Math.abs(p[0]-x);if(dd<b){b=dd;i=k}});
  cr.setAttribute('x1',pts[i][0]);cr.setAttribute('x2',pts[i][0]);cr.setAttribute('visibility','visible');dot.setAttribute('cx',pts[i][0]);dot.setAttribute('cy',pts[i][1]);dot.setAttribute('visibility','visible');
  const f=v=>(v>=0?'+':'')+v.toFixed(2).replace('.',',');show(`${d[i][0]} · Trade ${i+1}: ${f(d[i][2])}R · kumuliert ${f(d[i][1])}R`,e)});
 svg.addEventListener('mouseleave',()=>{cr.setAttribute('visibility','hidden');dot.setAttribute('visibility','hidden');tip.style.display='none'})});
document.querySelectorAll('.filters button').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.filters button').forEach(x=>x.setAttribute('aria-pressed',x===b));
 const ep=b.dataset.epic;document.querySelectorAll('[data-epic]').forEach(el=>el.classList.toggle('hidden',ep!=='all'&&el.dataset.epic!==ep))}));
'''

def build():
    first = rows[0]['r']['period']
    cards = ''.join(card(x) for ep in ('US100', 'DE40', 'EURUSD') for x in sorted([y for y in rows if y['epic'] == ep], key=lambda y: -y['s']['avgR']))
    pats = ''.join(f'<div class="box"><h4>{i + 1}. {esc(a)}</h4><p>{esc(b)}</p><p class="do"><b>Idee:</b> {esc(c)}</p></div>' for i, (a, b, c) in enumerate(PATTERNS))
    now = datetime.date.today().strftime('%d.%m.%Y')
    return f'''<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard Substrategien – backtest-lab</title><style>{CSS}</style></head><body><div class="viz-root"><div class="wrap">
<h1>Dashboard aller Substrategien</h1>
<p class="sub">Live-Code-Backtests (Original-Code-Nodes) · Daten bis {esc(first["to"])} · erstellt {now} · alle Werte in R je Trade nach Spread.
Alle Muster und Ideen sind <b>In-Sample</b> gefunden – erst als Schatten-Zwilling im Forward-Test bestätigen, nichts direkt live übernehmen.</p>
{tiles()}
<div class="box">Nur Strategien aus den Workflows <i>d_ilikebigbots</i> (Capital.com) und <i>d_ftmo</i> (FTMO). Hinweis: Die Telegram-Nodes <i>Telegram DAX ORB V…</i> in d_ilikebigbots gehören trotz des Namens zu den DE40-<b>LVN</b>-Bots (V2 = Basis, V = Confluence 3, V3 = Distance 150, V4 = Quality 0.7, V5 = ADX 25, V6 = Combo).</div>
<div class="filters" role="group" aria-label="Epic-Filter"><button data-epic="all" aria-pressed="true">Alle</button><button data-epic="US100" aria-pressed="false">US100</button>
<button data-epic="DE40" aria-pressed="false">DE40</button><button data-epic="EURUSD" aria-pressed="false">EURUSD</button></div>
<h2>Rangliste nach Epic</h2>
<div class="box" style="overflow-x:auto"><table><thead><tr><th>Substrategie</th><th class="num">Trades</th><th class="num">Ø R</th><th class="num">Σ R</th><th class="num">PF</th>
<th class="num">p</th><th class="num">1./2. Hälfte</th><th>Kapitalkurve</th><th>Urteil</th><th>Stärkste belastbare Idee</th></tr></thead><tbody>{overview()}</tbody></table></div>
<h2>Muster über alle Strategien</h2>
<div class="legend"><span><i class="sw" style="background:rgba(42,120,214,.7)"></i>Ø R positiv</span><span><i class="sw" style="background:rgba(227,73,72,.7)"></i>Ø R negativ</span>
<span><i class="sw" style="background:var(--border);opacity:.5"></i>blass = weniger als 15 Trades</span><span>Farbstärke bis ±0,6R</span></div>
{heatmaps()}
<div class="pat">{pats}</div>
<h2>Substrategien im Detail</h2>
<div class="legend"><span><span class="lvl lA">A</span>Backtest-Variante mit Original-Code, besser in beiden Hälften</span>
<span><span class="lvl lB">B</span>Filter von der Engine nachgerechnet, robust</span><span><span class="lvl lC">C</span>Ausstieg auf denselben Einstiegen, robust</span>
<span><span class="lvl lD">D</span>Näherung (Trades entfernt), besser in beiden Hälften und allen Dritteln – Hypothese</span></div>
{cards}
<p class="sub" style="margin-top:30px">Erzeugt mit <code>python3 tools/dashboard.py</code> aus <code>out/live/*/result.json</code> und <code>vergleich_varianten.csv</code>.
Stufe-D-Ideen sind Data-Mining über Richtung, Wochentag und Stunde; bei so vielen geprüften Kandidaten sind Zufallstreffer zu erwarten.</p>
</div><div id="tip" role="tooltip"></div></div><script>{JS}</script></body></html>'''

if __name__ == '__main__':
    path = os.path.join(OUT, 'dashboard.html')
    with open(path, 'w') as f: f.write(build())
    print('geschrieben:', path, sum(len(x['ideas']) for x in rows), 'Ideen')
