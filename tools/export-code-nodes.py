#!/usr/bin/env python3
"""Code-Nodes "Code Strategie ..." aus einem n8n-Workflow-Export 1:1 nach strategies-live/<ziel>/ schreiben.

Aufruf:
  python3 tools/export-code-nodes.py <workflow.json> <ziel: capital|ftmo> [--prefix "Code Strategie "]

<workflow.json> = n8n-Export (Datei > Download) oder gespeicherte Antwort von get_workflow_details (n8n-MCP).
Dateiname: "Code Strategie NAS Fib61 LB2" -> NAS_Fib61_LB2.js (Punkte -> _), wie in src/live/variants.js erwartet.
"""
import json, os, re, sys

src, target = sys.argv[1], sys.argv[2]
prefix = sys.argv[sys.argv.index('--prefix') + 1] if '--prefix' in sys.argv else 'Code Strategie '
d = json.load(open(src))
wf = d.get('workflow', d)
out = os.path.join(os.path.dirname(__file__), '..', 'strategies-live', target)
os.makedirs(out, exist_ok=True)
n = 0
for node in wf['nodes']:
    if node['type'].endswith('.code') and node['name'].startswith(prefix):
        name = re.sub(r'[^A-Za-z0-9_]+', '_', node['name'][len(prefix):].replace('.', '_')).strip('_') + '.js'
        if target == 'ftmo':
            name = name.replace('.js', '_FTMO.js')
        open(os.path.join(out, name), 'w').write(node['parameters']['jsCode'])
        print('geschrieben:', name)
        n += 1
print(f'{n} Code-Nodes exportiert nach {out}')
