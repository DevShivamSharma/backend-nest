"""Render one hall's outline from T_EVENT_HALL_LAYOUT_DATA.csv as an HTML/SVG,
overlaid with the seeded stalls, for visual comparison against the SelfCare screenshot.

This is the verification tool used to prove the CSV reproduces the reference image
(docs/12-hall-geometry-and-open-side-plan.md, Phases 1 and 4).

Usage:
    python render-hall-compare.py <path-to-T_EVENT_HALL_LAYOUT_DATA.csv> <out-dir> [hall_id]

hall_id defaults to 63 (Hall 8-9-10). Output: <out-dir>/hall_compare.html - open in a browser.
Reads the seeded stalls from ../data/demo-layouts.json relative to this script.
"""
import sys, csv, json, os

csv_path, out_dir = sys.argv[1], sys.argv[2]
HALL_ID = sys.argv[3] if len(sys.argv) > 3 else '63'
HALL_NAMES = {'49': 'Hall 1GF', '51': 'Hall 2GF', '65': 'Hall 12',
              '63': 'Hall 8-9-10', '78': 'Convention Center'}
SCALE = 5.5      # svg px per unit

with open(csv_path, encoding='utf-8-sig', errors='replace', newline='') as f:
    rdr = csv.reader(f)
    header = next(rdr)
    rows = list(rdr)
i = {c: n for n, c in enumerate(header)}

# pick the richest layout row for this hall
cands = [r for r in rows if r[i['hall_id']] == HALL_ID]
best, best_n = None, -1
for r in cands:
    try:
        d = json.loads(r[i['layout_data']])
        n = len(d.get('nonClickableAreas') or [])
        if n > best_n:
            best, best_n, best_d = r, n, d
    except Exception:
        pass

L = float(best[i['length']])
B = float(best[i['breadth']])
areas = best_d.get('nonClickableAreas') or []
print('row id=%s: L=%s B=%s areas=%d' % (best[i['id']], L, B, len(areas)))

# exit labels for context
try:
    exits = json.loads(best[i['exit_labels']]) if best[i['exit_labels']].strip() not in ('', 'NULL') else []
except Exception:
    exits = []
print('exit labels:', [e.get('text') for e in exits][:20])

W, H = L * SCALE, B * SCALE
svg = []
svg.append('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="-20 -20 %d %d" style="background:#fff">'
           % (W + 40, H + 40, W + 40, H + 40))

# grid over the bounding rect (like SelfCare)
svg.append('<defs><pattern id="g" width="%d" height="%d" patternUnits="userSpaceOnUse">'
           '<path d="M %d 0 L 0 0 0 %d" fill="none" stroke="#d7dbe0" stroke-width="0.7"/></pattern></defs>'
           % (SCALE, SCALE, SCALE, SCALE))
svg.append('<rect x="0" y="0" width="%d" height="%d" fill="url(#g)" stroke="#bbb"/>' % (W, H))

# stalls of the seeded layout (center-origin -> top-left)

repo_json = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'demo-layouts.json')
doc = json.load(open(repo_json, encoding='utf-8'))
hall_name = HALL_NAMES.get(HALL_ID, '')
lay = next((x for x in doc['layouts'] if x['hall']['name'] == hall_name), None)
if lay is None:
    print('no seeded layout for hall_id', HALL_ID, '- rendering areas only')
    lay = {'stalls': []}
for s in lay['stalls']:
    x = (s['posX'] + L / 2 - s['width'] / 2) * SCALE
    y = (s['posZ'] + B / 2 - s['length'] / 2) * SCALE
    svg.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" fill-opacity="0.55" stroke="#333" stroke-width="0.5"/>'
               % (x, y, s['width'] * SCALE, s['length'] * SCALE, s['color']))

# nonClickableAreas on top: white = outside mask, others = their color
for a in areas:
    fill = a.get('fillColor') or '#742371'
    if fill == '#ffffff':
        fill_attr = 'fill="#ffffff"'
    else:
        fill_attr = 'fill="%s"' % fill
    svg.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" %s/>'
               % (a['x'] * SCALE, a['y'] * SCALE, a['width'] * SCALE, a['height'] * SCALE, fill_attr))

svg.append('</svg>')

html = ('<html><body style="margin:12px;font-family:sans-serif;background:#fff">'
        '<h3 style="color:#c00">Hall 8-9-10 — reproduced from T_EVENT_HALL_LAYOUT_DATA row %s (%d areas) + seeded stalls</h3>%s</body></html>'
        % (best[i['id']], len(areas), ''.join(svg)))
out = os.path.join(out_dir, 'hall_compare.html')
open(out, 'w', encoding='utf-8').write(html)
print('wrote', out)
