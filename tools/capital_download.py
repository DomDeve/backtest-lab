#!/usr/bin/env python3
"""Kerzen von der Capital.com-API laden (GET /api/v1/prices/{epic}, max. 1000 Kerzen je Abruf -> Paging).

Zugangsdaten NUR über Umgebungsvariablen (werden nirgends gespeichert):
  CAPITAL_API_KEY=… CAPITAL_IDENTIFIER=… CAPITAL_PASSWORD=… python3 tools/capital_download.py [Optionen] [EPIC …]

Optionen:
  --months 36          Zeitraum rückwärts ab heute (Standard 36; Capital liefert M5 erfahrungsgemäß erst ab ca. 01/2024)
  --res MINUTE_5       Auflösung (mehrfach möglich, z. B. --res MINUTE_5 --res MINUTE_15). M15/H1/H4 baut das Lab aus M5
                       (geprüft identisch) – M15 nur laden, wenn ausdrücklich gewünscht.
  --demo               Demo-API statt Live-API
  --list               nur Epics prüfen (GET /markets/{epic}), nichts laden
Ohne EPIC: alle Epics aus config/sessions.yaml, für die noch keine Kursdaten unter data/raw/<epic> liegen.

Ausgabe: data/raw/<epic klein>/capital_<EPIC>_<RES>_<von>_to_<bis>.csv im Lab-Format
(timestamp,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close,volume). Zwischenstände je Abschnitt in
data/raw/<epic>/.parts/ – ein abgebrochener Lauf setzt dort fort. Rohantwort des ersten Abrufs: out/sessions/capital_raw/.
"""
import os, sys, json, time, glob, datetime, urllib.request, urllib.parse, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sessions as S

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STEP_MIN = {'MINUTE': 1, 'MINUTE_5': 5, 'MINUTE_15': 15, 'MINUTE_30': 30, 'HOUR': 60, 'HOUR_4': 240}
UTC = datetime.timezone.utc

def arg(name, default=None, multi=False):
    vals = [sys.argv[i + 1] for i, a in enumerate(sys.argv[:-1]) if a == name]
    return vals if multi else (vals[-1] if vals else default)

class Api:
    def __init__(self, demo):
        self.base = 'https://demo-api-capital.backend-capital.com' if demo else 'https://api-capital.backend-capital.com'
        self.login()

    def login(self):
        key, ident, pw = (os.environ.get(k) for k in ('CAPITAL_API_KEY', 'CAPITAL_IDENTIFIER', 'CAPITAL_PASSWORD'))
        if not (key and ident and pw): sys.exit('Bitte CAPITAL_API_KEY, CAPITAL_IDENTIFIER und CAPITAL_PASSWORD als Umgebungsvariablen setzen.')
        if any(v.strip() in ('…', '...', 'DEIN_API_KEY', 'DEINE_LOGIN_EMAIL', 'DEIN_API_PASSWORT', 'abc123DEINKEY', 'deine@email.de', 'dein-api-passwort') or not v.isascii() for v in (key, ident, pw)): sys.exit('Zugangsdaten enthalten noch den Platzhalter „…“ bzw. Nicht-ASCII-Zeichen – bitte die echten Werte einsetzen.')
        req = urllib.request.Request(self.base + '/api/v1/session', data=json.dumps({'identifier': ident, 'password': pw}).encode(),
                                     method='POST', headers={'Content-Type': 'application/json', 'X-CAP-API-KEY': key})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                h = {k.lower(): v for k, v in r.headers.items()}
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors='replace')[:200]
            hint = {401: 'Anmeldung abgelehnt – API-Key, Login-E-Mail oder API-Passwort falsch (bzw. Demo-Key ohne --demo oder umgekehrt).',
                    429: 'Zu viele Anmeldeversuche – ein paar Minuten warten.'}.get(e.code, 'Anmeldung fehlgeschlagen.')
            sys.exit(f'HTTP {e.code}: {hint} Antwort: {body}')
        self.h = {'X-CAP-API-KEY': key, 'CST': h['cst'], 'X-SECURITY-TOKEN': h['x-security-token']}
        self.t_login = time.time()

    def get(self, path, params=None, tries=5):
        url = self.base + path + ('?' + urllib.parse.urlencode(params) if params else '')
        for k in range(tries):
            if time.time() - self.t_login > 480: self.login()  # Session läuft nach 10 min Inaktivität ab
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=self.h), timeout=30) as r:
                    time.sleep(0.12)  # < 10 Abrufe/s
                    return json.load(r)
            except urllib.error.HTTPError as e:
                body = e.read().decode(errors='replace')[:300]
                if e.code == 401: self.login(); continue
                if e.code == 404 or 'error.prices.not-found' in body or 'invalid.from' in body: return {'_error': e.code, '_body': body}
                if e.code == 429 or e.code >= 500: time.sleep(2 * (k + 1)); continue
                return {'_error': e.code, '_body': body}
            except Exception as ex:
                time.sleep(2 * (k + 1)); last = ex
        return {'_error': 'timeout', '_body': str(last) if 'last' in dir() else ''}

def fmt(t): return t.strftime('%Y-%m-%dT%H:%M:%S')

def download(api, epic, res, start, end):
    folder = os.path.join(ROOT, 'data', 'raw', epic.lower()); parts = os.path.join(folder, '.parts', res)
    os.makedirs(parts, exist_ok=True)
    step = datetime.timedelta(minutes=STEP_MIN[res] * 1000)
    t, n_req, empty_run, rows = start, 0, 0, {}
    first_ok = None
    while t < end:
        t2 = min(t + step, end)
        pf = os.path.join(parts, t.strftime('%Y%m%d%H%M') + '.json')
        if os.path.exists(pf): data = json.load(open(pf))
        else:
            data = api.get(f'/api/v1/prices/{epic}', {'resolution': res, 'max': 1000, 'from': fmt(t), 'to': fmt(t2)}); n_req += 1
            if '_error' not in data: json.dump(data, open(pf, 'w'))
            raw = os.path.join(ROOT, 'out', 'sessions', 'capital_raw', f'{epic}_prices.json')
            if '_error' not in data and not os.path.exists(raw):
                os.makedirs(os.path.dirname(raw), exist_ok=True); json.dump({k: (v[:2] if k == 'prices' else v) for k, v in data.items()}, open(raw, 'w'), indent=1)
        P = data.get('prices') or []
        if P: empty_run = 0; first_ok = first_ok or P[0]['snapshotTimeUTC']
        else: empty_run += 1
        for p in P:
            g = lambda f, s: (p.get(f) or {}).get(s)
            rows[p['snapshotTimeUTC']] = [g('openPrice', 'bid'), g('highPrice', 'bid'), g('lowPrice', 'bid'), g('closePrice', 'bid'),
                                          g('openPrice', 'ask'), g('highPrice', 'ask'), g('lowPrice', 'ask'), g('closePrice', 'ask'), p.get('lastTradedVolume', 0)]
        t = t2
        if n_req and n_req % 50 == 0: print(f'   {epic} {res}: {t:%Y-%m-%d} ({len(rows)} Kerzen)', flush=True)
    if not rows: print(f'   {epic} {res}: keine Kerzen erhalten'); return None
    keys = sorted(rows); a, b = keys[0][:10], keys[-1][:10]
    out = os.path.join(folder, f'capital_{epic}_{res}_{a}_to_{b}.csv')
    with open(out, 'w') as fh:
        fh.write('timestamp,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close,volume\n')
        for k in keys:
            v = rows[k]
            if None in v[:8]: continue
            fh.write(k[:19] + 'Z,' + ','.join(str(x) for x in v) + '\n')
    print(f'   -> {os.path.relpath(out, ROOT)}: {len(keys)} Kerzen {a} → {b}, {n_req} Abrufe')
    return out

def main():
    T = S.load()
    epics = [a for a in sys.argv[1:] if not a.startswith('--') and sys.argv[sys.argv.index(a) - 1] not in ('--months', '--res')]
    if not epics: epics = [e for e in T['epics'] if not glob.glob(os.path.join(ROOT, 'data', 'raw', e.lower(), f'capital_{e}_MINUTE_5_*.csv'))]
    months = int(arg('--months', 36)); res_list = arg('--res', multi=True) or ['MINUTE_5']
    api = Api('--demo' in sys.argv)
    end = datetime.datetime.now(UTC).replace(second=0, microsecond=0); start = end - datetime.timedelta(days=round(months * 30.44))
    print(f'{len(epics)} Epics, {", ".join(res_list)}, {start:%Y-%m-%d} → {end:%Y-%m-%d}')
    for epic in epics:
        m = api.get(f'/api/v1/markets/{epic}')
        if '_error' in m:
            s = api.get('/api/v1/markets', {'searchTerm': epic})
            cand = [(x.get('epic'), x.get('instrumentName')) for x in (s.get('markets') or [])[:8]]
            print(f'{epic}: unbekanntes Epic ({m["_error"]}). Treffer der Suche: {cand}'); continue
        inst = m.get('instrument') or {}
        print(f'{epic}: {inst.get("name")} · Typ {inst.get("type")} · Währung {inst.get("currency")} · Öffnungszeiten-Zone {(inst.get("openingHours") or {}).get("zone")}')
        if '--list' in sys.argv: continue
        for res in res_list: download(api, epic, res, start, end)

if __name__ == '__main__':
    main()
