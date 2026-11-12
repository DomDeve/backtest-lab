#!/usr/bin/env python3
"""Schritt 2: CFD-Handelszeiten je Epic von der Capital.com-API (GET /api/v1/markets/{epic}) holen und cachen.

Aufruf (Zugangsdaten nur über Umgebungsvariablen, nie im Code oder in Dateien):
  CAPITAL_API_KEY=… CAPITAL_IDENTIFIER=… CAPITAL_PASSWORD=… python3 tools/capital_hours.py [--force] [--demo] [EPIC …]
Ohne EPIC: alle Epics aus config/sessions.yaml. Cache: out/sessions/capital_hours.json (wird nur erneuert, wenn älter als
30 Tage oder --force). Rohantwort des ersten Aufrufs je Epic: out/sessions/capital_raw/<EPIC>.json (zur Strukturprüfung).

Erwartete Struktur (laut Capital-API-Doku, beim ersten Lauf an der Rohantwort prüfen):
  instrument.openingHours = { "mon": ["00:00 - 21:00", "22:05 - 00:00"], …, "sun": [...], "zone": "UTC" }
Ergebnis je Epic: Öffnungszeiten je Wochentag + Zone und je Session aus sessions.yaml, ob sie an jedem Wochentag der
nächsten 7 Tage vollständig in einem Öffnungsintervall liegt (DST-sicher über zoneinfo).
"""
import os, sys, json, datetime, urllib.request
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sessions as S

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out', 'sessions')
CACHE = os.path.join(OUT, 'capital_hours.json')
DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
MAX_AGE_DAYS = 30

def api(base, path, headers, body=None):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body else None, method='POST' if body else 'GET',
                                 headers={'Content-Type': 'application/json', **headers})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r), dict(r.headers)

def login(base):
    key, ident, pw = (os.environ.get(k) for k in ('CAPITAL_API_KEY', 'CAPITAL_IDENTIFIER', 'CAPITAL_PASSWORD'))
    if not (key and ident and pw): sys.exit('Bitte CAPITAL_API_KEY, CAPITAL_IDENTIFIER und CAPITAL_PASSWORD als Umgebungsvariablen setzen.')
    if any(v.strip() in ('…', '...') or not v.isascii() for v in (key, ident, pw)): sys.exit('Zugangsdaten enthalten noch den Platzhalter „…“ bzw. Nicht-ASCII-Zeichen – bitte die echten Werte einsetzen.')
    _, h = api(base, '/api/v1/session', {'X-CAP-API-KEY': key}, {'identifier': ident, 'password': pw})
    return {'X-CAP-API-KEY': key, 'CST': h.get('CST') or h.get('cst'), 'X-SECURITY-TOKEN': h.get('X-SECURITY-TOKEN') or h.get('x-security-token')}

def parse_hours(oh):
    """openingHours -> {zone, days: {mon: [(start_min, end_min), …]}}; '00:00' als Ende = 1440."""
    if not isinstance(oh, dict): return None
    zone = oh.get('zone') or oh.get('timezone') or 'UTC'
    days = {}
    for d in DAYS:
        iv = []
        for s in oh.get(d) or []:
            a, b = [x.strip() for x in str(s).split('-')]
            ta = int(a[:2]) * 60 + int(a[3:5]); tb = int(b[:2]) * 60 + int(b[3:5])
            iv.append((ta, 1440 if tb == 0 else tb))
        days[d] = iv
    return dict(zone=zone, days=days)

def covered(hours, epic, sess, ref=None):
    """Liegt die Session an jedem Wochentag (Mo–Fr) der Woche ab ref vollständig in einem Öffnungsintervall?"""
    ref = ref or datetime.date.today()
    tz = ZoneInfo(hours['zone']); out = {}
    for k in range(7):
        d = ref + datetime.timedelta(days=k)
        if d.weekday() >= 5: continue
        w = S.session_utc(epic, d, sess, any_day=True)
        o, c = w[0].astimezone(tz), (w[1] - datetime.timedelta(minutes=1)).astimezone(tz)
        def inside(t):
            m = t.hour * 60 + t.minute
            return any(a <= m < b for a, b in hours['days'][DAYS[t.weekday()]])
        # jede Minute der Session muss offen sein (Pausen im CFD-Handel würden sonst übersehen)
        t, ok = o, True
        while t <= c and ok:
            ok = inside(t); t += datetime.timedelta(minutes=5)
        out[DAYS[d.weekday()]] = ok and inside(c)
    return out

def main():
    force = '--force' in sys.argv
    base = 'https://demo-api-capital.backend-capital.com' if '--demo' in sys.argv else 'https://api-capital.backend-capital.com'
    T = S.load(); epics = [a for a in sys.argv[1:] if not a.startswith('--')] or list(T['epics'])
    os.makedirs(os.path.join(OUT, 'capital_raw'), exist_ok=True)
    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {'epics': {}}
    age = (datetime.date.today() - datetime.date.fromisoformat(cache.get('fetched', '2000-01-01'))).days
    if age < MAX_AGE_DAYS and not force and all(e in cache['epics'] for e in epics):
        print(f'Cache {age} Tage alt – nichts zu tun (--force erzwingt neuen Abruf).'); return
    hdr = login(base)
    for epic in epics:
        try:
            m, _ = api(base, f'/api/v1/markets/{epic}', hdr)
        except Exception as ex:
            cache['epics'][epic] = dict(error=str(ex)); print(epic, 'FEHLER', ex); continue
        raw_p = os.path.join(OUT, 'capital_raw', f'{epic}.json')
        if not os.path.exists(raw_p): json.dump(m, open(raw_p, 'w'), indent=1)
        inst = m.get('instrument') or {}
        hours = parse_hours(inst.get('openingHours'))
        if not hours:
            cache['epics'][epic] = dict(error='instrument.openingHours fehlt – Struktur in capital_raw prüfen', keys=sorted(inst)); print(epic, 'ohne openingHours, Felder:', sorted(inst)); continue
        cov = {name: covered(hours, epic, name) for name in T['epics'][epic]['sessions']}
        cache['epics'][epic] = dict(name=inst.get('name'), type=inst.get('type'), currency=inst.get('currency'), zone=hours['zone'],
                                    hours={d: ['%02d:%02d-%02d:%02d' % (a // 60, a % 60, b // 60 % 24, b % 60) for a, b in iv] for d, iv in hours['days'].items()},
                                    cover=cov, voll=all(all(v.values()) for v in cov.values()))
        print(f"{epic:10s} {hours['zone']:5s} Abdeckung {'voll' if cache['epics'][epic]['voll'] else 'LÜCKEN ' + json.dumps(cov)}")
    cache['fetched'] = datetime.date.today().isoformat()
    json.dump(cache, open(CACHE, 'w'), indent=1, ensure_ascii=False)
    print('Cache ->', CACHE)

if __name__ == '__main__':
    main()
