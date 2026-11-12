#!/usr/bin/env python3
"""Report zur Konfluenz-Analyse: liest out/konfluenz/ergebnis.json + archiv.json (aus tools/konfluenz.py),
schreibt out/konfluenz/report.html (übernommene Filter + Empfehlungen) und out/konfluenz/archiv.html (verworfene Filter)."""
import json, os, html, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out', 'konfluenz')
E = json.load(open(os.path.join(OUT, 'ergebnis.json')))
A = json.load(open(os.path.join(OUT, 'archiv.json')))
esc = lambda s: html.escape(str(s), quote=True)
def fr(x, d=2, sign=True):
    if x is None or x == 'nan' or (isinstance(x, float) and x != x): return '–'
    x = float(x); return ((f'{x:+.{d}f}' if sign else f'{x:.{d}f}')).replace('.', ',')
pct = lambda x: '–' if x is None else f'{float(x)*100:.0f} %'
CSS = open(os.path.join(ROOT, 'tools', 'ftmo_sim.py')).read().split("CSS = r'''")[1].split("'''")[0]
CSS += '.ok{color:var(--c3);font-weight:700}.no{color:var(--t3)}.warn{color:var(--c4);font-weight:600} details{margin:10px 0} summary{cursor:pointer;font-weight:600;padding:6px 0} .tag{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--bd)}'
REC = {'übernehmen': ('Filter übernehmen', 'ok'), 'nur-IS': ('Effekt nur in-sample – verworfen', 'warn'), 'kein': ('kein Effekt', 'no')}
mark = lambda b: '<span class="ok">✓</span>' if b else '<span class="no">✗</span>'
now = datetime.date.today().strftime('%d.%m.%Y')

over = ''
for s in E:
    lab, cls = REC[s['rec'][0]]
    over += (f'<tr><td><a href="#{s["id"]}">{esc(s["name"])}</a><div class="sm muted">{s["wf"]}</div></td><td class="num">{s["n"]}</td><td class="num">{fr(s["base"]["exp"])}</td>'
             f'<td class="num">{fr(s["base"]["perWeek"], 1, False)}</td><td><span class="{cls}">{esc(lab)}</span>' + (f'<div class="sm"><b>{esc(s["rec"][1].split(": ", 1)[1])}</b></div>' if s['rec'][0] == 'übernehmen' else '')
             + f'</td><td class="sm">{esc("; ".join(s["why"]))}</td></tr>')

# Merkmal-Matrix: Δ Expectancy mit - ohne (Standardparameter) je Strategie
feat_labels = [f['label'] for f in E[0]['feats']]
mx = '<tr><th>Strategie</th>' + ''.join(f'<th class="num">{esc(l)}</th>' for l in feat_labels) + '</tr>'
for s in E:
    mx += f'<tr><td>{esc(s["name"])}</td>'
    fm = {f['label']: f for f in s['feats']}
    for l in feat_labels:
        f = fm.get(l)
        if not f or not f['n_with'] or not f['n_without']: mx += '<td class="num muted">–</td>'; continue
        d = float(f['e_with']) - float(f['e_without']); a = min(1, abs(d) / 0.3) * 0.7 + 0.05
        if min(f['n_with'], f['n_without']) < 30:
            mx += f'<td class="num muted" data-tip="nicht aussagekräftig: mit {f["n_with"]} / ohne {f["n_without"]} Trades">({fr(d)})</td>'; continue
        col = f'rgba(42,120,214,{a:.2f})' if d >= 0 else f'rgba(227,73,72,{a:.2f})'
        mx += f'<td class="num" style="background:{col}" data-tip="mit {fr(f["e_with"])}R ({f["n_with"]}) · ohne {fr(f["e_without"])}R ({f["n_without"]})">{fr(d)}</td>'
    mx += '</tr>'

def score_tab(s):
    h = '<table><thead><tr><th>Score</th><th class="num">Trades</th><th class="num">Treffer (95 %-KI)</th><th class="num">Expectancy R (95 %-KI)</th><th class="num">PF</th><th class="num">Verlustserie</th></tr></thead><tbody>'
    for r in s['score']:
        if not r.get('n'): h += f'<tr><td>{r["s"]}</td><td class="num">0</td><td colspan="4" class="muted">keine Trades</td></tr>'; continue
        ci = r['ci']; low = r['n'] < 30
        h += (f'<tr{" class=muted" if low else ""}><td>{r["s"]}{" <span class=tag>nicht aussagekräftig (&lt; 30)</span>" if low else ""}</td><td class="num">{r["n"]}</td>'
              f'<td class="num">{pct(r["win"])} ({pct(ci[0])}–{pct(ci[1])})</td><td class="num"><b>{fr(r["exp"])}</b> ({fr(ci[2])} … {fr(ci[3])})</td>'
              f'<td class="num">{fr(r["pf"], 2, False) if r["pf"] else "–"}</td><td class="num">{r["streak"]}</td></tr>')
    return h + '</tbody></table>'

def filt_tab(fl, title):
    if not fl: return ''
    h = (f'<h4>{esc(title)}</h4><table><thead><tr><th>Filter</th><th class="num">Trades (Anteil)</th><th class="num">Trades/Woche</th><th class="num">Expectancy</th><th class="num">Δ OOS</th>'
         '<th class="num">Δ 1./2. Hälfte</th><th class="num">p95 Zufall</th><th>a</th><th>b</th><th>c</th><th>d</th><th>e</th><th>Halbjahre Δ</th></tr></thead><tbody>')
    for x in fl:
        hy = ' · '.join(f'{k[2:]} {fr(v, 2)}' for k, v in x['hy'].items())
        h += (f'<tr><td>{esc(x["label"])}{" <span class=warn>(langsamer bis Bestehen)</span>" if x.get("slower") else ""}</td><td class="num">{x["n"]} ({pct(x["share"])})</td><td class="num">{fr(x["perWeek"], 1, False)}</td>'
              f'<td class="num">{fr(x["exp"])}</td><td class="num"><b>{fr(x["d_oos"])}</b> ({x["n_oos"]})</td><td class="num">{fr(x["d_h1"])} / {fr(x["d_h2"])}</td><td class="num">{fr(x["p95"])}</td>'
              f'<td>{mark(x["a"])}</td><td>{mark(x["b"])}</td><td>{mark(x["c"])}</td><td>{mark(x["dd"])}</td><td>{mark(x.get("e")) if x.get("e") is not None else "–"}</td><td class="sm" style="white-space:nowrap">{esc(hy)}</td></tr>')
    return h + '</tbody></table>'

def ftmo_tab(s):
    h = '<h4>FTMO 2-Step (100k, Bootstrap 2000 Läufe)</h4><table><thead><tr><th>Variante</th><th>Risiko</th><th class="num">beide Phasen bestanden</th><th class="num">Ø Tage</th><th class="num">Median Tage</th><th class="num">Ausfälle durch Tagesverlust</th></tr></thead><tbody>'
    for k, d in s['ftmo'].items():
        for rk, x in d.items():
            h += f'<tr><td>{esc(k)}</td><td>{fr(rk, 2, False)} %</td><td class="num"><b>{pct(x["both"])}</b></td><td class="num">{fr(x["dmean"], 0, False) if x["dmean"] else "–"}</td><td class="num">{x["dmed"] or "–"}</td><td class="num">{pct(x["ftag"])}</td></tr>'
    return h + '</tbody></table>'

det = ''
for s in E:
    acc = [x for x in s['filters'] if x['accept']]
    checked = sorted([x for x in s['filters'] if x['label'] in s['ftmo'] and not x['accept']], key=lambda x: -x['d_oos'])
    det += (f'<details id="{s["id"]}"{" open" if acc else ""}><summary>{esc(s["name"])} – {esc(REC[s["rec"][0]][0])}</summary><div class="box">'
            f'<p class="sm">Basis: {s["n"]} Trades, Expectancy {fr(s["base"]["exp"])}R (IS {fr(s["base_is"])} / OOS {fr(s["base_oos"])}), {fr(s["base"]["perWeek"], 1, False)} Trades/Woche. OOS ab {s["cut"]}.</p>'
            f'<h4>Konfluenz-Score (K1 ±0,25 ATR + K2 ±0,3 ATR / 5 Swings + K3 ≥ 1 ATR)</h4>{score_tab(s)}'
            + filt_tab(acc, 'Übernommener Filter') + filt_tab(checked, 'Geprüfte Kandidaten (verworfen)') + ftmo_tab(s) + '</div></details>')

arch = ''.join(f'<tr><td>{esc(x["strategy"])}</td><td>{esc(x["label"])}</td><td class="num">{x["n"]}</td><td class="num">{fr(x["exp"])}</td><td class="num">{fr(x["d_oos"])}</td><td class="num">{fr(x["d_h1"])} / {fr(x["d_h2"])}</td>'
               f'<td class="num">{fr(x["p95"])}</td><td class="num">{fr(x["perWeek"], 1, False)}</td><td>{mark(x["a"])}</td><td>{mark(x["b"])}</td><td>{mark(x["c"])}</td><td>{mark(x["dd"])}</td></tr>' for x in A)
n_tests = sum(len(s['filters']) for s in E)

TIP = "<div id=tip></div><script>const t=document.getElementById('tip');document.addEventListener('mousemove',e=>{const el=e.target.closest('[data-tip]');if(!el){t.style.display='none';return}t.textContent=el.dataset.tip;t.style.display='block';t.style.left=Math.min(e.clientX+12,innerWidth-t.offsetWidth-8)+'px';t.style.top=(e.clientY+14)+'px'});</script>"
H = f'''<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Konfluenz-Analyse</title><style>{CSS}</style></head><body><div class="viz-root"><div class="wrap">
<h1>Konfluenz-Analyse („Multi-Edge“) – d_ilikebigbots und d_ftmo</h1>
<p class="sub">19 Live-Strategien, Backtest-Trades der Live-Code-Engine (Original-Code) · Merkmale auf M15 zum Signalzeitpunkt · erstellt {now}.</p>
<div class="box"><b>Methode:</b> Signalzeitpunkt = Einstieg − Wartezeit bis zur Füllung (Limit-Orders) bzw. Einstieg (Market), auf den 5-Min-Cron gerundet. Nur M15-Kerzen, die zu diesem Zeitpunkt geschlossen waren;
Fraktal-Swings (2 Kerzen links/rechts) erst 2 Kerzen nach dem Swing verwendet; „gebrochen“ = späterer Schluss jenseits des Levels, ebenfalls vor dem Signal. ATR = ATR14 M15 (Wilder).
Filter = nur Trades mit Merkmal behalten (keine Folgeeffekte auf spätere Orders). Zufallskontrolle: 1000 zufällige Teilmengen gleicher Größe. OOS = letzte 30 % des Zeitraums.
<br><b>Entscheidungsregel:</b> (a) OOS-Plus ≥ +0,05R, (b) Expectancy über p95 der Zufallsfilter, (c) beide Zeithälften besser, (d) ≥ 1 Trade/Woche, (e) FTMO-Bestehensquote (0,5 %) nicht schlechter.
<br><b>Mehrfachtests:</b> {n_tests} Filter-Strategie-Kombinationen geprüft – rein zufällig würden etwa 5 % Kriterium (b) erfüllen. Einzelne Treffer daher nur mit Plateau und Forward-Test ernst nehmen.</div>

<h2>1 · Empfehlung je Strategie</h2>
<div class="tw"><table><thead><tr><th>Strategie</th><th class="num">Trades</th><th class="num">Expectancy</th><th class="num">Trades/Woche</th><th>Empfehlung</th><th>Begründung</th></tr></thead><tbody>{over}</tbody></table></div>

<h2>2 · Welches Merkmal trägt? Δ Expectancy mit − ohne Merkmal (Standardparameter)</h2>
<div class="tw"><table>{mx}</table></div>
<p class="sub sm">Blau = Trades mit Merkmal besser. Grau in Klammern = eine Gruppe hat weniger als 30 Trades (nicht aussagekräftig). Z2 (Tick-Volumen) nur US100/DE40. Maus über eine Zelle zeigt die Werte.</p>

<h2>3 · Details je Strategie</h2>
{det}
<p class="sub sm">Alle verworfenen Filter stehen im <a href="archiv.html">Archiv</a> (nicht im Dashboard).</p>
</div>{TIP}</div></body></html>'''
open(os.path.join(OUT, 'report.html'), 'w').write(H)
AH = f'''<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>Konfluenz-Analyse – Archiv</title><style>{CSS}</style></head><body><div class="viz-root"><div class="wrap">
<h1>Archiv: verworfene Konfluenz-Filter</h1><p class="sub">{len(A)} Filter-Strategie-Kombinationen, die die Entscheidungsregel nicht erfüllen ({now}). a OOS ≥ +0,05R · b über p95 Zufall · c beide Hälften · d ≥ 1 Trade/Woche.</p>
<div class="tw"><table><thead><tr><th>Strategie</th><th>Filter</th><th class="num">Trades</th><th class="num">Expectancy</th><th class="num">Δ OOS</th><th class="num">Δ Hälften</th><th class="num">p95 Zufall</th><th class="num">/Woche</th><th>a</th><th>b</th><th>c</th><th>d</th></tr></thead><tbody>{arch}</tbody></table></div>
</div></div></body></html>'''
open(os.path.join(OUT, 'archiv.html'), 'w').write(AH)
print('geschrieben', os.path.join(OUT, 'report.html'), 'und archiv.html')
