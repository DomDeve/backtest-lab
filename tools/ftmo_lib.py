"""Modul B – FTMO-2-Step-Simulation (100k) als Bibliothek. Getestet in test/test_ftmo_lib.py.

Regeln (Konto in Prozent vom Startkapital, Start = 100):
  Phase 1 Ziel +10 %, Phase 2 Ziel +5 %, je mit frischem Konto.
  Gesamtverlust: Equity darf 90 nicht erreichen (statisch vom Startkapital).
  Tagesverlust: Equity darf nicht um >= 5 (5 % des Startkapitals) unter den Saldo von 00:00 Uhr (Berlin) fallen –
    inklusive offener Positionen. Offene Verluste werden über die MAE des Trades angenähert (intrabar Hoch/Tief):
    geprüft am Einstiegstag und, falls über Nacht gehalten, am Ausstiegstag.
  Mindestens 4 Handelstage (Tage mit mindestens einem Einstieg) je Phase; kein Zeitlimit (Abbruch nach max_days).
  Bestanden, sobald der realisierte Saldo das Ziel erreicht und 4 Handelstage erfüllt sind.

Trades kommen als „Tages-Eimer“: days = [[(r, mae_r, span), ...], ...] – je Handelstag die dort eröffneten Trades in
Zeitreihenfolge; span = Anzahl Handelstage bis zum Ausstieg (0 = gleicher Tag).
Risiko: risk % vom aktuellen Saldo (wie die Bots) oder vom Startkapital (risk_mode='initial').
"""
import random, statistics

def to_days(trades, day_list):
    """trades: Dicts mit entry_date, exit_date, r, mae (Berlin-Datum ISO). day_list: alle Handelstage (sortiert)."""
    idx = {d: i for i, d in enumerate(day_list)}
    days = [[] for _ in day_list]
    for t in sorted(trades, key=lambda x: (x['entry_date'], x.get('entry_time') or '')):
        i = idx.get(t['entry_date'])
        if i is None: continue
        j = idx.get(t['exit_date'], i)
        days[i].append((t['r'], max(0.0, t.get('mae') if t.get('mae') is not None else 1.0), max(0, j - i)))
    return days

def run_phase(days, start, risk, target, daily=5.0, maxloss=10.0, min_days=4, max_days=1000, risk_mode='current'):
    """Ab Tag `start`. Liefert (ergebnis, anzahl_tage, end_index, min_equity). ergebnis: pass | fail_tag | fail_gesamt | offen."""
    bal = 100.0; traded = 0; pending = {}  # tag -> [(r, mae, risk_amt)]
    min_eq = 100.0; k = start
    while k < len(days) and k - start < max_days:
        day_start = bal
        events = [(p, True) for p in pending.pop(k, [])] + [(t, False) for t in days[k]]
        if days[k]: traded += 1
        for item, carried in events:
            if carried:
                r, mae, amt = item; span = 0
            else:
                r, mae, span = item; amt = (risk if risk_mode == 'initial' else bal * risk / 100.0)
            worst = bal - mae * amt
            min_eq = min(min_eq, worst)
            if day_start - worst >= daily - 1e-9: return 'fail_tag', k - start + 1, k, min_eq
            if worst <= 100 - maxloss + 1e-9: return 'fail_gesamt', k - start + 1, k, min_eq
            if span > 0 and not carried:
                pending.setdefault(k + span, []).append((r, mae, amt)); continue
            bal += r * amt
            min_eq = min(min_eq, bal)
            if day_start - bal >= daily - 1e-9: return 'fail_tag', k - start + 1, k, min_eq
            if bal <= 100 - maxloss + 1e-9: return 'fail_gesamt', k - start + 1, k, min_eq
            if bal >= 100 + target - 1e-9 and traded >= min_days and not pending: return 'pass', k - start + 1, k, min_eq
        if bal >= 100 + target - 1e-9 and traded >= min_days and not pending: return 'pass', k - start + 1, k, min_eq
        k += 1
    return 'offen', k - start, k, min_eq

def challenge(days, start, risk, **kw):
    r1, d1, e1, m1 = run_phase(days, start, risk, 10, **kw)
    if r1 != 'pass': return dict(p1=r1, p2=None, days=d1, d1=d1, d2=None, min_eq=m1)
    r2, d2, _, m2 = run_phase(days, e1 + 1, risk, 5, **kw)
    return dict(p1='pass', p2=r2, days=d1 + d2, d1=d1, d2=d2, min_eq=min(m1, m2))

def week_blocks(days, day_list):
    """Handelstage zu Kalenderwochen bündeln (für Block-Bootstrap)."""
    import datetime
    blocks, cur, wk = [], [], None
    for d, b in zip(day_list, days):
        w = datetime.date.fromisoformat(d).isocalendar()[:2]
        if wk is not None and w != wk: blocks.append(cur); cur = []
        cur.append(b); wk = w
    if cur: blocks.append(cur)
    return blocks

def summarize(res):
    n = len(res)
    done1 = [x for x in res if x['p1'] != 'offen']
    p1 = sum(1 for x in done1 if x['p1'] == 'pass') / len(done1) if done1 else None
    ph2 = [x for x in res if x['p1'] == 'pass' and x['p2'] != 'offen']
    p2 = sum(1 for x in ph2 if x['p2'] == 'pass') / len(ph2) if ph2 else None
    both = sorted(x['days'] for x in ph2 if x['p2'] == 'pass')
    fails = [x['p1'] if x['p1'].startswith('fail') else x['p2'] for x in res if x['p1'].startswith('fail') or (x['p2'] or '').startswith('fail')]
    mins = sorted(x['min_eq'] for x in res)
    q = lambda a, p: a[min(len(a) - 1, int(p * len(a)))] if a else None
    return dict(n=n, offen=sum(1 for x in res if x['p1'] == 'offen' or x['p2'] == 'offen'), p1=p1, p2=p2,
                both=(p1 * p2) if p1 is not None and p2 is not None else None,
                days_mean=statistics.mean(both) if both else None, days_median=q(both, 0.5), days_p95=q(both, 0.95),
                fail_tag=sum(1 for f in fails if f == 'fail_tag') / len(fails) if fails else None,
                fail_gesamt=sum(1 for f in fails if f == 'fail_gesamt') / len(fails) if fails else None,
                min_eq_p5=q(mins, 0.05))

def simulate(days, day_list, risk, runs=2000, seed=11, **kw):
    """Rollierend (jeder Handelstag einmal Start, echte Reihenfolge) + Block-Bootstrap nach Kalenderwochen."""
    roll = [challenge(days, s, risk, **kw) for s in range(len(days))]
    blocks = week_blocks(days, day_list)
    rnd = random.Random(seed); boot = []
    for _ in range(runs):
        seq = []
        while len(seq) < 1000: seq.extend(blocks[rnd.randrange(len(blocks))])
        boot.append(challenge(seq, 0, risk, **kw))
    return dict(rollierend=summarize(roll), bootstrap=summarize(boot))
