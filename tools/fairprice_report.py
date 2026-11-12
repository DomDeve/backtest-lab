#!/usr/bin/env python3
"""Kandidat „Fair Price“: Auswertung + FTMO-Simulation + Vergleich mit der d_ftmo-Basis (NAS100 F618ATR FTMO).

Aufruf (nach `node bin/fairprice.js`):  python3 tools/fairprice_report.py  -> out/kandidaten/fairprice/report.html

Validierung: In-Sample = erste 70 % der Sessions je Instrument/Session (zeitlich), Out-of-Sample = letzte 30 %.
Bewertet werden nur Varianten mit >= 100 OOS-Trades. Auswahl der Kandidaten nach IS, Bestätigung im OOS.
FTMO (2-Step, 100k): Phase 1 +10 %, Phase 2 +5 %, max. Verlust 10 % statisch, Tagesverlust 5 % inkl. offener Position
(MAE des Trades), Tageswechsel 00:00 Berlin, mind. 4 Handelstage je Phase, kein Zeitlimit (Abbruch nach 500 Handelstagen).
Startpunkte: rollierend (jeder Handelstag der Historie ist einmal Start) + Bootstrap (zufällige Handelstage).
"""
import json, os, math, random, datetime, collections, html

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FP_DIR = os.path.join(ROOT, 'out', 'kandidaten', 'fairprice')
BASE = os.path.join(ROOT, 'out', 'live', 'ftmo-basis', 'result.json')
RISKS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0]
esc = lambda s: html.escape(str(s), quote=True)
def fr(x, d=2, sign=True):
    if x is None or (isinstance(x, float) and math.isnan(x)): return '–'
    return ((f'{x:+.{d}f}' if sign else f'{x:.{d}f}')).replace('.', ',')
def pct(x): return '–' if x is None else f'{x*100:.0f} %'
mean = lambda v: sum(v) / len(v) if v else float('nan')

def stats(tr):
    R = [t['R'] for t in tr]; n = len(R)
    if not n: return dict(n=0)
    gp = sum(r for r in R if r > 0); gl = -sum(r for r in R if r < 0)
    eq = pk = dd = 0; run = mx = 0
    for r in R:
        eq += r; pk = max(pk, eq); dd = max(dd, pk - eq)
        run = run + 1 if r < 0 else 0; mx = max(mx, run)
    sd = (sum((r - mean(R)) ** 2 for r in R) / max(1, n - 1)) ** .5
    t = mean(R) / (sd / n ** .5) if sd else 0
    return dict(n=n, win=sum(1 for r in R if r > 0) / n, avg=mean(R), sum=sum(R), pf=gp / gl if gl else None, dd=dd, streak=mx, t=t)

# ---------------------------------------------------------------- FTMO
def day_seq(trades, all_days):
    by = collections.defaultdict(list)
    for t in trades: by[t['exitDate'] if 'exitDate' in t else t['date']].append(t)
    return [by.get(d, []) for d in all_days]

def run_phase(days, i, risk, target):
    """Ab Tag i; liefert (ergebnis, tage, ende_index). ergebnis: pass | fail_tag | fail_gesamt | offen"""
    eq, traded, k = 100.0, 0, i
    while k < len(days) and k - i < 500:
        start = eq; day = days[k]
        if day: traded += 1
        for t in day:
            worst = eq * (1 - t.get('mae', 1) * risk / 100)
            if start - worst >= 5: return 'fail_tag', k - i + 1, k
            if worst <= 90: return 'fail_gesamt', k - i + 1, k
            eq *= 1 + t['R'] * risk / 100
            if start - eq >= 5: return 'fail_tag', k - i + 1, k
            if eq <= 90: return 'fail_gesamt', k - i + 1, k
        if eq >= 100 + target and traded >= 4: return 'pass', k - i + 1, k
        k += 1
    return 'offen', k - i, k

def ftmo(days, risk, boot_runs=2000, seed=5):
    out = {}
    for mode in ('rollierend', 'bootstrap'):
        res = []
        rnd = random.Random(seed)
        starts = range(len(days)) if mode == 'rollierend' else range(boot_runs)
        for s in starts:
            seq = days[s:] if mode == 'rollierend' else [days[rnd.randrange(len(days))] for _ in range(1000)]
            r1, d1, e1 = run_phase(seq, 0, risk, 10)
            if r1 != 'pass': res.append((r1, None, d1, None)); continue
            r2, d2, _ = run_phase(seq, e1 + 1, risk, 5)
            res.append(('pass', r2, d1, d2))
        done1 = [r for r in res if r[0] != 'offen']
        p1 = sum(1 for r in done1 if r[0] == 'pass') / len(done1) if done1 else None
        ph2 = [r for r in res if r[0] == 'pass' and r[1] != 'offen']
        p2 = sum(1 for r in ph2 if r[1] == 'pass') / len(ph2) if ph2 else None
        both = [r[2] + r[3] for r in ph2 if r[1] == 'pass']
        fails = [r[0] if r[0] != 'pass' else r[1] for r in res if (r[0] not in ('pass', 'offen')) or (r[0] == 'pass' and r[1] not in ('pass', 'offen', None))]
        out[mode] = dict(p1=p1, p2=p2, both=(p1 * p2) if p1 is not None and p2 is not None else None,
                         dmean=mean(both) if both else None, dmed=sorted(both)[len(both) // 2] if both else None,
                         ftag=sum(1 for f in fails if f == 'fail_tag') / len(fails) if fails else None, n=len(res))
    return out

# ---------------------------------------------------------------- Daten
V = json.load(open(os.path.join(FP_DIR, 'trades.json')))
META = json.load(open(os.path.join(FP_DIR, 'meta.json')))
FPC = json.load(open(os.path.join(FP_DIR, 'fp-check.json')))
SESS_NAME = {'US100|main': 'NAS100 09:30–11:00 NY', 'US100|pm': 'NAS100 14:00–15:30 NY', 'DE40|main': 'DE40 09:00–10:30', 'DE40|us': 'DE40 15:30–17:00'}
SETUP_NAME = {'A-ema': 'A Fortsetzung, Bias EMA50', 'A-off': 'A Fortsetzung, ohne Bias', 'A-counter': 'A Fortsetzung, gegen 9-h-Trend', 'B1': 'B1 Verschiebungskerze', 'B2': 'B2 Strukturbruch', 'B12': 'B1 + B2'}

# Sessions-Kalender je Instrument/Session (alle Handelstage) für IS/OOS und FTMO
cal = {k: [x['date'] for x in v] for k, v in FPC.items()}
cut = {k: d[int(len(d) * 0.7)] for k, d in cal.items()}

rows = []
for v in V:
    key = f"{v['sym']}|{v['sess']}"
    tr = v['trades']; c = cut[key]
    s, si, so = stats(tr), stats([t for t in tr if t['date'] < c]), stats([t for t in tr if t['date'] >= c])
    setup = v['setup'] + ('-' + v['bias'] if v['bias'] else '')
    rows.append(dict(v=v, key=key, setup=setup, s=s, si=si, so=so, ok=so.get('n', 0) >= 100))

# Basis F618ATR FTMO
B = json.load(open(BASE))
base_tr = [dict(date=t['date'], exitDate=t.get('exitDate', t['date']), R=t['R'], mae=min(max(t.get('maeR', 1) or 1, 0), 3)) for t in B['trades']]
base_from, base_to = B['period']['from'], B['period']['to']

def same_period(tr, a, b): return [t for t in tr if a <= t['date'] <= b]

# Kandidaten: bewertbar (OOS >= 100), nach IS sortiert; „bestätigt“ = IS und OOS positiv
ev = sorted([r for r in rows if r['ok']], key=lambda r: -r['si']['avg'])
confirmed = [r for r in ev if r['si']['avg'] > 0 and r['so']['avg'] > 0]
# FTMO/Vergleich: bester bewertbarer Kandidat + Setup A NAS-Hauptsession mit den Grundwerten der Spezifikation (SL 25 / TP 38,
# keine Optimierung) als Beobachtung – formal nicht bewertbar (< 100 OOS-Trades), aber der einzige breit positive Bereich.
top = (confirmed[:2] if confirmed else ev[:1])
for sid in ('US100|main|A-off|Punkte|SL 25 / TP 38', 'US100|main|A-ema|Punkte|SL 25 / TP 38', 'US100|main|A-counter|Punkte|SL 25 / TP 38'):
    top += [r for r in rows if r['v']['id'] == sid]

# Kalender für FTMO: Handelstage der Basis-Periode (Berlin-Datum aus NAS-Sessions + DE40)
all_days = sorted(set(cal['US100|main']) | set(cal['DE40|main']))
def ftmo_for(tr, a, b):
    days = [d for d in all_days if a <= d <= b]
    return {r: ftmo(day_seq(tr, days), r) for r in RISKS}

per = (max(base_from, '2024-09-02'), min(base_to, '2026-10-13'))
sims = {}
sims['basis'] = ftmo_for(base_tr, *per)
for r in top: sims[r['v']['id']] = ftmo_for(same_period(r['v']['trades'], *per), *per)
# Kombination: Basis + bester Kandidat auf einem Konto
KOMBI = next((r for r in top if r['v']['id'] == 'US100|main|A-off|Punkte|SL 25 / TP 38'), top[0] if top else None)
if KOMBI:
    comb = sorted(base_tr + same_period(KOMBI['v']['trades'], *per), key=lambda t: (t.get('exitDate', t['date'])))
    sims['kombi'] = ftmo_for(comb, *per)

def daily(tr, days):
    by = collections.defaultdict(float)
    for t in tr: by[t.get('exitDate', t['date'])] += t['R']
    return [by.get(d, 0.0) for d in days]
def corr(a, b):
    ma, mb = mean(a), mean(b); sa = sum((x - ma) ** 2 for x in a) ** .5; sb = sum((y - mb) ** 2 for y in b) ** .5
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (sa * sb) if sa and sb else None
pdays = [d for d in all_days if per[0] <= d <= per[1]]
corrs = {r['v']['id']: corr(daily(base_tr, pdays), daily(same_period(r['v']['trades'], *per), pdays)) for r in top}

# ---------------------------------------------------------------- Report
def stat_cells(s):
    if not s.get('n'): return '<td colspan="7" class="muted">keine Trades</td>'
    return (f'<td class="num">{s["n"]}</td><td class="num">{pct(s["win"])}</td><td class="num"><b class="{"post" if s["avg"] >= 0 else "negt"}">{fr(s["avg"])}</b></td>'
            f'<td class="num">{fr(s["pf"], 2, False) if s["pf"] else "–"}</td><td class="num">{fr(s["dd"], 1, False)}</td><td class="num">{s["streak"]}</td><td class="num">{fr(s["t"], 1)}</td>')

def var_name(r): return f"{SESS_NAME[r['key']]} · {SETUP_NAME[r['setup']]} · {r['v']['scheme']} {r['v']['grid']}" + ('' if r['ok'] else ' (nicht bewertbar: < 100 OOS-Trades)')

# Session-Übersicht: beste Variante je Session/Setup nach IS
sess_tab = ''
for key in SESS_NAME:
    for su in SETUP_NAME:
        cand = [r for r in rows if r['key'] == key and r['setup'] == su]
        if not cand: continue
        allR = [t['R'] for r in cand for t in r['v']['trades']]
        best = max(cand, key=lambda r: r['si']['avg'] if r['si'].get('n') else -9)
        pos = sum(1 for r in cand if r['s'].get('n') and r['s']['avg'] > 0)
        sess_tab += (f'<tr><td>{SESS_NAME[key]}</td><td>{SETUP_NAME[su]}</td><td class="num">{len(cand)}</td><td class="num">{pos}</td>'
                     f'<td class="num">{fr(mean(allR))}</td><td>{esc(best["v"]["scheme"] + " " + best["v"]["grid"])}</td>'
                     f'<td class="num">{fr(best["si"]["avg"])} ({best["si"]["n"]})</td><td class="num"><b class="{"post" if best["so"].get("avg", 0) >= 0 else "negt"}">{fr(best["so"].get("avg"))}</b> ({best["so"].get("n", 0)})</td></tr>')

top_tab = ''.join(f'<tr><td>{i + 1}</td><td>{esc(var_name(r))}</td>{stat_cells(r["si"])}{stat_cells(r["so"])}</tr>' for i, r in enumerate(ev[:15]))

def breakdown(tr, fn, label):
    g = collections.defaultdict(list)
    for t in tr: g[fn(t)].append(t['R'])
    return f'<tr><th>{label}</th>' + ''.join(f'<td>{esc(k)}: <b>{fr(mean(v))}</b> ({len(v)})</td>' for k, v in sorted(g.items())) + '</tr>'
WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
bd = ''
for r in top:
    tr = r['v']['trades']
    bd += (f'<h3>{esc(var_name(r))}</h3><div class="tw"><table>'
           + breakdown(tr, lambda t: t['signal'], 'Signal') + breakdown(tr, lambda t: t['dir'], 'Richtung') + breakdown(tr, lambda t: WD[t['wd']], 'Wochentag')
           + breakdown(tr, lambda t: t['date'][:4], 'Jahr') + breakdown(tr, lambda t: 'große Eröffnungskerze (2× SL/TP)' if t['big'] else 'normal', 'Eröffnungskerze')
           + breakdown(tr, lambda t: t['reason'], 'Ausstieg') + '</table></div>')

def ftmo_tab(name, S):
    h = f'<h3>{esc(name)}</h3><div class="tw"><table><thead><tr><th>Risiko/Trade</th><th>Start</th><th class="num">Phase 1</th><th class="num">Phase 2</th><th class="num">beide</th><th class="num">Ø Tage</th><th class="num">Median Tage</th><th class="num">Ausfälle durch Tagesverlust</th></tr></thead><tbody>'
    for rk in RISKS:
        for mode in ('rollierend', 'bootstrap'):
            x = S[rk][mode]
            h += (f'<tr{" class=sep" if mode == "rollierend" else ""}><td>{fr(rk, 2, False)} %</td><td>{mode}</td><td class="num">{pct(x["p1"])}</td><td class="num">{pct(x["p2"])}</td>'
                  f'<td class="num"><b>{pct(x["both"])}</b></td><td class="num">{fr(x["dmean"], 0, False) if x["dmean"] else "–"}</td><td class="num">{x["dmed"] or "–"}</td><td class="num">{pct(x["ftag"])}</td></tr>')
    return h + '</tbody></table></div>'
ftmo_html = ftmo_tab('d_ftmo-Basis: NAS100 F618ATR FTMO', sims['basis'])
for r in top: ftmo_html += ftmo_tab('Kandidat: ' + var_name(r), sims[r['v']['id']])
if 'kombi' in sims: ftmo_html += ftmo_tab('Kombination Basis + ' + var_name(KOMBI) + ' (ein Konto)', sims['kombi'])

bs = stats(same_period(base_tr, *per))
cmp_rows = f'<tr><td><b>d_ftmo-Basis F618ATR FTMO</b></td>{stat_cells(bs)}<td class="num">–</td></tr>'
for r in top:
    cmp_rows += f'<tr><td>{esc(var_name(r))}</td>{stat_cells(stats(same_period(r["v"]["trades"], *per)))}<td class="num">{fr(corrs[r["v"]["id"]])}</td></tr>'

fp_rows = ''
for k, v in FPC.items():
    n = len(v); a = [x for x in v if x['away']]
    byy = collections.defaultdict(list)
    for x in v: byy[x['date'][:4]].append(x['reached'])
    fp_rows += (f'<tr><td>{SESS_NAME[k]}</td><td class="num">{n}</td><td class="num"><b>{pct(sum(x["reached"] for x in v) / n)}</b></td>'
                f'<td class="num">{pct(len(a) / n)}</td><td class="num"><b>{pct(sum(x["reachedAfterAway"] for x in a) / max(1, len(a)))}</b></td>'
                f'<td>{" · ".join(f"{y}: {pct(mean(z))}" for y, z in sorted(byy.items()))}</td></tr>')

best_vs = None
if top:
    b05, c05 = sims['basis'][0.5]['rollierend'], sims[top[0]['v']['id']][0.5]['rollierend']
    tops = stats(same_period(top[0]['v']['trades'], *per))
    beats = tops.get('avg', -9) * tops.get('n', 0) > bs['avg'] * bs['n'] and (c05['both'] or 0) > (b05['both'] or 0)
    best_vs = (beats, tops, b05, c05)

aA = [r for r in rows if r['key'] == 'US100|main' and r['setup'].startswith('A')]
aPos = sum(1 for r in aA if r['si'].get('n') and r['so'].get('n') and r['si']['avg'] > 0 and r['so']['avg'] > 0)
aAvg = mean([t['R'] for r in aA for t in r['v']['trades']])
bAll = [t['R'] for r in rows if r['setup'].startswith('B') for t in r['v']['trades']]
nasReach = mean([x['reached'] for x in FPC['US100|main']]); nasBack = mean([x['reachedAfterAway'] for x in FPC['US100|main'] if x['away']])
b05 = sims['basis'][0.5]['bootstrap']['both']; k05 = sims['kombi'][0.5]['bootstrap']['both'] if KOMBI else None
bd05 = sims['basis'][0.5]['bootstrap']['dmed']; kd05 = sims['kombi'][0.5]['bootstrap']['dmed'] if KOMBI else None
def grp(key, su):
    rs = [r for r in rows if r['key'] == key and r['setup'] == su]
    return dict(n=len(rs), pos=sum(1 for r in rs if r['s'].get('n') and r['s']['avg'] > 0),
                both=sum(1 for r in rs if r['si'].get('n') and r['so'].get('n') and r['si']['avg'] > 0 and r['so']['avg'] > 0),
                oos=mean([r['so']['avg'] for r in rs if r['so'].get('n')]), tr=mean([r['s'].get('n', 0) for r in rs]), troos=mean([r['so'].get('n', 0) for r in rs]))
gA, gB1pm, gAde = grp('US100|main', 'A-off'), grp('US100|pm', 'B1'), grp('DE40|main', 'A-ema')
FAZIT = f"""<p><b>Empfehlung: weiter testen – aber nur zwei Zellen; alles andere verwerfen. Nicht als d_ftmo-Variante bauen.</b>
Keine Variante schlägt die d_ftmo-Basis (F618ATR FTMO: Ø {fr(bs['avg'])}R, t {fr(bs['t'], 1)}, FTMO 0,5 %: {pct(b05)} bestehen beide Phasen im Bootstrap); formal (≥ 100 OOS-Trades) ist keine Fair-Price-Variante in IS und OOS positiv – nichts davon gehört ins Ranking.</p>
<ul>
<li><b>Kernannahme nicht bestätigt:</b> Der Kurs kehrt in der NAS-Hauptsession nach der ersten Kerze nur in {pct(nasReach)} der Sessions zum FP zurück; hat er sich ≥ 25 Pkt entfernt, nur in {pct(nasBack)} (behauptet ~95 % an Nicht-News-Tagen). Nachmittags und DE40 70–82 %. Auch mit M1 und ohne News-Tage bleibt das deutlich unter 95 %.</li>
<li><b>Die Setups tauschen je Session die Rollen:</b>
 <br>· <b>NAS 09:30–11:00 NY, Setup A (Fortsetzung) – Stärke:</b> alle Rasterzellen positiv; ohne Bias {gA['both']}/{gA['n']} Zellen in IS und OOS positiv, Ø OOS {fr(gA['oos'])}R. Aber nur ~{gA['tr']:.0f} Trades in 2 Jahren (OOS ~{gA['troos']:.0f}), die Grundeinstellung SL 25 / TP 38 ist im OOS leicht negativ, und die M5-Näherung trifft gerade dieses 5-Minuten-Setup.
 <br>· <b>NAS 14:00–15:30 NY, Setup B1 (Reversion) – Stärke:</b> {gB1pm['pos']}/{gB1pm['n']} Zellen positiv, {gB1pm['both']} in IS und OOS, Ø OOS {fr(gB1pm['oos'])}R – aber nur ~{gB1pm['tr']:.0f} Trades in 2 Jahren (OOS ~{gB1pm['troos']:.0f}); für eine FTMO-Challenge allein viel zu selten.
 <br>· <b>Schwächen:</b> Setup B in der NAS-Hauptsession und im DE40 09:00 verliert in allen Zellen, im DE40 15:30 überwiegend (Gegentrend gegen starke Eröffnungsbewegungen); Setup A am NAS-Nachmittag und in der DE40-US-Session verliert ebenfalls fast überall. DE40 09:00 Setup A mit EMA-Bias ist im IS breit positiv ({gAde['pos']}/{gAde['n']}), im OOS aber nur {fr(gAde['oos'])}R.</li>
<li><b>Kombination auf einem Konto:</b> Tagesergebnisse von Setup A und F618ATR sind praktisch unkorreliert ({fr(corrs.get(KOMBI['v']['id']) if KOMBI else None)}); die Kombination besteht die Challenge genauso oft wie die Basis allein (0,5 %: {pct(k05)} vs. {pct(b05)} im Bootstrap), aber schneller (Median {kd05} statt {bd05} Handelstage). Das setzt voraus, dass Setup A wirklich positiv ist.</li>
<li><b>Nächster Schritt:</b> M1-Daten (möglichst ≥ 3 Jahre – Setup A handelt ~10× im Monat, für ≥ 100 OOS-Trades bei 70/30 braucht es ~34 Monate; B1 nachmittags erreicht das nur per Walk-Forward oder Forward-Test) + News-Kalender beschaffen und nur diese beiden Zellen mit den Grundwerten erneut prüfen – NAS-Hauptsession Setup A (ohne Bias / EMA-Bias) und NAS-Nachmittag Setup B1 – ohne weitere Optimierung. Erst danach über einen Schatten-Zwilling in d_ftmo entscheiden.</li>
</ul>"""
CSS = open(os.path.join(ROOT, 'tools', 'ftmo_sim.py')).read().split("CSS = r'''")[1].split("'''")[0]
now = datetime.date.today().strftime('%d.%m.%Y')
reach_nas = [x for x in FPC['US100|main']]
H = f'''<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kandidat Fair Price – NAS100 / DE40</title>
<style>{CSS} tr.sep td{{border-top:2px solid var(--bd)}} .muted{{color:var(--t3)}} h3{{font-size:14px;margin:18px 0 6px}}</style></head><body><div class="viz-root"><div class="wrap">
<h1>Kandidaten · Fair Price (nach JJ Simon) – NAS100 und DE40</h1>
<p class="sub">Status: <b>Kandidat</b>, nicht im Ranking. Erstellt {now}. Daten Capital M5 (Bid/Ask) – NAS100 {META["sessions"]["US100|main"]["from"]} bis {META["sessions"]["US100|main"]["to"]},
DE40 {META["sessions"]["DE40|main"]["from"]} bis {META["sessions"]["DE40|main"]["to"]}. {len(V)} Varianten, IS/OOS 70/30 je Session.</p>
<div class="box"><b>Wichtige Näherungen (abgestimmt):</b> <b>M5 statt M1</b> – Setup A nutzt die erste 5-Min-Kerze als Eröffnungskerze und ein Einstiegsfenster bis Minute 15;
Verzögerungen 0/5/15 s nur als Slippage ({fr(META["slip"], 1, False)} Pkt je Ein-/Ausstieg). <b>Keine News-Varianten</b> (kein Kalender): News-FP, „News-konform“ und die Trennung News-/Nicht-News-Tage fehlen.
<b>Kosten:</b> Spread aus den Capital-Daten, keine Kommission, Slippage wie oben – Annahme, nicht vom FTMO-Konto. DE40-Skalierung: mittlere M5-Range der ersten 90 Min DE40/NAS100 = {fr(META["ratio"], 3, False)}, Mindest-SL DE40 {fr(META["minSlDe"], 1, False)} Pkt; ATR-Variante mit M1-ATR ≈ M5-ATR/√5.</div>

<h2>1 · Annahmen-Check: Erreicht der Kurs den fairen Preis wieder?</h2>
<div class="tw"><table><thead><tr><th>Session</th><th class="num">Sessions</th><th class="num">FP nach der 1. Kerze wieder berührt</th><th class="num">≥ Mindest-SL vom FP entfernt</th><th class="num">… davon zurück zum FP</th><th>berührt je Jahr</th></tr></thead><tbody>{fp_rows}</tbody></table></div>
<p class="sub sm">JJ: ~95 % an Tagen ohne News. Gemessen über alle Tage (News nicht trennbar). Mit M5 zählen Berührungen in den ersten 5 Minuten nicht mit – mit M1 läge der Wert etwas höher. „Mindest-SL“ = 25 Pkt NAS100 bzw. {fr(META["minSlDe"], 1, False)} Pkt DE40.</p>

<h2>2 · Wo gibt es überhaupt einen Edge? (je Session und Setup)</h2>
<div class="tw"><table><thead><tr><th>Session</th><th>Setup</th><th class="num">Raster</th><th class="num">davon positiv</th><th class="num">Ø R aller Trades</th><th>beste Rasterzelle (nach IS)</th><th class="num">IS Ø R (n)</th><th class="num">OOS Ø R (n)</th></tr></thead><tbody>{sess_tab}</tbody></table></div>

<h2>3 · Bewertbare Varianten (≥ 100 OOS-Trades), sortiert nach In-Sample</h2>
<div class="tw"><table><thead><tr><th>#</th><th>Variante</th><th colspan="7">In-Sample (70 %): Trades · Treffer · Ø R · PF · Max-DD R · Verlustserie · t</th><th colspan="7">Out-of-Sample (30 %)</th></tr></thead><tbody>{top_tab}</tbody></table></div>
<p class="sub sm">Ø R = Expectancy nach Kosten (Spread + Slippage). {len(ev)} von {len(rows)} Varianten erreichen ≥ 100 OOS-Trades; {len(confirmed)} davon sind in IS und OOS positiv.</p>

<h2>4 · Aufschlüsselung der stärksten Kandidaten</h2>
{bd}

<h2>5 · Vergleich mit der d_ftmo-Basis (gleicher Zeitraum {per[0]} – {per[1]})</h2>
<div class="tw"><table><thead><tr><th>Strategie</th><th class="num">Trades</th><th class="num">Treffer</th><th class="num">Ø R</th><th class="num">PF</th><th class="num">Max-DD R</th><th class="num">Verlustserie</th><th class="num">t</th><th class="num">Korrelation Tages-R zur Basis</th></tr></thead><tbody>{cmp_rows}</tbody></table></div>

<h2>6 · FTMO-Simulation (2-Step, 100k)</h2>
<p class="sub sm">Phase 1 +10 %, Phase 2 +5 %, max. Verlust 10 % statisch, Tagesverlust 5 % inkl. offener Position (MAE), Reset 00:00 Berlin, ≥ 4 Handelstage je Phase, kein Zeitlimit.
„rollierend“ = jeder Handelstag einmal Startpunkt (nicht beendete Läufe am Datenende zählen nicht – bei langsamen Strategien wirkt die Quote dadurch zu gut, maßgeblich ist Bootstrap), „bootstrap“ = 2000 Läufe aus zufälligen Handelstagen. Tage = Handelstage für beide Phasen.</p>
{ftmo_html}

<h2>7 · Bewertung</h2>
<div class="box" id="fazit">{FAZIT}</div>
</div></div></body></html>'''
open(os.path.join(FP_DIR, 'report.html'), 'w').write(H)
json.dump({'top': [dict(id=r['v']['id'], name=var_name(r), si=r['si'], so=r['so']) for r in top], 'confirmed': len(confirmed), 'evaluable': len(ev), 'base': bs,
           'beats': best_vs[0] if best_vs else None, 'sims': {k: {str(rk): v[rk] for rk in RISKS} for k, v in sims.items()}, 'corr': corrs},
          open(os.path.join(FP_DIR, 'summary.json'), 'w'), indent=1, default=str)
print('geschrieben', os.path.join(FP_DIR, 'report.html'))
print('bewertbar', len(ev), 'bestätigt', len(confirmed))
for r in ev[:12]: print(f"{var_name(r):95s} IS {r['si']['avg']:+.3f} ({r['si']['n']}) OOS {r['so']['avg']:+.3f} ({r['so']['n']})")
