#!/usr/bin/env python3
"""Täglicher Strategie-Review (strategy-review/): Kennzahlen + FTMO-Simulation für eine Basis oder einen Kandidaten.

  python3 -I tools/review_eval.py <result.json> [<result.json> …] [--base <result.json> …] [--json out.json]

Mehrere result.json = ein gemeinsames FTMO-Konto (alle aktiven Bots kombiniert, Trades je Tag zusammengelegt).
Kennzahlen: Ø R netto, Trades/Monat, R/Monat, t (Tage, tagesrendite.py), schlechtester Tag, max. DD, Ø R je Hälfte und Drittel.
FTMO (tools/ftmo_lib.py, 0,5 % Risiko vom aktuellen Saldo, Tagesverlust inkl. offener Verluste über MAE):
  challenge – P(Phase 1), P(Phase 2 | 1), P(beide), Median-Tage bis beide bestanden (rollierend + Block-Bootstrap)
  funded    – je 21 Handelstage ab jedem Starttag: R/Monat (10./50./90. Perzentil), P(Verletzung im Monat)
--base: zusätzlich Δ Ø R je Hälfte/Drittel gegen die Basis (Stufe „Suche“ im Review).
"""
import os, sys, json, datetime, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ftmo_lib, tagesrendite

RISK = 0.5


def load(paths):
    trades, frm, to = [], None, None
    for p in paths:
        d = json.load(open(p))
        trades += [t for t in d['trades'] if t.get('R') is not None]
        frm = min(frm or d['period']['from'], d['period']['from']); to = max(to or d['period']['to'], d['period']['to'])
    trades.sort(key=lambda t: t['entryT'])
    return trades, frm, to


def parts(trades, k):
    n = len(trades); out = []
    for i in range(k):
        a = trades[i * n // k:(i + 1) * n // k]
        out.append(sum(t['R'] for t in a) / len(a) if a else None)
    return out


def split_time(trades, frm, to, k):
    """Ø R je Zeitabschnitt (gleich lange Kalenderabschnitte, nicht gleich viele Trades) – vergleichbar zwischen Varianten."""
    a = datetime.date.fromisoformat(frm).toordinal(); b = datetime.date.fromisoformat(to).toordinal() + 1
    out = []
    for i in range(k):
        lo, hi = a + (b - a) * i // k, a + (b - a) * (i + 1) // k
        x = [t['R'] for t in trades if lo <= datetime.date.fromisoformat(t['date']).toordinal() < hi]
        out.append(round(sum(x) / len(x), 4) if x else None)
    return out


def ftmo(trades, frm, to):
    day_list = list(tagesrendite.weekdays(frm, to))
    tl = [dict(entry_date=t['date'], exit_date=t['exitDate'], entry_time=t['entryHm'], r=t['R'], mae=t.get('maeR')) for t in trades]
    days = ftmo_lib.to_days(tl, day_list)
    ch = ftmo_lib.simulate(days, day_list, RISK, runs=1000)
    month, viol = [], 0
    starts = range(0, max(0, len(days) - 21))
    for s in starts:
        res, n, _, _ = run_month(days, s)
        month.append(res[1]); viol += res[0] != 'offen'
    month.sort()
    q = lambda p: round(month[min(len(month) - 1, int(p * len(month)))], 2) if month else None
    return dict(challenge=ch, funded=dict(r_month_p10=q(0.1), r_month_p50=q(0.5), r_month_p90=q(0.9),
                                          p_violation_month=round(viol / len(month), 4) if month else None, starts=len(month)))


def run_month(days, start):
    """21 Handelstage ohne Ziel, Konto 100 %, Risiko 0,5 % vom Startkapital (Funded: Saldo nach Auszahlung wieder 100k)."""
    res, n, end, _ = ftmo_lib.run_phase(days, start, RISK, 1e9, max_days=21, risk_mode='initial')
    r = 0.0
    if res == 'offen':
        r = sum(x[0] for d in days[start:start + 21] for x in d)  # Σ R der in diesem Monat eröffneten Trades
    else:
        r = sum(x[0] for d in days[start:end + 1] for x in d)
    return (res, r), n, end, None


def evaluate(paths):
    trades, frm, to = load(paths)
    rets = tagesrendite.daily_returns(trades, RISK, frm, to)
    st = tagesrendite.stats(rets)
    months = (datetime.date.fromisoformat(to) - datetime.date.fromisoformat(frm)).days / 30.44
    n = len(trades); avg = sum(t['R'] for t in trades) / n if n else 0
    out = dict(runs=paths, frm=frm, to=to, trades=n, avg_r=round(avg, 4), trades_month=round(n / months, 2),
               r_month=round(avg * n / months, 2), t_days=round(st['t'], 2), worst_day_pct=round(st['worst'], 2),
               maxdd_pct=round(st['maxdd'], 2), days_le4=st['days_le4'],
               halves=split_time(trades, frm, to, 2), thirds=split_time(trades, frm, to, 3), by_year=st['by_year'])
    out['ftmo'] = ftmo(trades, frm, to)
    # Realitätscheck 100R/Monat
    out['reality'] = dict(ziel_r_monat=100, ist_r_monat=out['r_month'],
                          noetig_trades_bei_avg=round(100 / avg, 1) if avg > 0 else None,
                          noetig_avg_bei_trades=round(100 / out['trades_month'], 3) if out['trades_month'] else None)
    return out


def main():
    a = sys.argv[1:]
    js = a[a.index('--json') + 1] if '--json' in a else None
    if js: i = a.index('--json'); a = a[:i] + a[i + 2:]
    base = []
    if '--base' in a: i = a.index('--base'); base = a[i + 1:]; a = a[:i]
    res = dict(kandidat=evaluate(a))
    if base:
        b = evaluate(base); res['basis'] = b
        k = res['kandidat']
        res['delta'] = dict(halves=[round(x - y, 4) for x, y in zip(k['halves'], b['halves'])],
                            thirds=[round(x - y, 4) for x, y in zip(k['thirds'], b['thirds'])])
        res['delta']['besser_ueberall'] = all(d > 0 for d in res['delta']['halves'] + res['delta']['thirds'])
    s = json.dumps(res, indent=1, ensure_ascii=False)
    if js: open(js, 'w').write(s)
    print(s)


if __name__ == '__main__':
    main()
