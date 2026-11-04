#!/usr/bin/env python3
"""Verbesserungen des Abends + FTMO-Simulation (Challenge 2-stufig + Funded-Payout).

Annahmen (FTMO 2-Step, Stand der Annahme – vor Kauf mit den aktuellen FTMO-Regeln abgleichen):
  Phase 1 Ziel +10 %, Phase 2 Ziel +5 %, max. Tagesverlust 5 % und max. Gesamtverlust 10 % jeweils vom Startkapital,
  mind. 4 Handelstage je Phase, kein Zeitlimit (Simulation bricht nach 250 Handelstagen ab).
  Funded: 100k, Gewinnbeteiligung 80 %, Auszahlung monatlich (21 Handelstage), danach Konto wieder 100k,
  Verlustgrenze bleibt bei 90k (10 %), Tagesverlust 5 %.
Simulation: Handelstage zufällig aus dem Backtest gezogen (Tag = alle Trades dieses Tages, Tage ohne Trade im
  echten Verhältnis), Risiko je Trade in % vom aktuellen Konto. Basis = Backtest-Verteilung -> eher optimistisch.
"""
import json, os, random, datetime, math

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out', 'live')
LIVE = {'nas-f618atr', 'nas-fib50-lb2', 'nas-fib50-lb3', 'nas-fib61-lb1', 'nas-fib61-lb2', 'nas-fib61-lb3',
        'de40-basis', 'de40-confl3', 'de40-dist150', 'de40-q07', 'de40-adx25', 'de40-combo',
        'eu-c1', 'eu-c2', 'eu-c3', 'eu-c4', 'eu-c5', 'eu-c6'}
TONIGHT_PREFIX = ('eu-sbf', 'eu-c3-mifr', 'eu-c4-mifr', 'eu-c5-mifr', 'eu-c6-mifr', 'nas-sw-', 'nas-f618-', 'nas-f50lb2-')
TONIGHT_SUFFIX = ('-mf', '-adx30')

def load(i):
    with open(os.path.join(OUT, i, 'result.json')) as f: return json.load(f)

def root_base(i, cache={}):
    r = cache.get(i) or load(i); cache[i] = r
    b = r.get('base')
    while b and b not in LIVE:
        b = (cache.get(b) or load(b)).get('base')
    return b

def weekdays(a, b):
    d, n = datetime.date.fromisoformat(a), 0
    e = datetime.date.fromisoformat(b)
    while d <= e:
        n += d.weekday() < 5; d += datetime.timedelta(days=1)
    return n

def stats(r):
    tr = [t for t in r['trades'] if t.get('R') is not None]
    a, b = r['period']['from'], r['period']['to']
    da, db = datetime.date.fromisoformat(a), datetime.date.fromisoformat(b)
    mid = (da + (db - da) / 2).isoformat()
    m = lambda v: sum(v) / len(v) if v else float('nan')
    months = (db - da).days / 30.44
    R = [t['R'] for t in tr]
    return dict(n=len(R), avg=m(R), sum=sum(R), h1=m([t['R'] for t in tr if t['date'] < mid]), h2=m([t['R'] for t in tr if t['date'] >= mid]),
                perMonth=sum(R) / months, tradesPerMonth=len(R) / months, months=months, tradingDays=weekdays(a, b), mid=mid,
                p=r['summary']['pValue'], pf=r['summary']['profitFactor'], dd=r['summary']['maxDDR'], win=r['summary']['winRate'])

def day_pool(r, tdays):
    by = {}
    for t in r['trades']:
        if t.get('R') is not None: by.setdefault(t['date'], []).append(t['R'])
    days = list(by.values())
    return days, min(1.0, len(days) / max(tdays, 1))

def sim_phase(rnd, days, pT, risk, target, maxDays=250):
    eq = 100.0; traded = 0
    for d in range(1, maxDays + 1):
        if rnd.random() > pT: continue
        start = eq; traded += 1
        for R in days[rnd.randrange(len(days))]:
            eq *= 1 + R * risk / 100
            if eq <= 90 or start - eq >= 5: return 'fail', d
            if eq >= 100 + target and traded >= 4: return 'pass', d
    return 'timeout', maxDays

def challenge(r, st, risk, runs=4000, seed=7):
    days, pT = day_pool(r, st['tradingDays'])
    rnd = random.Random(seed)
    ok = fail = 0; dur = []
    for _ in range(runs):
        s1, d1 = sim_phase(rnd, days, pT, risk, 10)
        if s1 != 'pass': fail += s1 == 'fail'; continue
        s2, d2 = sim_phase(rnd, days, pT, risk, 5)
        if s2 != 'pass': fail += s2 == 'fail'; continue
        ok += 1; dur.append(d1 + d2)
    dur.sort()
    q = lambda p: dur[int(p * (len(dur) - 1))] if dur else None
    return dict(risk=risk, pass_=ok / runs, fail=fail / runs, timeout=1 - (ok + fail) / runs, medDays=q(0.5), p25=q(0.25), p75=q(0.75))

def funded(r, st, risk, runs=4000, seed=9, months=12, split=0.8, cap=100_000):
    days, pT = day_pool(r, st['tradingDays'])
    rnd = random.Random(seed)
    tot, lost, monthly = [], 0, []
    for _ in range(runs):
        eq = 100.0; paid = 0.0; dead = False
        for mo in range(months):
            for _d in range(21):
                if rnd.random() > pT: continue
                start = eq
                for R in days[rnd.randrange(len(days))]:
                    eq *= 1 + R * risk / 100
                    if eq <= 90 or start - eq >= 5: dead = True; break
                if dead: break
            if dead: break
            if eq > 100:
                paid += (eq - 100) / 100 * cap * split; eq = 100.0
        lost += dead; tot.append(paid)
    tot.sort()
    return dict(risk=risk, payoutMonth=sum(tot) / runs / months, payoutMonthMedian=tot[len(tot) // 2] / months,
                payoutMonthP10=tot[int(0.1 * len(tot))] / months, lost12m=lost / runs)

def analyse():
    ids = sorted(d for d in os.listdir(OUT) if os.path.isfile(os.path.join(OUT, d, 'result.json'))
                 and (d.startswith(TONIGHT_PREFIX) or (d.startswith('de40-') and d.endswith(TONIGHT_SUFFIX))))
    rows = []
    for i in ids:
        r = load(i); b = root_base(i); rb = load(b)
        s, sb = stats(r), stats(rb)
        better = s['avg'] > sb['avg'] and s['h1'] > sb['h1'] and s['h2'] > sb['h2']
        rows.append(dict(id=i, name=r['name'], symbol=r['symbol'], group=r['group'], base=b, baseName=rb['name'], s=s, sb=sb, better=better,
                         riskBT=r['engine'].get('riskPercent', 1), r=r, rb=rb))
    return rows

if __name__ == '__main__':
    rows = analyse()
    for x in rows:
        s, sb = x['s'], x['sb']
        print(f"{'✓' if x['better'] else ' '} {x['id']:22s} vs {x['base']:14s} Ø {s['avg']:+.3f} ({sb['avg']:+.3f})  H {s['h1']-sb['h1']:+.2f}/{s['h2']-sb['h2']:+.2f}  R/Monat {s['perMonth']:+.2f}  n {s['n']}")

RISKS = [0.25, 0.5, 0.75, 1.0, 1.5]

def portfolio(rows, ids, name):
    """Gemeinsames Konto: Trades aller Bots je Tag zusammen, Zeitraum = Überschneidung."""
    rs = [next(x for x in rows if x['id'] == i)['r'] for i in ids]
    a = max(r['period']['from'] for r in rs); b = min(r['period']['to'] for r in rs)
    trades = sorted((t for r in rs for t in r['trades'] if t.get('R') is not None and a <= t['date'] <= b), key=lambda t: (t['date'], t.get('entryT') or 0))
    r = {'name': name, 'period': {'from': a, 'to': b}, 'trades': trades, 'summary': {'pValue': None, 'profitFactor': None, 'maxDDR': None, 'winRate': None}, 'engine': {'riskPercent': 1}}
    R = [t['R'] for t in trades]; m = sum(R) / len(R); sd = (sum((x - m) ** 2 for x in R) / (len(R) - 1)) ** .5
    from math import erf, sqrt
    tval = m / (sd / sqrt(len(R))); r['summary']['pValue'] = 2 * (1 - 0.5 * (1 + erf(abs(tval) / sqrt(2))))
    gp = sum(x for x in R if x > 0); gl = -sum(x for x in R if x < 0); r['summary']['profitFactor'] = gp / gl if gl else None
    eq = pk = dd = 0
    for x in R: eq += x; pk = max(pk, eq); dd = max(dd, pk - eq)
    r['summary']['maxDDR'] = dd; r['summary']['winRate'] = sum(1 for x in R if x > 0) / len(R)
    return r

def run_all():
    rows = analyse()
    cand = [x for x in rows if x['better'] and x['s']['avg'] > 0]
    pf_ids = ['nas-f618-l2r1ext-h15', 'de40-basis-mf', 'eu-c4-mifr-adx']
    pr = portfolio(rows, pf_ids, 'Portfolio: F618ATR L2/R1+Extrem o.15h + LVN Basis-mf + EURUSD C4-mifr-adx')
    cand.append(dict(id='portfolio-3', name=pr['name'], symbol='MIX', group='Portfolio', base=None, baseName='–', s=stats(pr), sb=None, better=True, riskBT=1, r=pr, members=pf_ids))
    out = []
    for x in cand:
        ch = [challenge(x['r'], x['s'], k) for k in RISKS]
        fu = [funded(x['r'], x['s'], k) for k in RISKS]
        out.append(dict(id=x['id'], ch=ch, fu=fu))
        best = max(zip(ch, fu), key=lambda cf: cf[0]['pass_'])
        print(f"{x['id']:22s} " + ' | '.join(f"{c['risk']}%: {c['pass_']*100:3.0f}% {c['medDays'] or '-'}T {f['payoutMonth']:6.0f}€ verl {f['lost12m']*100:3.0f}%" for c, f in zip(ch, fu)))
    return rows, cand, out

if __name__ == '__main__' and os.environ.get('FTMO_SIM'):
    rows, cand, out = run_all()
    with open(os.path.join(OUT, 'ftmo_sim.json'), 'w') as f:
        json.dump({'sim': out, 'cand': [{k: v for k, v in c.items() if k not in ('r', 'rb')} for c in cand]}, f)

# ---------------------------------------------------------------- Dashboard
import html as _h
esc = lambda s: _h.escape(str(s), quote=True)
def fr(x, d=2, sign=True):
    if x is None or (isinstance(x, float) and math.isnan(x)): return '–'
    s = f'{x:+.{d}f}' if sign else f'{x:.{d}f}'
    return s.replace('.', ',')
def eur(x): return f'{x:,.0f} €'.replace(',', '.')
def pick_risk(ch, fu):
    """Höchstes Risiko mit ≤ 10 % Kontoverlust in 12 Monaten Funded und ≤ 15 % Scheitern in der Challenge."""
    best = None
    for c, f in zip(ch, fu):
        if f['lost12m'] <= 0.10 and c['fail'] <= 0.15 and c['pass_'] > 0: best = (c, f)
    return best

def curve(r):
    pts, c = [], 0.0
    for t in r['trades']:
        if t.get('R') is None: continue
        c += t['R']; pts.append([t['date'], round(c, 2)])
    return pts

def render(rows, cand, sims):
    simmap = {s['id']: s for s in sims}
    imp = [x for x in rows if x['better']]
    EP = {'US100': 'NAS100', 'DE40': 'DE40', 'EURUSD': 'EURUSD', 'MIX': 'Portfolio'}
    order = {'US100': 0, 'DE40': 1, 'EURUSD': 2}
    imp.sort(key=lambda x: (order.get(x['symbol'], 9), -x['s']['avg']))
    # Tabelle
    trs = ''
    for x in imp + [c for c in cand if c['id'] == 'portfolio-3']:
        s, sb = x['s'], x['sb']; sm = simmap.get(x['id'])
        pk = pick_risk(sm['ch'], sm['fu']) if sm else None
        ftmo = (f'<td class="num">{fr(pk[0]["risk"], 2, False)} %</td><td class="num"><b>{pk[0]["pass_"]*100:.0f} %</b></td><td class="num">{pk[0]["medDays"] or "–"} ({fr((pk[0]["medDays"] or 0)/21, 1, False)} Mon.)</td>'
                f'<td class="num"><b>{eur(pk[1]["payoutMonth"])}</b></td><td class="num">{pk[1]["lost12m"]*100:.0f} %</td>') if pk else '<td colspan="5" class="muted">nicht geeignet (Ø ≤ 0 oder zu riskant)</td>'
        base = f'{fr(sb["avg"])} → ' if sb else ''
        dh = f'{fr(s["h1"]-sb["h1"])} / {fr(s["h2"]-sb["h2"])}' if sb else '–'
        trs += (f'<tr data-epic="{x["symbol"]}"><td><span class="ep">{EP.get(x["symbol"], x["symbol"])}</span> <a href="#c-{x["id"]}">{esc(x["name"])}</a><div class="muted sm">{esc(x["baseName"]) if sb else "3 Bots, gemeinsames Konto"}</div></td>'
                f'<td class="num">{base}<b class="{"post" if s["avg"] >= 0 else "negt"}">{fr(s["avg"])}</b></td><td class="num">{dh}</td><td class="num">{s["n"]} ({fr(s["tradesPerMonth"], 1, False)}/M)</td>'
                f'<td class="num">{fr(s["perMonth"])}R</td><td class="num">{fr(s["perMonth"]*1, 2)} %</td><td class="num">{fr(s["p"], 3, False) if s["p"] is not None else "–"}</td>{ftmo}</tr>')
    # Kurven-Daten
    cards = ''
    for x in [c for c in cand if c['id'] == 'portfolio-3'] + imp:
        r = x['r']; d = {'new': curve(r), 'base': curve(x['rb']) if x.get('rb') else None, 'from': r['period']['from'], 'to': r['period']['to']}
        sm = simmap.get(x['id']); pk = pick_risk(sm['ch'], sm['fu']) if sm else None
        s = x['s']
        meta = (f'Ø {fr(s["avg"])}R · {s["n"]} Trades · Σ {fr(s["sum"], 1)}R = {fr(s["sum"], 1)} % bei 1 % Risiko'
                + (f' · FTMO bei {fr(pk[0]["risk"], 2, False)} %: {pk[0]["pass_"]*100:.0f} % bestanden, Median {pk[0]["medDays"]} Handelstage, Ø {eur(pk[1]["payoutMonth"])}/Monat' if pk else ''))
        cards += (f'<figure class="card" id="c-{x["id"]}" data-epic="{x["symbol"]}"><figcaption><span class="ep">{EP.get(x["symbol"], x["symbol"])}</span> <b>{esc(x["name"])}</b>'
                  f'<div class="muted sm">{esc(meta)}</div></figcaption><svg class="eq" viewBox="0 0 560 190" data-c=\'{json.dumps(d)}\' role="img" aria-label="Kapitalkurve {esc(x["name"])}"></svg>'
                  f'<div class="lg"><span><i class="ln new"></i>Testvariante</span>' + ('<span><i class="ln base"></i>bestehende Variante</span>' if x.get('rb') else '') + '</div></figure>')
    # FTMO-Risikokurven (Top 5)
    top = ['portfolio-3', 'nas-f618-l2r1ext-h15', 'nas-f50lb2-h15mo', 'de40-basis-mf', 'eu-c4-mifr-adx']
    names = {c['id']: c['name'] for c in cand}
    short = {'portfolio-3': 'Portfolio 3 Bots', 'nas-f618-l2r1ext-h15': 'NAS F618ATR L2/R1+Ext o.15h', 'nas-f50lb2-h15mo': 'NAS Fib50 LB2 o.15h/Mo', 'de40-basis-mf': 'DE40 LVN Basis-mf', 'eu-c4-mifr-adx': 'EURUSD C4 o.Mi/Fr/ADX'}
    fdata = {i: {'name': short[i], 'pass': [c['pass_'] for c in simmap[i]['ch']], 'lost': [f['lost12m'] for f in simmap[i]['fu']], 'pay': [f['payoutMonth'] for f in simmap[i]['fu']], 'days': [c['medDays'] for c in simmap[i]['ch']]} for i in top}
    # Detailtabelle FTMO je Risiko
    ft = ''
    for i in top:
        sm = simmap[i]; pk = pick_risk(sm['ch'], sm['fu'])
        for c, f in zip(sm['ch'], sm['fu']):
            mark = ' class="pick"' if pk and c['risk'] == pk[0]['risk'] else ''
            ft += (f'<tr{mark}><td>{esc(short[i])}</td><td class="num">{fr(c["risk"], 2, False)} %</td><td class="num">{c["pass_"]*100:.0f} %</td><td class="num">{c["fail"]*100:.0f} %</td>'
                   f'<td class="num">{c["medDays"] or "–"} / {c["p25"] or "–"}–{c["p75"] or "–"}</td><td class="num">{eur(f["payoutMonth"])}</td><td class="num">{eur(f["payoutMonthP10"])}</td><td class="num">{f["lost12m"]*100:.0f} %</td></tr>')
    pf = next(c for c in cand if c['id'] == 'portfolio-3'); pfs = simmap['portfolio-3']; pfk = pick_risk(pfs['ch'], pfs['fu'])
    nas = simmap['nas-f618-l2r1ext-h15']; nk = pick_risk(nas['ch'], nas['fu'])
    now = datetime.date.today().strftime('%d.%m.%Y')
    return TEMPLATE.format(CSS=CSS, JS=JS, now=now, n_imp=len(imp), n_all=len(rows), n_pos=sum(1 for x in imp if x['s']['avg'] > 0), trs=trs, cards=cards, ft=ft,
        fdata=json.dumps(fdata), risks=json.dumps(RISKS),
        pf_pass=f'{pfk[0]["pass_"]*100:.0f} %', pf_risk=fr(pfk[0]['risk'], 2, False), pf_days=pfk[0]['medDays'], pf_mon=fr(pfk[0]['medDays']/21, 1, False), pf_pay=eur(pfk[1]['payoutMonth']), pf_lost=f'{pfk[1]["lost12m"]*100:.0f} %',
        n_pass=f'{nk[0]["pass_"]*100:.0f} %', n_risk=fr(nk[0]['risk'], 2, False), n_days=nk[0]['medDays'], n_mon=fr(nk[0]['medDays']/21, 1, False), n_pay=eur(nk[1]['payoutMonth']), n_lost=f'{nk[1]["lost12m"]*100:.0f} %')

CSS = r'''
.viz-root{color-scheme:light;--s0:#f4f3f0;--s1:#fcfcfb;--bd:#e2e1dc;--t1:#0b0b0b;--t2:#52514e;--t3:#77766f;--grid:#ebeae6;--c1:#2a78d6;--c2:#eb6834;--c3:#1baf7a;--c4:#eda100;--c5:#e87ba4;--pos:#2a78d6;--neg:#e34948}
@media (prefers-color-scheme:dark){.viz-root{color-scheme:dark;--s0:#111110;--s1:#1a1a19;--bd:#33332f;--t1:#f0efec;--t2:#c3c2b7;--t3:#9a998f;--grid:#2a2a27;--c1:#3987e5;--c2:#d95926;--c3:#199e70;--c4:#c98500;--c5:#d55181;--pos:#3987e5;--neg:#e66767}}
body{margin:0}.viz-root{background:var(--s0);color:var(--t1);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh}
.wrap{max-width:1280px;margin:0 auto;padding:24px 20px 60px}h1{font-size:23px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 10px}
.sub,.muted{color:var(--t2)}.sm{font-size:12px}.box,.tile,.card,.tw{background:var(--s1);border:1px solid var(--bd);border-radius:10px}
.box{padding:12px 16px;margin:10px 0}.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}.tile{padding:12px 14px}
.hero{font-size:26px;font-weight:650;font-variant-numeric:tabular-nums}.kl{font-size:12px;color:var(--t2)}.ks{font-size:12px;color:var(--t3)}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{padding:6px 8px;border-bottom:1px solid var(--bd);text-align:left;vertical-align:top}td:first-child{min-width:210px}
th{color:var(--t2);font-weight:600;font-size:12px}.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.post{color:var(--pos)}.negt{color:var(--neg)}
tr.pick td{background:color-mix(in srgb,var(--c1) 14%,transparent);font-weight:600}
.ep{font-size:10.5px;font-weight:700;letter-spacing:.05em;color:var(--t3);margin-right:4px}
.ctl{display:flex;gap:8px;align-items:center;flex-wrap:wrap;position:sticky;top:0;background:var(--s0);padding:10px 0;z-index:5;border-bottom:1px solid var(--bd)}
.ctl button{font:inherit;font-size:13px;border:1px solid var(--bd);background:var(--s1);color:var(--t1);padding:4px 12px;border-radius:999px;cursor:pointer}
.ctl button[aria-pressed="true"]{background:var(--t1);color:var(--s1);border-color:var(--t1)}.ctl .sep{width:1px;height:20px;background:var(--bd);margin:0 6px}
.grid2{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.card{margin:0;padding:10px 12px}.card figcaption{font-size:13px}
.eq{width:100%;height:auto;display:block}.lg{display:flex;gap:14px;font-size:12px;color:var(--t2)}.lg span{display:inline-flex;align-items:center;gap:6px}
.ln{width:18px;height:0;border-top:2px solid var(--c1);display:inline-block}.ln.base{border-top:2px dashed var(--t3)}
.ax{font-size:10.5px;fill:var(--t3)}.gl{stroke:var(--grid)}.zero{stroke:var(--t3);stroke-dasharray:2 3}
.pl{fill:none;stroke-width:2;stroke-linejoin:round}.pl.new{stroke:var(--c1)}.pl.base{stroke:var(--t3);stroke-dasharray:5 4;stroke-width:1.5}
.dot{stroke:var(--s1);stroke-width:2}.lab{font-size:11px;fill:var(--t1)}
#tip{position:fixed;pointer-events:none;background:var(--t1);color:var(--s1);font-size:12px;padding:6px 9px;border-radius:6px;display:none;max-width:340px;z-index:9;white-space:pre-line}
.hidden{display:none!important}ul{margin:6px 0;padding-left:20px}li{margin:3px 0}
@media (max-width:900px){.tiles{grid-template-columns:repeat(2,1fr)}.grid2{grid-template-columns:1fr}}
'''

JS = r'''
const tip=document.getElementById('tip');let UNIT='R';
const show=(t,e)=>{tip.textContent=t;tip.style.display='block';tip.style.left=Math.min(e.clientX+12,innerWidth-tip.offsetWidth-8)+'px';tip.style.top=(e.clientY+14)+'px'};
const hide=()=>tip.style.display='none';
const f2=v=>(v>=0?'+':'')+v.toFixed(1).replace('.',',');
const ms=d=>Date.parse(d+'T12:00:00Z');
function ticks(lo,hi,n=4){const sp=hi-lo||1;let st=Math.pow(10,Math.floor(Math.log10(sp/n)));for(const m of[1,2,5,10]){if(sp/(st*m)<=n){st*=m;break}}const o=[];for(let v=Math.ceil(lo/st)*st;v<=hi+1e-9;v+=st)o.push(v);return o}
function drawEq(svg){const D=JSON.parse(svg.dataset.c),W=560,H=190,L=46,R=14,T=10,B=24;const k=UNIT==='R'?1:parseFloat(UNIT);
 const all=[...D.new,...(D.base||[])].map(p=>p[1]);let lo=Math.min(0,...all),hi=Math.max(0,...all);const pad=(hi-lo)*.06||1;lo-=pad;hi+=pad;
 const x0=ms(D.from),x1=ms(D.to),X=d=>L+(W-L-R)*(ms(d)-x0)/(x1-x0),Y=v=>T+(H-T-B)*(hi-v)/(hi-lo);
 let s='';for(const v of ticks(lo,hi))s+=`<line class="gl" x1="${L}" x2="${W-R}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${L-6}" y="${Y(v)+4}" text-anchor="end">${(v>0?'+':'')+Math.round(v*k)}${UNIT==='R'?'R':' %'}</text>`;
 s+=`<line class="zero" x1="${L}" x2="${W-R}" y1="${Y(0)}" y2="${Y(0)}"/>`;
 const yrs=[];for(let y=+D.from.slice(0,4)+1;y<=+D.to.slice(0,4);y++)yrs.push(y+'-01-01');
 for(const d of yrs)s+=`<text class="ax" x="${X(d)}" y="${H-6}" text-anchor="middle">${d.slice(0,4)}</text><line class="gl" x1="${X(d)}" x2="${X(d)}" y1="${T}" y2="${H-B}"/>`;
 const pl=(P,c)=>`<polyline class="pl ${c}" points="${P.map(p=>X(p[0]).toFixed(1)+','+Y(p[1]).toFixed(1)).join(' ')}"/>`;
 if(D.base)s+=pl(D.base,'base');s+=pl(D.new,'new');
 const e=D.new[D.new.length-1];s+=`<text class="lab" x="${Math.min(X(e[0])-4,W-R-4)}" y="${Y(e[1])-7}" text-anchor="end">${f2(e[1]*k)}${UNIT==='R'?'R':' %'}</text>`;
 if(D.base){const b=D.base[D.base.length-1];s+=`<text class="ax" x="${X(b[0])-4}" y="${Y(b[1])+14}" text-anchor="end">${f2(b[1]*k)}${UNIT==='R'?'R':' %'}</text>`}
 s+=`<line class="cross" x1="0" x2="0" y1="${T}" y2="${H-B}" stroke="var(--t3)" visibility="hidden"/><circle class="dot" r="4" fill="var(--c1)" visibility="hidden"/>`;
 svg.innerHTML=s;const cr=svg.querySelector('.cross'),dt=svg.querySelector('.dot');
 svg.onmousemove=ev=>{const r=svg.getBoundingClientRect(),xx=(ev.clientX-r.left)*W/r.width;let i=0,bd=1e9;D.new.forEach((p,j)=>{const dd=Math.abs(X(p[0])-xx);if(dd<bd){bd=dd;i=j}});
  const p=D.new[i];cr.setAttribute('x1',X(p[0]));cr.setAttribute('x2',X(p[0]));cr.setAttribute('visibility','visible');dt.setAttribute('cx',X(p[0]));dt.setAttribute('cy',Y(p[1]));dt.setAttribute('visibility','visible');
  let t=`${p[0]} · Trade ${i+1}\nTestvariante: ${f2(p[1])}R = ${f2(p[1])} % bei 1 % bzw. ${f2(p[1]*0.5)} % bei 0,5 % Risiko`;
  if(D.base){let bb=null;for(const q of D.base){if(q[0]<=p[0])bb=q;else break}if(bb)t+=`\nbestehend: ${f2(bb[1])}R`}show(t,ev)};
 svg.onmouseleave=()=>{cr.setAttribute('visibility','hidden');dt.setAttribute('visibility','hidden');hide()}}
function drawAll(){document.querySelectorAll('svg.eq').forEach(drawEq)}
function drawRisk(){const F=FDATA,RS=RISKS,svg=document.getElementById('riskchart'),W=720,H=260,L=48,R=200,T=12,B=30,mode=document.querySelector('[data-rm][aria-pressed="true"]').dataset.rm;
 const key={pass:'pass',lost:'lost',pay:'pay'}[mode];const vals=Object.values(F).flatMap(s=>s[key]);const hi=mode==='pay'?Math.max(...vals)*1.08:1;
 const X=i=>L+(W-L-R)*i/(RS.length-1),Y=v=>T+(H-T-B)*(1-v/hi);let s='';
 for(const v of ticks(0,hi,4))s+=`<line class="gl" x1="${L}" x2="${W-R}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${L-6}" y="${Y(v)+4}" text-anchor="end">${mode==='pay'?Math.round(v).toLocaleString('de-DE')+' €':Math.round(v*100)+' %'}</text>`;
 RS.forEach((r,i)=>s+=`<text class="ax" x="${X(i)}" y="${H-10}" text-anchor="middle">${String(r).replace('.',',')} %</text>`);
 const cols=['var(--c1)','var(--c2)','var(--c3)','var(--c4)','var(--c5)'];const ends=[];
 Object.values(F).forEach((S,j)=>{const P=S[key].map((v,i)=>[X(i),Y(v)]);s+=`<polyline class="pl" style="stroke:${cols[j]}" points="${P.map(p=>p.join(',')).join(' ')}"/>`;
  P.forEach((p,i)=>s+=`<circle cx="${p[0]}" cy="${p[1]}" r="4.5" fill="${cols[j]}" class="dot" data-tip="${S.name} · ${String(RS[i]).replace('.',',')} % Risiko\nbestanden ${Math.round(S.pass[i]*100)} % · Median ${S.days[i]??'–'} Handelstage\nØ Auszahlung ${Math.round(S.pay[i]).toLocaleString('de-DE')} €/Monat · Konto verloren (12 M.) ${Math.round(S.lost[i]*100)} %"/>`);
  ends.push([P[P.length-1][1],S.name,cols[j]])});
 ends.sort((a,b)=>a[0]-b[0]);let last=-99;for(const e of ends){const y=Math.max(e[0],last+13);last=y;s+=`<text class="lab" x="${W-R+8}" y="${y+4}">${e[1]}</text>`}
 svg.innerHTML=s}
document.addEventListener('mousemove',e=>{const el=e.target.closest('[data-tip]');if(el)show(el.dataset.tip,e);else if(!e.target.closest('svg.eq'))hide()});
document.querySelectorAll('[data-unit]').forEach(b=>b.onclick=()=>{UNIT=b.dataset.unit;document.querySelectorAll('[data-unit]').forEach(x=>x.setAttribute('aria-pressed',x===b));drawAll()});
document.querySelectorAll('[data-ep]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-ep]').forEach(x=>x.setAttribute('aria-pressed',x===b));const ep=b.dataset.ep;
 document.querySelectorAll('[data-epic]').forEach(el=>el.classList.toggle('hidden',ep!=='all'&&el.dataset.epic!==ep&&el.dataset.epic!=='MIX'))});
document.querySelectorAll('[data-rm]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-rm]').forEach(x=>x.setAttribute('aria-pressed',x===b));drawRisk()});
drawAll();drawRisk();
'''

TEMPLATE = '''<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verbesserungen & FTMO – backtest-lab</title><style>{CSS}</style></head>
<body><div class="viz-root"><div class="wrap">
<h1>Verbesserte Varianten vom 04.11. & FTMO-Eignung</h1>
<p class="sub">{n_imp} von {n_all} heute getesteten Varianten sind besser als ihre bestehende Variante in d_ilikebigbots (Ø R gesamt <b>und</b> in beiden Kalenderhälften), {n_pos} davon absolut positiv.
Live-Code-Backtests mit Original-Code-Nodes, Daten bis 13.10.2026 · erstellt {now}. % = Kontoveränderung bei 1 % Risiko je Trade ohne Zinseszins (1R = 1 %).</p>
<div class="tiles">
 <div class="tile"><div class="kl">FTMO – Portfolio aus 3 Bots ({pf_risk} % je Trade)</div><div class="hero">{pf_pass}</div><div class="ks">bestehen beide Phasen · Median {pf_days} Handelstage (≈ {pf_mon} Monate) · Ø {pf_pay}/Monat funded · Konto verloren in 12 M.: {pf_lost}</div></div>
 <div class="tile"><div class="kl">FTMO – bester Einzelbot: NAS F618ATR L2/R1 + Extrem o. 15 Uhr ({n_risk} %)</div><div class="hero">{n_pass}</div><div class="ks">bestehen · Median {n_days} Handelstage (≈ {n_mon} Monate) · Ø {n_pay}/Monat · Kontoverlust 12 M.: {n_lost}</div></div>
 <div class="tile"><div class="kl">Größter Sprung</div><div class="hero">−0,05 → +0,33R</div><div class="ks">DE40 LVN Basis mit ADX ≥ 30, ohne Montag, LVN-Tiefe (Max-DD 56R → 10R)</div></div>
 <div class="tile"><div class="kl">Wichtig</div><div class="hero">In-Sample</div><div class="ks">Varianten wurden auf denselben Daten ausgewählt – FTMO-Zahlen sind eher zu optimistisch</div></div>
</div>
<div class="ctl"><b class="sm">Einheit</b><button data-unit="R" aria-pressed="true">R</button><button data-unit="1" aria-pressed="false">% bei 1 % Risiko</button><button data-unit="0.5" aria-pressed="false">% bei 0,5 % Risiko</button><span class="sep"></span>
<b class="sm">Markt</b><button data-ep="all" aria-pressed="true">Alle</button><button data-ep="US100" aria-pressed="false">NAS100</button><button data-ep="DE40" aria-pressed="false">DE40</button><button data-ep="EURUSD" aria-pressed="false">EURUSD</button></div>

<h2>1 · Übersicht der Verbesserungen</h2>
<div class="tw"><table><thead><tr><th>Testvariante / bestehende Variante</th><th class="num">Ø R je Trade</th><th class="num">Δ 1./2. Hälfte</th><th class="num">Trades</th><th class="num">R / Monat</th><th class="num">% / Monat (1 %)</th><th class="num">p</th>
<th class="num">FTMO-Risiko</th><th class="num">bestanden</th><th class="num">Dauer (Handelstage)</th><th class="num">Ø Auszahlung / Monat</th><th class="num">Konto weg (12 M.)</th></tr></thead><tbody>{trs}</tbody></table></div>
<p class="sub sm">FTMO-Spalten: höchstes Risiko je Trade, bei dem in der Simulation höchstens 10 % der Funded-Konten innerhalb von 12 Monaten verloren gehen und höchstens 15 % der Challenges scheitern. Auszahlung = Ø über alle Simulationen inkl. verlorener Konten, 80 % Gewinnanteil, 100k.</p>

<h2>2 · FTMO: Risiko je Trade gegen Bestehen, Auszahlung und Kontoverlust</h2>
<div class="box"><div class="ctl" style="position:static;border:0;padding:0 0 6px"><button data-rm="pass" aria-pressed="true">Challenge bestanden</button><button data-rm="pay" aria-pressed="false">Ø Auszahlung / Monat</button><button data-rm="lost" aria-pressed="false">Funded-Konto verloren (12 M.)</button></div>
<svg id="riskchart" viewBox="0 0 720 260" style="width:100%;max-width:900px;height:auto" role="img" aria-label="FTMO-Kennzahlen nach Risiko"></svg></div>
<div class="tw"><table><thead><tr><th>Kandidat</th><th class="num">Risiko/Trade</th><th class="num">bestanden</th><th class="num">gescheitert</th><th class="num">Handelstage Median / 25–75 %</th><th class="num">Ø Auszahlung/Monat</th><th class="num">schlechtes 10 %-Szenario</th><th class="num">Konto weg (12 M.)</th></tr></thead><tbody>{ft}</tbody></table></div>
<p class="sub sm">Hervorgehoben = gewählte Risikostufe. „Handelstage“ = Börsentage für Phase 1 + Phase 2 zusammen (21 ≈ 1 Monat). „Schlechtes 10 %-Szenario“: 10 % der Simulationen zahlen im Schnitt weniger als diesen Betrag pro Monat aus.</p>

<h2>3 · Kapitalkurven: Testvariante gegen bestehende Variante</h2>
<div class="grid2">{cards}</div>

<h2>4 · Annahmen & Vorbehalte</h2>
<div class="box"><ul>
<li><b>FTMO-Regeln (angenommen, 2-Step):</b> Phase 1 +10 %, Phase 2 +5 %, max. Tagesverlust 5 %, max. Gesamtverlust 10 % (vom Start), mind. 4 Handelstage, kein Zeitlimit (Abbruch nach 250 Handelstagen). Funded: 80 % Gewinnanteil, monatliche Auszahlung, Konto danach wieder 100k. <b>Vor einem Kauf mit den aktuellen FTMO-Bedingungen abgleichen.</b></li>
<li><b>Simulation:</b> 4000 Durchläufe je Stufe; zufällig gezogene echte Backtest-Handelstage (alle Trades eines Tages zusammen, Tage ohne Trade im echten Verhältnis); Tagesverlust nur aus geschlossenen Trades (offene Verluste nicht geprüft).</li>
<li><b>Überoptimistisch:</b> Die Varianten wurden auf denselben Daten gefunden und ausgewählt (In-Sample). Erwartete Werte im Forward-Test eher niedriger.</li>
<li><b>Kurse:</b> Capital.com-Daten. FTMO handelt über eigene Kurse/cTrader – Spreads, Kommissionen und Swaps weichen ab und sind nicht enthalten.</li>
<li><b>Portfolio:</b> F618ATR L2/R1 + Extrem o. 15 Uhr + DE40 LVN Basis-mf + EURUSD C4 o. Mi/Fr/ADX auf einem Konto, Zeitraum 09/2024–10/2026; gleichzeitige Positionen teilen das Tageslimit.</li>
<li>Die Zahlen sind eine Auswertung deiner Backtests, keine Anlageempfehlung.</li>
</ul></div>
</div><div id="tip" role="tooltip"></div></div>
<script>const FDATA={fdata};const RISKS={risks};{JS}</script></body></html>'''

if __name__ == '__main__' and os.environ.get('FTMO_HTML'):
    rows, cand, sims = run_all()
    with open(os.path.join(OUT, 'ftmo-dashboard.html'), 'w') as f: f.write(render(rows, cand, sims))
    print('geschrieben', os.path.join(OUT, 'ftmo-dashboard.html'))
