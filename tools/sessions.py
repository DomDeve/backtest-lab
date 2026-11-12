"""Zentrale Session-Zeiten (config/sessions.yaml) für Python-Tools. Gegenstück: src/core/sessions.js.

Umrechnung nach UTC ausschließlich über zoneinfo (IANA), nie über feste Offsets.

  load()                         -> dict der ganzen Tabelle
  session_utc(epic, date, name)  -> (open_utc, close_utc) als aware datetime oder None (Wochenende/Feiertag)
  is_trading_day(epic, date)     -> bool (Wochenende, Kalender-Feiertag, Volumen-Feiertag aus sessions_no_trading_days.json)
  stock_home(epic, name='')      -> Regel-Dict oder None (unbekannt)
"""
import os, re, json, datetime
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, 'config', 'sessions.yaml')
NTD = os.path.join(ROOT, 'config', 'sessions_no_trading_days.json')
UTC = datetime.timezone.utc

def _scalar(v):
    v = v.strip()
    if v.startswith('[') and v.endswith(']'):
        inner = v[1:-1].strip()
        return [_scalar(x) for x in inner.split(',')] if inner else []
    if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
        s = v[1:-1]
        return s.replace('\\\\', '\\') if v[0] == '"' else s
    if v in ('true', 'false'): return v == 'true'
    if re.fullmatch(r'-?\d+', v): return int(v)
    return v

def _strip_comment(raw):
    q = None
    for i, ch in enumerate(raw):
        if ch in '"\'' and (q is None or q == ch): q = None if q else ch
        elif ch == '#' and q is None and (i == 0 or raw[i - 1] == ' '): return raw[:i].rstrip()
    return raw.rstrip()

def parse(text):
    """Eingeschränktes YAML: Maps über Einrückung, Inline-Listen, Skalare, Kommentare."""
    root = {}; stack = [(-1, root)]
    for raw in text.splitlines():
        line = _strip_comment(raw)
        if not line.strip() or line.lstrip().startswith('#'): continue
        ind = len(line) - len(line.lstrip())
        key, _, val = line.strip().partition(':')
        while stack[-1][0] >= ind: stack.pop()
        cur = stack[-1][1]
        if val.strip() == '':
            cur[key] = {}; stack.append((ind, cur[key]))
        else:
            cur[key] = _scalar(val)
    return root

_cache = {}
def load(path=PATH):
    if path not in _cache: _cache[path] = parse(open(path, encoding='utf-8').read())
    return _cache[path]

def no_trading_days():
    return json.load(open(NTD)) if os.path.exists(NTD) else {}

def _date(d): return d if isinstance(d, datetime.date) else datetime.date.fromisoformat(str(d))

def is_trading_day(epic, date, S=None, volume_rule=True):
    S = S or load(); e = S['epics'][epic]; d = _date(date)
    if d.weekday() >= 5 and e.get('calendar') != 'NONE': return False
    if str(d) in [str(x) for x in S['calendars'][e['calendar']]['holidays']]: return False
    return not volume_rule or str(d) not in no_trading_days().get(epic, [])

def main_session(epic, S=None):
    S = S or load(); return next(iter(S['epics'][epic]['sessions']))

def session_utc(epic, date, name=None, S=None, any_day=False):
    """Session-Fenster eines Handelstags (Datum in Börsen-Ortszeit) in UTC; None, wenn kein Handelstag (any_day=True: ohne Kalenderprüfung)."""
    S = S or load(); e = S['epics'][epic]; d = _date(date)
    s = e['sessions'][name or main_session(epic, S)]
    if not any_day and not is_trading_day(epic, d, S): return None
    tz = ZoneInfo(s['tz'])
    o = datetime.datetime.combine(d, datetime.time.fromisoformat(s['open_local']), tz)
    c = datetime.datetime.combine(d, datetime.time.fromisoformat(s['close_local']), tz)
    return o.astimezone(UTC), c.astimezone(UTC)

def in_tz(dt, tzname): return dt.astimezone(ZoneInfo(tzname))

def stock_home(epic, name='', S=None):
    S = S or load()
    for k, r in S.get('stock_rules', {}).items():
        if re.search(r['match'], f'{epic} {name}'.strip()) or re.search(r['match'], name or ''): return dict(r, key=k)
    return None

def orb_vwap_excluded(S=None):
    """Ausgeschlossene Epics bzw. Sessions -> Grund (Schlüssel 'EPIC' oder 'EPIC/session')."""
    S = S or load(); out = {}
    for k, e in S['epics'].items():
        if not e.get('orb_vwap'): out[k] = e.get('exclude_reason') or e.get('validation'); continue
        for n in e['sessions']:
            if e.get('orb_vwap_sessions') and n not in e['orb_vwap_sessions']: out[k + '/' + n] = e.get('validation')
    return out

if __name__ == '__main__':
    S = load()
    for k, e in S['epics'].items():
        w = session_utc(k, '2026-03-10')
        ss = ', '.join('%s %s–%s %s' % (n, s['open_local'], s['close_local'], s['tz']) for n, s in e['sessions'].items())
        print('%-10s %-7s %s  -> 10.03.2026 UTC %s' % (k, e['asset_class'], ss, '%s–%s' % (w[0].strftime('%H:%M'), w[1].strftime('%H:%M')) if w else '–'))
