"""Convert production stall placements into scripts/data/demo-layouts.json.

This converter produced the 274-stall seed data (5 layouts). It reads a plain-text
extract of T_STALLS made from the bm_prod custom-format dump:

    pg_restore -a -t T_STALLS -f <workdir>/stalls.sql 15-09.sql

Usage:
    python build-demo-layouts.py <workdir-containing-stalls.sql> <output-json-path>

Re-run only when regenerating the seed from a newer dump. It never touches a database.
"""
import os, sys, json
from collections import Counter

sp, out_path = sys.argv[1], sys.argv[2]
B = chr(92)
PX = 20.0  # verified: 81x61 px stall labelled "12sqm" -> (81-1)/20 x (61-1)/20 = 4 x 3


def unesc(s):
    out, k = [], 0
    m = {'n': chr(10), 't': chr(9), 'r': chr(13), B: B}
    while k < len(s):
        if s[k] == B and k + 1 < len(s) and s[k + 1] in m:
            out.append(m[s[k + 1]]); k += 2; continue
        out.append(s[k]); k += 1
    return ''.join(out)


def parse(path):
    txt = open(path, encoding='utf-8', errors='replace').read().splitlines()
    cols, rows, inblk = None, [], False
    for l in txt:
        if l.startswith('COPY '):
            cols = l[l.index('(') + 1:l.rindex(')')].split(', '); inblk = True; continue
        if inblk:
            if l == B + '.':
                break
            rows.append(l.split(chr(9)))
    return {c: i for i, c in enumerate(cols)}, rows


ci, rows = parse(os.path.join(sp, 'stalls.sql'))

# hall_id -> (name, planner width=prod length, planner length=prod breadth, prod layout id)
HALLS = {
    '49': ('Hall 1GF', 84, 116, 23),
    '51': ('Hall 2GF', 70, 90, 25),
    '65': ('Hall 12', 58, 41, 32),
    '63': ('Hall 8-9-10', 133, 43, 36),
    '78': ('Convention Center', 61, 60, 40),
}

# booking_status -> stall colour (real data driving the visual, not an invented feature)
COLORS = {'Booked': '#b91c1c', 'Available': '#047857'}
DEFAULT_COLOR = '#3498db'

layouts = []
for hid, (hname, W, L, prod_layout_id) in HALLS.items():
    mine = [r for r in rows if r[ci['hall_id']] == hid and r[ci['is_active']] == 't'
            and r[ci['stall_coordinates']] not in (B + 'N', '')]
    if not mine:
        continue
    event, _ = Counter(r[ci['event_id']] for r in mine).most_common(1)[0]
    chosen = [r for r in mine if r[ci['event_id']] == event]

    stalls, dropped = [], []
    for i, r in enumerate(chosen):
        c = json.loads(unesc(r[ci['stall_coordinates']]))
        w = round((c['width'] - 1) / PX, 2)
        l = round((c['height'] - 1) / PX, 2)
        px = round((c['left'] + (c['width'] - 1) / 2.0) / PX - W / 2.0, 2)
        pz = round((c['top'] + (c['height'] - 1) / 2.0) / PX - L / 2.0, 2)

        if w <= 0 or l <= 0:
            dropped.append({'why': 'non-positive size', 'row': i}); continue
        if abs(px) + w / 2 > W / 2 + 1e-8 or abs(pz) + l / 2 > L / 2 + 1e-8:
            dropped.append({'why': 'outside hall', 'row': i}); continue

        # BR-13: the save API rejects the whole request on any overlap, so resolve here —
        # keep the earlier stall, drop the later one, and record it.
        clash = next((s for s in stalls
                      if abs(px - s['posX']) < (w + s['width']) / 2 - 1e-8
                      and abs(pz - s['posZ']) < (l + s['length']) / 2 - 1e-8), None)
        if clash is not None:
            dropped.append({'why': 'overlaps ' + clash['name'], 'row': i}); continue

        raw_name = r[ci['stall_name']]
        number = r[ci['stall_number']]
        if raw_name not in (B + 'N', '', 'N.A.'):
            name = raw_name
        elif number not in (B + 'N', ''):
            name = 'Stall ' + number
        else:
            name = 'Stall %d' % (len(stalls) + 1)

        status = r[ci['booking_status']]
        stalls.append({
            'name': name, 'width': w, 'length': l, 'height': 4,
            'posX': px, 'posZ': pz,
            'color': COLORS.get(status, DEFAULT_COLOR),
            'gateSide': 'FRONT',
        })

    layouts.append({
        'layoutName': hname + ' - ITPO Layout',
        'source': {
            'prodHallId': int(hid), 'prodLayoutId': prod_layout_id, 'prodEventId': event,
            'pxPerUnit': PX, 'stallsInEvent': len(chosen), 'seeded': len(stalls),
            'dropped': dropped,
        },
        'hall': {'name': hname, 'shape': 'SQUARE', 'width': W, 'length': L, 'radius': 0},
        'stalls': stalls,
    })

doc = {
    '_provenance': (
        'Generated from the bm_prod dump (15-09.sql), schema idp, tables T_STALLS + '
        'T_HALL_LAYOUTS. Scale 20 px = 1 unit, verified against the "12sqm" area labels. '
        'posX/posZ are the stall centre relative to the hall centre (prod used top-left px). '
        'Colour encodes the real booking_status (Booked=red, Available=green, unknown=blue). '
        'gateSide is FRONT for every stall: prod stores how many open sides, not which side. '
        'No production system was read or written; only the dump file.'
    ),
    'layouts': layouts,
}
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(doc, f, indent=2)

for lay in layouts:
    s = lay['source']
    print('%-32s stalls %3d/%3d  dropped %d' % (lay['layoutName'], s['seeded'], s['stallsInEvent'], len(s['dropped'])))
    for d in s['dropped']:
        print('    dropped row %s: %s' % (d['row'], d['why']))
print('wrote', out_path)
