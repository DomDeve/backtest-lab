#!/usr/bin/env python3
"""Report zu Modul A (Robustheit) + B (FTMO): out/analyse/robustheit.html mit Reitern Top-10 / Kandidaten / Archiv.
Liest out/analyse/robustheit.json (aus tools/modul_a.py)."""
import json, os, html, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out', 'analyse')
J = json.load(open(os.path.join(OUT, 'robustheit.json')))
V = J['variants']; MIN_OOS = J['min_oos']; PRELIM = 100
esc = lambda s: html.escape(str(s), quote=True)
def fr(x, d=2, sign=True):
    if x is None: return '–'
    return ((f'{x:+.{d}f}' if sign else f'{x:.{d}f}')).replace('.', ',')
pct = lambda x: '–' if x is None else f'{x*100:.0f} %'
CSS = open(os.path.join(ROOT, 'tools', 'ftmo_sim.py')).read().split("CSS = r'''")[1].split("'''")[0]
CSS += '''.tabs{display:flex;gap:6px;margin:14px 0}.tabs button{font:inherit;border:1px solid var(--bd);background:var(--s1);color:var(--t1);padding:6px 14px;border-radius:999px;cursor:pointer}
.tabs button[aria-pressed="true"]{background:var(--t1);color:var(--s1)}.pane{display:none}.pane.on{display:block}.ok{color:var(--c3);font-weight:700}.no{color:var(--neg)}.q{color:var(--t3)}
.blk{display:inline-flex;gap:2px;align-items:flex-end;height:22px}.blk i{display:inline-block;width:6px;border-radius:1px}.warn{color:var(--c4);font-weight:600}.red{color:var(--neg);font-weight:700}'''

def blocks(v):
    m = max([abs(b) for b in v['blocks'] if b is not None] or [1])
    return '<span class="blk" data-tip="' + esc(' · '.join(fr(b) for b in v['blocks'])) + '">' + ''.join(
        '<i style="height:2px;background:var(--bd)"></i>' if b is None else f'<i style="height:{max(2, abs(b) / m * 20):.0f}px;background:{"var(--pos)" if b > 0 else "var(--neg)"}"></i>' for b in v['blocks']) + '</span>'

def cost(v):
    c = v['cost_share']
    if c is None: return '<span class="red">Brutto ≤ 0</span>'
    cls = 'red' if c > 0.5 else ('warn' if c > 0.3 else '')
    return f'<span class="{cls}">{"> 100 %" if c > 1 else pct(c)}</span>'

def crit(v):
    d = v.get('decision')
    if not d: return '<span class="q">Basis</span>'
    lab = {'oos_plus': 'OOS ≥ +0,05R', 'zufall': 'über p95 Zufall', 'bloecke': '≥ 7/10 Blöcke', 'pf_ohne_besten': 'PF ohne besten > 1', 'kosten': 'Kosten < 40 %', 'ftmo': 'FTMO nicht schlechter', 'frequenz': '≥ 1 Trade/Woche'}
    return ' '.join(f'<span class="{"ok" if x else "no"}" title="{lab[k]}">{"✓" if x else "✗"}</span>' for k, x in d['crit'].items())

def ftmo_cell(v, rk='0.5'):
    x = v['ftmo'].get(rk, {}).get('bootstrap') or {}
    return f'{pct(x.get("both"))} · {x.get("days_median") or "–"} T'

def row(v, rank=None):
    ci = v['ci'] or {}
    return (f'<tr><td class="num">{rank or ""}</td><td><b>{esc(v["name"])}</b><div class="sm muted">{esc(v["id"])} · {v["instrument"]}{" · Basis " + esc(v["base"]) if v.get("base") and v["base"] != v["id"] else ""}</div></td>'
            f'<td class="num">{v["n"]} / <b>{v["n_oos"]}</b></td><td class="num">{fr(v["exp_is"])}</td><td class="num"><b>{fr(v["exp_oos"])}</b></td>'
            f'<td class="num sm">{fr((ci.get("exp") or [None])[0])} … {fr((ci.get("exp") or [None, None])[1])}</td><td>{blocks(v)} <span class="sm">{v["blocks_pos"]}/10</span></td>'
            f'<td class="num">{fr(v["pf_wo1"], 2, False)} / {fr(v["pf_wo3"], 2, False)}</td><td class="num">{cost(v)}</td><td class="num">{fr(v["per_week"], 1, False)}</td>'
            f'<td class="num">{ftmo_cell(v)}</td><td>{crit(v)}</td></tr>')

HEAD = ('<thead><tr><th>#</th><th>Variante</th><th class="num">Trades / OOS</th><th class="num">Ø R IS</th><th class="num">Ø R OOS</th><th class="num">95 %-KI Ø R</th>'
        '<th>10 Blöcke</th><th class="num">PF ohne 1 / 3 beste</th><th class="num">Kostenanteil</th><th class="num">/Woche</th><th class="num">FTMO 0,5 %</th><th>Regel vs. Basis</th></tr></thead>')

def eligible(v, min_oos):
    if v['category'] == 'kandidat' or v['n_oos'] < min_oos or (v['exp_oos'] or 0) <= 0: return False
    return v['category'] == 'live' or (v.get('decision') or {}).get('besser')

official = sorted([v for v in V.values() if eligible(v, MIN_OOS)], key=lambda v: -v['exp_oos'])[:10]
prelim = sorted([v for v in V.values() if eligible(v, PRELIM) and v not in official], key=lambda v: -v['exp_oos'])[:10]
cands = sorted([v for v in V.values() if v['category'] == 'kandidat'], key=lambda v: -(v['exp_oos'] or -9))
shown = {v['id'] for v in official + prelim + cands}
archive = sorted([v for v in V.values() if v['id'] not in shown], key=lambda v: (v['instrument'], -(v['exp_oos'] or -9)))

def table(vs, numbered=True): return '<div class="tw"><table>' + HEAD + '<tbody>' + ''.join(row(v, i + 1 if numbered else None) for i, v in enumerate(vs)) + '</tbody></table></div>'

live_ftmo = ''
for v in sorted([v for v in V.values() if v['category'] == 'live'], key=lambda v: -(v['exp'] or -9)):
    cells = ''.join(f'<td class="num">{pct(v["ftmo"][str(rk)]["bootstrap"]["both"])}<div class="sm muted">{v["ftmo"][str(rk)]["bootstrap"]["days_median"] or "–"} T</div></td>' for rk in J['risks'] if str(rk) in v['ftmo'])
    b05 = v['ftmo']['0.5']['bootstrap']
    live_ftmo += (f'<tr><td>{esc(v["name"])}</td>{cells}<td class="num">{pct(b05["fail_tag"])} / {pct(b05["fail_gesamt"])}</td><td class="num">{fr(b05["min_eq_p5"], 1, False)} %</td></tr>')

now = datetime.date.today().strftime('%d.%m.%Y')
H = f'''<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Robustheit & FTMO</title><style>{CSS}</style></head><body><div class="viz-root"><div class="wrap">
<h1>Modul A + B – Robustheit und FTMO je Variante</h1>
<p class="sub">{len(V)} Varianten aus d_ilikebigbots / d_ftmo (live + getestete Varianten) und Kandidaten · aus dem Trade-Log (out/tradelog/tradelog.sqlite) · Seed {J["seed"]} · erstellt {now}.
<b>Achtung: Phase 0 (Live-Abgleich) steht noch aus</b> – bis dahin gelten alle Zahlen vorbehaltlich.</p>
<div class="box"><b>Regel „besser als Basis“:</b> OOS-Plus ≥ +0,05R · über p95 der Zufallskontrolle (zufällige Teilmengen der Basis-OOS-Trades) · ≥ 7/10 Blöcke positiv · PF ohne besten Trade &gt; 1 · Kostenanteil &lt; 40 % · FTMO-Bestehensquote (0,5 %, Block-Bootstrap) nicht schlechter · ≥ 1 Trade/Woche.
Kostenanteil = (Brutto − Netto) / Brutto über alle Trades; Brutto enthält den Spread (Kommission/Swap laut config/kosten.json, aktuell 0).
<br><b>Mindeststichprobe:</b> {MIN_OOS} OOS-Trades für die offizielle Top-10. Das erreichen nur {sum(1 for v in V.values() if v["n_oos"] >= MIN_OOS)} Varianten (alle EURUSD) – die NAS-/DE40-Bots handeln dafür zu selten. Deshalb zusätzlich eine <b>vorläufige</b> Rangliste ab {PRELIM} OOS-Trades.</div>
<div class="tabs" role="tablist"><button aria-pressed="true" data-p="top">Top-10</button><button aria-pressed="false" data-p="kand">Kandidaten</button><button aria-pressed="false" data-p="ftmo">FTMO je Live-Bot</button><button aria-pressed="false" data-p="arch">Archiv</button></div>
<div class="pane on" id="top"><h2>Top-10 (offiziell, ≥ {MIN_OOS} OOS-Trades)</h2>{table(official) if official else '<div class="box">Keine Variante erfüllt ≥ ' + str(MIN_OOS) + ' OOS-Trades, positive OOS-Expectancy und die Regel gegenüber ihrer Basis.</div>'}
<h2>Vorläufige Rangliste (≥ {PRELIM} OOS-Trades, Live-Bots oder Regel erfüllt)</h2>{table(prelim)}</div>
<div class="pane" id="kand"><h2>Kandidaten (eigener Bereich, bis sie ihre Basis schlagen)</h2>{table(cands, False)}
<p class="sub sm">Fair Price ist noch nicht im Trade-Log (eigene M5-Näherung, siehe out/kandidaten/fairprice/report.html) – folgt mit Modul E.</p></div>
<div class="pane" id="ftmo"><h2>FTMO 2-Step je Live-Bot (Block-Bootstrap nach Woche, 1000 Läufe)</h2>
<div class="tw"><table><thead><tr><th>Bot</th>{"".join(f"<th class=num>{fr(r, 2, False)} %</th>" for r in J["risks"])}<th class="num">Ausfall Tag / Gesamt (0,5 %)</th><th class="num">5 %-schlechteste Equity (0,5 %)</th></tr></thead><tbody>{live_ftmo}</tbody></table></div>
<p class="sub sm">Zelle = Anteil, der beide Phasen besteht; darunter Median Handelstage bis Bestehen. Tagesverlust inkl. offener Position über die MAE angenähert.</p></div>
<div class="pane" id="arch"><h2>Archiv ({len(archive)} Varianten)</h2>{table(archive, False)}</div>
</div><div id="tip"></div></div>
<script>document.querySelectorAll('[data-p]').forEach(b=>b.onclick=()=>{{document.querySelectorAll('[data-p]').forEach(x=>x.setAttribute('aria-pressed',x===b));document.querySelectorAll('.pane').forEach(p=>p.classList.toggle('on',p.id===b.dataset.p))}});
const t=document.getElementById('tip');document.addEventListener('mousemove',e=>{{const el=e.target.closest('[data-tip]');if(!el){{t.style.display='none';return}}t.textContent=el.dataset.tip;t.style.display='block';t.style.left=Math.min(e.clientX+12,innerWidth-t.offsetWidth-8)+'px';t.style.top=(e.clientY+14)+'px'}});</script></body></html>'''
open(os.path.join(OUT, 'robustheit.html'), 'w').write(H)
print('geschrieben', os.path.join(OUT, 'robustheit.html'), '| offiziell', len(official), '| vorläufig', len(prelim), '| Kandidaten', len(cands), '| Archiv', len(archive))
print('vorläufig:', [v['id'] for v in prelim])
