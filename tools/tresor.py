#!/usr/bin/env python3
"""Tresor (versiegelte Jahre je Epic) für Python-Auswertungen – gleiche Quelle wie src/core/tresor.js: config/tresor.json.

  import tresor; tresor.years('DE40') -> {2014, 2017, 2020, 2023}
  tresor.is_sealed('DE40', '2017-03-02')  /  tresor.drop_sealed(trades, 'DE40', key='date')
  tresor.open_tresor('DE40', 'Begründung …', ['nas-f618atr'])  -> Eintrag in config/tresor_protokoll.jsonl
"""
import os, json, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, 'config', 'tresor.json')
PROTOKOLL = os.path.join(ROOT, 'config', 'tresor_protokoll.jsonl')


def years(epic, cfg=None):
    cfg = cfg or json.load(open(CFG))
    return set(cfg['jahre'].get(epic, []))


def is_sealed(epic, date, ys=None):
    """date: 'YYYY-MM-DD…' (UTC) oder datetime/date."""
    y = date.year if hasattr(date, 'year') else int(str(date)[:4])
    return y in (ys if ys is not None else years(epic))


def drop_sealed(rows, epic, key='date'):
    ys = years(epic)
    return [r for r in rows if not is_sealed(epic, r[key], ys)]


def open_tresor(epic, reason, variants=(), path=PROTOKOLL):
    if not isinstance(reason, str) or len(reason.strip()) < 10:
        raise ValueError('Tresor öffnen nur mit Begründung (mind. 10 Zeichen)')
    rec = dict(zeit=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'), epic=epic,
               begruendung=reason.strip(), varianten=list(variants), befehl='python')
    with open(path, 'a') as fh: fh.write(json.dumps(rec, ensure_ascii=False) + '\n')
    return rec
