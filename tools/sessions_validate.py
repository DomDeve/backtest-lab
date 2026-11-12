#!/usr/bin/env python3
"""Validierung der Session-Tabelle (config/sessions.yaml) gegen die Capital-M5-Kursdaten.

Aufruf:  python3 tools/sessions_validate.py [--months 12]
Ausgabe: out/sessions/validierung.html + validierung.json, out/sessions/ausgeschlossen.md,
         config/sessions_no_trading_days.json (Tage mit Volumen < 30 % des Durchschnitts der Hauptsession).

Je Epic mit Kursdaten und je Session:
  - Ø Tick-Volumen und Ø Kerzenrange (Mitte, M5) je 5-Minuten-Slot in Börsen-Ortszeit (zoneinfo), letzte N Monate,
    nur Handelstage der Referenzbörse.
  - Sprung = Anstieg Slot k gegenüber dem Mittel der 3 Slots davor (Verhältnis). Gesucht wird der größte Sprung im
    Fenster ±3 h um die eingetragene Eröffnung (ein CFD handelt fast rund um die Uhr; über den ganzen Tag wäre z. B.
    beim DAX die US-Eröffnung der größte Sprung). Der Tageshöchstwert wird zusätzlich ausgewiesen.
  - OK: Volumen- UND Range-Sprung innerhalb ±15 min der Eröffnung. Abweichung: klarer Sprung (Verhältnis ≥ 1,5)
    außerhalb. Keine klare Eröffnung: kein Sprung ≥ 1,5 im Fenster.
  - Abdeckung durch die CFD-Handelszeiten: aus der API (out/sessions/capital_hours.json, tools/capital_hours.py),
    falls vorhanden; sonst aus den Kursdaten (Anteil der Session-Slots mit Kerze an Handelstagen).
"""
import os, sys, csv, glob, json, html, datetime, statistics
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sessions as S

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out', 'sessions')
MONTHS = int(sys.argv[sys.argv.index('--months') + 1]) if '--months' in sys.argv else 12
UTC = datetime.timezone.utc
TOL_MIN, WIN_MIN, MIN_JUMP, LOW_VOL = 15, 180, 1.5, 0.30

def pick(r, *names):
    for n in names:
        if r.get(n) not in (None, ''): return float(r[n])
    return None

def load_bars(folder):
    bars = {}
    for f in sorted(glob.glob(os.path.join(ROOT, folder, 'capital_*_MINUTE_5_*.csv'))):
        with open(f, newline='') as fh:
            for r in csv.DictReader(fh):
                t = datetime.datetime.fromisoformat(r['timestamp'].replace('Z', '+00:00'))
                if t.tzinfo is None: t = t.replace(tzinfo=UTC)
                bh, bl = pick(r, 'bid_high', 'highBid'), pick(r, 'bid_low', 'lowBid')
                ah, al = pick(r, 'ask_high', 'highAsk'), pick(r, 'ask_low', 'lowAsk')
                if None in (bh, bl, ah, al): continue
                bars[t] = (((bh + ah) - (bl + al)) / 2, pick(r, 'volume', 'lastTradedVolume') or 0.0)
    return bars

def hm(mins): return '%02d:%02d' % (mins // 60 % 24, mins % 60)

def profile(bars, epic, sess, t_from):
    """Ø Volumen / Ø Range je Slot (Minuten seit Mitternacht Ortszeit) über Handelstage; Tagesvolumen der Session."""
    tz = ZoneInfo(sess['tz'])
    vol, rng, days = {}, {}, set()
    o = datetime.time.fromisoformat(sess['open_local']); c = datetime.time.fromisoformat(sess['close_local'])
    sess_vol = {}; td = {}
    for t, (r, v) in bars.items():
        if t < t_from: continue
        lt = t.astimezone(tz); d = lt.date()
        if d not in td: td[d] = S.is_trading_day(epic, d, volume_rule=False)  # Volumenregel wird hier erst berechnet
        if not td[d]: continue
        k = lt.hour * 60 + lt.minute
        vol.setdefault(k, []).append(v); rng.setdefault(k, []).append(r); days.add(d)
        if o <= lt.time() < c: sess_vol[d] = sess_vol.get(d, 0) + v
    mv = {k: statistics.mean(x) for k, x in vol.items()}
    mr = {k: statistics.mean(x) for k, x in rng.items()}
    cnt = {k: len(x) for k, x in vol.items()}
    return mv, mr, cnt, sorted(days), sess_vol

def jumps(m):
    """Verhältnis Slot k / Mittel der 3 Slots davor (zirkulär über Mitternacht)."""
    out = {}
    for k in range(0, 1440, 5):
        prev = [m.get((k - 5 * j) % 1440) for j in (1, 2, 3)]
        prev = [p for p in prev if p]
        if k in m and prev and statistics.mean(prev) > 0: out[k] = m[k] / statistics.mean(prev)
    return out

def best(j, center, win):
    cand = {k: v for k, v in j.items() if abs(((k - center + 720) % 1440) - 720) <= win}
    return max(cand.items(), key=lambda kv: kv[1]) if cand else (None, None)

def dist(a, b): return abs(((a - b + 720) % 1440) - 720)

def svg(mv, mr, open_k, found, title):
    W, H, P = 760, 220, 34
    ks = list(range(0, 1440, 5))
    vmax = max(mv.values() or [1]); rmax = max(mr.values() or [1])
    x = lambda k: P + (W - 2 * P) * k / 1435
    def path(m, mx): return ' '.join(('M' if i == 0 else 'L') + '%.1f,%.1f' % (x(k), H - P - (H - 2 * P) * (m.get(k, 0) / mx)) for i, k in enumerate(ks))
    ticks = ''.join(f'<line x1="{x(h*60):.1f}" x2="{x(h*60):.1f}" y1="{H-P}" y2="{H-P+4}" stroke="#999"/><text x="{x(h*60):.1f}" y="{H-P+16}" font-size="10" text-anchor="middle" fill="#666">{h:02d}</text>' for h in range(0, 24, 2))
    marks = f'<line x1="{x(open_k):.1f}" x2="{x(open_k):.1f}" y1="{P-6}" y2="{H-P}" stroke="#2a7" stroke-dasharray="4 3"/><text x="{x(open_k)+3:.1f}" y="{P-8}" font-size="10" fill="#2a7">Eröffnung laut Tabelle {hm(open_k)}</text>'
    for lab, k, col, dy in found:
        if k is not None: marks += f'<line x1="{x(k):.1f}" x2="{x(k):.1f}" y1="{P}" y2="{H-P}" stroke="{col}" stroke-width="1.5"/><text x="{x(k)+3:.1f}" y="{P+dy}" font-size="10" fill="{col}">{lab} {hm(k)}</text>'
    return (f'<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="{html.escape(title)}"><rect x="0" y="0" width="{W}" height="{H}" fill="none"/>'
            f'<path d="{path(mv, vmax)}" fill="none" stroke="#3b6fd8" stroke-width="1.5"/><path d="{path(mr, rmax)}" fill="none" stroke="#e08a1e" stroke-width="1.5"/>'
            f'<line x1="{P}" x2="{W-P}" y1="{H-P}" y2="{H-P}" stroke="#999"/>{ticks}{marks}'
            f'<text x="{P}" y="14" font-size="11" fill="#3b6fd8">Ø Tick-Volumen</text><text x="{P+100}" y="14" font-size="11" fill="#e08a1e">Ø Range (M5)</text>'
            f'<text x="{W-P}" y="14" font-size="11" text-anchor="end" fill="#666">Uhrzeit {html.escape(title)}</text></svg>')

def capital_cover(epic):
    p = os.path.join(OUT, 'capital_hours.json')
    if not os.path.exists(p): return None
    return json.load(open(p)).get('epics', {}).get(epic)

def main():
    Tab = S.load(); res = {}; ntd = {}
    for epic, e in Tab['epics'].items():
        folder = next((d for d in (e.get('data'), 'data/raw/' + epic.lower()) if d and glob.glob(os.path.join(ROOT, d, 'capital_*_MINUTE_5_*.csv'))), None)
        if not folder:
            res[epic] = dict(status='ungeprüft', reason='keine Kursdaten im Lab', sessions={}); continue
        bars = load_bars(folder)
        t_end = max(bars); t_from = t_end - datetime.timedelta(days=round(MONTHS * 30.44))
        er = dict(period=[t_from.date().isoformat(), t_end.date().isoformat()], bars=len(bars), sessions={})
        for i, (name, s) in enumerate(e['sessions'].items()):
            mv, mr, cnt, days, sess_vol = profile(bars, epic, s, t_from)
            ok = datetime.time.fromisoformat(s['open_local']); open_k = ok.hour * 60 + ok.minute
            ck = datetime.time.fromisoformat(s['close_local']); close_k = ck.hour * 60 + ck.minute
            jv, jr = jumps(mv), jumps(mr)
            kv, rv = best(jv, open_k, WIN_MIN); kr, rr = best(jr, open_k, WIN_MIN)
            gv = max(jv.items(), key=lambda kv_: kv_[1]); gr = max(jr.items(), key=lambda kv_: kv_[1])
            clear = (rv or 0) >= MIN_JUMP and (rr or 0) >= MIN_JUMP
            hit = kv is not None and kr is not None and dist(kv, open_k) <= TOL_MIN and dist(kr, open_k) <= TOL_MIN
            status = 'OK' if clear and hit else ('Abweichung' if clear or (rv or 0) >= MIN_JUMP or (rr or 0) >= MIN_JUMP else 'keine klare Eröffnung')
            if status == 'Abweichung' and hit: status = 'OK'
            # Abdeckung der Session durch die CFD-Handelszeiten
            slots = [k for k in range(open_k, close_k, 5)]
            nd = len(days)
            cov_slots = [k for k in slots if cnt.get(k, 0) >= 0.95 * nd]
            api = capital_cover(epic)
            cover = dict(source='API (capital_hours.json)', **api) if api else dict(source='Kursdaten', handelstage=nd,
                         slots=len(slots), abgedeckt=len(cov_slots), voll=len(cov_slots) == len(slots),
                         luecken=[hm(k) for k in slots if k not in cov_slots][:12])
            # Feiertage nach Volumen (nur Hauptsession)
            low = []
            if i == 0 and sess_vol:
                avg = statistics.mean(sess_vol.values())
                low = sorted(str(d) for d, v in sess_vol.items() if v < LOW_VOL * avg)
                ntd[epic] = low
            er['sessions'][name] = dict(open=s['open_local'], close=s['close_local'], tz=s['tz'], status=status,
                                        jump_vol=[hm(kv), round(rv, 2)] if kv is not None else None, jump_range=[hm(kr), round(rr, 2)] if kr is not None else None,
                                        day_max_vol=[hm(gv[0]), round(gv[1], 2)], day_max_range=[hm(gr[0]), round(gr[1], 2)],
                                        cover=cover, low_volume_days=low, days=nd,
                                        svg=svg(mv, mr, open_k, [('Volumen-Sprung', kv, '#3b6fd8', 12), ('Range-Sprung', kr, '#e08a1e', 26)], f"{s['tz']}"))
        st = [x['status'] for x in er['sessions'].values()]
        er['status'] = 'OK' if all(x == 'OK' for x in st) else ('Abweichung' if 'Abweichung' in st else 'keine klare Eröffnung')
        res[epic] = er
    os.makedirs(OUT, exist_ok=True)
    json.dump(ntd, open(os.path.join(ROOT, 'config', 'sessions_no_trading_days.json'), 'w'), indent=1)
    slim = {k: dict(v, sessions={n: {kk: vv for kk, vv in s.items() if kk != 'svg'} for n, s in v.get('sessions', {}).items()}) for k, v in res.items()}
    json.dump(dict(created=datetime.datetime.now().isoformat(timespec='seconds'), months=MONTHS, tol_min=TOL_MIN, epics=slim), open(os.path.join(OUT, 'validierung.json'), 'w'), indent=1, ensure_ascii=False)
    report(Tab, res)
    for k, v in res.items():
        print(f"{k:10s} {v['status']:22s}" + '  '.join(f"{n}: {s['status']} Vol {s['jump_vol']} Range {s['jump_range']} (Tag-Max Vol {s['day_max_vol']}) Abdeckung {s['cover'].get('abgedeckt', '?')}/{s['cover'].get('slots', '?')} Feiertage(Vol) {len(s['low_volume_days'])}" for n, s in v.get('sessions', {}).items()))

def report(Tab, res):
    esc = html.escape
    rows, figs = '', ''
    for k, e in Tab['epics'].items():
        r = res[k]
        cls = {'OK': 'ok', 'Abweichung': 'dev', 'keine klare Eröffnung': 'dev'}.get(r['status'], 'na')
        sess = '<br>'.join(f"{esc(n)} {s['open_local']}–{s['close_local']} {esc(s['tz'])}" for n, s in e['sessions'].items())
        det = ''
        for n, s in r.get('sessions', {}).items():
            c = s['cover']
            cov = (f"API: {esc(json.dumps(c))}" if c['source'].startswith('API') else
                   f"Kursdaten: {c['abgedeckt']}/{c['slots']} Slots an ≥ 95 % der {c['handelstage']} Handelstage" + ('' if c['voll'] else f" – Lücken {', '.join(c['luecken'])}"))
            det += (f"<div><b>{esc(n)}</b>: {s['status']} · Volumen-Sprung {s['jump_vol'][0]} (×{s['jump_vol'][1]}) · Range-Sprung {s['jump_range'][0]} (×{s['jump_range'][1]})"
                    f" · größter Sprung des Tages: Vol {s['day_max_vol'][0]}, Range {s['day_max_range'][0]}<br><span class=sm>{cov}. Tage mit Volumen &lt; 30 %: {len(s['low_volume_days'])}"
                    f"{(' (' + ', '.join(s['low_volume_days'][:8]) + (' …' if len(s['low_volume_days']) > 8 else '') + ')') if s['low_volume_days'] else ''}</span></div>")
            figs += f"<h3>{esc(k)} – {esc(n)} ({s['status']})</h3>{s['svg']}"
        if not r.get('sessions'): det = esc(r.get('reason', ''))
        orb = ('nur ' + ', '.join(e['orb_vwap_sessions']) if e.get('orb_vwap_sessions') else 'ja') if e.get('orb_vwap') else 'nein – ' + esc(e.get('exclude_reason', ''))
        rows += (f"<tr><td><b>{esc(k)}</b><div class=sm>{esc(e.get('name', ''))}</div></td><td>{esc(e['asset_class'])}</td><td>{esc(e['reference_exchange'])}<div class=sm>Kalender {esc(e['calendar'])}</div></td>"
                 f"<td>{sess}</td><td class={cls}>{esc(r['status'])}</td><td>{det}</td><td>{orb}</td></tr>")
    H = f'''<!DOCTYPE html><html lang=de><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Session-Zeiten – Validierung</title>
<style>body{{font:14px -apple-system,system-ui,sans-serif;margin:24px;max-width:1250px;color:#222}}table{{border-collapse:collapse;width:100%}}td,th{{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}}
.ok{{color:#18794e;font-weight:700}}.dev{{color:#b42318;font-weight:700}}.na{{color:#777}}.sm{{font-size:12px;color:#666}}h3{{margin:22px 0 4px}}.box{{background:#f6f7f9;border-radius:8px;padding:10px 14px}}</style></head><body>
<h1>Session-Zeiten – Validierung gegen Capital-M5-Kurse</h1>
<p class=sm>Quelle: config/sessions.yaml · letzte {MONTHS} Monate · Uhrzeiten in Börsen-Ortszeit (zoneinfo) · erstellt {datetime.date.today():%d.%m.%Y}</p>
<div class=box><b>Regel:</b> Sprung = Ø-Wert eines 5-Min-Slots geteilt durch das Mittel der 3 Slots davor. Gesucht wird der größte Sprung im Fenster ±3 h um die
eingetragene Eröffnung. <b>OK</b> = Volumen- und Range-Sprung liegen innerhalb ±{TOL_MIN} min · <b>Abweichung</b> = klarer Sprung (≥ ×{MIN_JUMP}) außerhalb ·
<b>keine klare Eröffnung</b> = kein Sprung ≥ ×{MIN_JUMP}. Kursdaten liegen nur für DE40, US100 und EURUSD vor; alle anderen Epics sind ungeprüft.
Abdeckung durch CFD-Handelszeiten: API-Abfrage (tools/capital_hours.py) noch nicht gelaufen – bis dahin aus den Kursdaten.</div>
<table><thead><tr><th>Epic</th><th>Klasse</th><th>Referenzbörse</th><th>Session(s)</th><th>Status</th><th>Befund</th><th>ORB/VWAP</th></tr></thead><tbody>{rows}</tbody></table>
<h2>Uhrzeit-Profile</h2><p class=sm>Blau Ø Tick-Volumen, orange Ø Range, beide auf ihr Maximum normiert; grün gestrichelt die Eröffnung laut Tabelle.</p>{figs}</body></html>'''
    open(os.path.join(OUT, 'validierung.html'), 'w').write(H)
    ex = ['# Für ORB/VWAP ausgeschlossene Epics', '', f'Stand {datetime.date.today():%d.%m.%Y}, Quelle config/sessions.yaml + tools/sessions_validate.py.', '',
          '| Epic | Grund |', '|---|---|']
    for k, e in Tab['epics'].items():
        r = res[k]
        if not e.get('orb_vwap'): ex.append(f"| {k} | {e.get('exclude_reason')} |")
        elif r['status'] in ('Abweichung', 'keine klare Eröffnung'):
            allowed = e.get('orb_vwap_sessions') or list(e['sessions'])
            for n, sr in r['sessions'].items():
                if sr['status'] != 'OK' or n not in allowed:
                    ex.append(f"| {k} (Session {n}) | Validierung: {sr['status']} – Volumen-Sprung {sr['jump_vol'][0]}, Range-Sprung {sr['jump_range'][0]} {sr['tz']} |")
    ex += ['', 'Nicht ausgeschlossen, aber **ungeprüft** (keine Kursdaten im Lab): ' + ', '.join(k for k, e in Tab['epics'].items() if e.get('orb_vwap') and res[k]['status'] == 'ungeprüft') + '.',
           'Aktien-CFDs ohne erkennbare Heimatbörse (stock_home() = None) gelten als „unbekannt“ und sind ebenfalls ausgeschlossen.']
    open(os.path.join(OUT, 'ausgeschlossen.md'), 'w').write('\n'.join(ex) + '\n')

if __name__ == '__main__':
    main()
