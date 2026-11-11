#!/usr/bin/env python3
"""Build the railway for Kannur Drive from OpenStreetMap.

Usage:
  python3 scripts/build-rail.py --fetch   # download from the OSM API, save data-src/kannur-osm-rail.json, build
  python3 scripts/build-rail.py           # build from the saved data-src/kannur-osm-rail.json

Writes shared/rail-data.js: the Mangalore-Shoranur line through the map (centreline, bridges, level
crossings), Kannur railway station (where the building and platforms are along the line), and the
Thavakkara bus terminal (yard and terminal buildings). Map data (c) OpenStreetMap contributors, ODbL.

--fetch makes two requests to api.openstreetmap.org: the route relation, and one small area around
the station and the bus terminal. Needs only the Python standard library.
"""
import json, math, os, re, sys, urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAVED = os.path.join(ROOT, 'data-src', 'kannur-osm-rail.json')
API = 'https://api.openstreetmap.org/api/0.6'
ROUTE = 7460766                                  # "Mangalore - Shoranur Railway"
TOWN_BBOX = (75.362, 11.862, 75.380, 11.882)     # lon/lat around the station and the bus terminal
STATION_BUILDING, PLATFORMS = 924858643, (924856057, 924856056)
BUS_YARD, BUS_BUILDINGS = 45765966, (924856048, 924856051)

# same projection as build-map.py: 1 game unit = 10 real metres, +x east, +z south
LAT0, LON0 = 11.885, 75.415
KX = 111320 * math.cos(math.radians(LAT0))
KZ = 110574
SCALE = 10.0
proj = lambda lat, lon: ((lon - LON0) * KX / SCALE, -(lat - LAT0) * KZ / SCALE)
src = open(os.path.join(ROOT, 'shared', 'map-data.js')).read()
B = json.loads(re.search(r'export const BOUNDS = (\{.*?\});', src).group(1))


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'kannur-drive-map-build/1.0'})
    return urllib.request.urlopen(req, timeout=180).read()


def parse(xml):
    r = ET.fromstring(xml)
    nodes = {n.get('id'): (float(n.get('lat')), float(n.get('lon')), {t.get('k'): t.get('v') for t in n.findall('tag')}) for n in r.findall('node')}
    ways = {w.get('id'): ([n.get('ref') for n in w.findall('nd')], {t.get('k'): t.get('v') for t in w.findall('tag')}) for w in r.findall('way')}
    rels = [[(m.get('type'), m.get('ref')) for m in rel.findall('member')] for rel in r.findall('relation')]
    return nodes, ways, rels


if '--fetch' in sys.argv:
    rn, rw, rr = parse(get(f'{API}/relation/{ROUTE}/full'))
    tn, tw, _ = parse(get(f'{API}/map?bbox={",".join(map(str, TOWN_BBOX))}'))
    # keep only what the build uses: the route's ways in member order, and a few features in town
    member_ways = [ref for t, ref in next(m for m in rr if any(x[1] in rw for x in m)) if t == 'way' and ref in rw]
    keep = {}
    def way_out(ways, nodes, wid):
        ids, tags = ways[wid]
        return {'id': int(wid), 'tags': tags, 'pts': [[nodes[i][0], nodes[i][1]] for i in ids if i in nodes]}
    keep['route'] = [way_out(rw, rn, w) for w in member_ways]
    keep['town'] = [way_out(tw, tn, str(w)) for w in (STATION_BUILDING, *PLATFORMS, BUS_YARD, *BUS_BUILDINGS)]
    keep['crossings'] = [[n[0], n[1]] for n in {**rn, **tn}.values() if n[2].get('railway') == 'level_crossing']
    keep['station_node'] = next([n[0], n[1]] for n in tn.values() if n[2].get('railway') == 'station' and n[2].get('ref') == 'CAN')
    os.makedirs(os.path.dirname(SAVED), exist_ok=True)
    json.dump(keep, open(SAVED, 'w'), ensure_ascii=False, separators=(',', ':'))
    print('saved', os.path.relpath(SAVED, ROOT), os.path.getsize(SAVED) // 1024, 'KB')

D = json.load(open(SAVED))
inside = lambda x, z, pad=0: B['x0'] + pad < x < B['x1'] - pad and B['z0'] + pad < z < B['z1'] - pad

# ---- the line: chain the route's members inside the map end to end. The route lists one track and
# then the other, so the first chain is one complete track: the centreline of the double track.
chain, bridges = [], []
for w in D['route']:
    pts = [proj(*p) for p in w['pts']]
    if not any(inside(*p) for p in pts) or w['tags'].get('service'):
        continue                                 # outside the map, or a siding / yard track
    if chain and math.dist(pts[0], chain[-1]) > 0.05:
        if math.dist(pts[-1], chain[-1]) < 0.05: pts = pts[::-1]
        elif math.dist(pts[-1], chain[0]) < 0.05: chain = pts[:-1] + chain; pts = []
        elif math.dist(pts[0], chain[0]) < 0.05: chain = pts[::-1][:-1] + chain; pts = []
        else: break                              # the other track begins: stop
    if w['tags'].get('bridge'):
        bridges.append(pts or [chain[0], chain[1]])
    chain += pts[1:] if chain and pts else pts
# clip to the map, a little inside its edge
line = [p for p in chain if inside(*p, pad=4)]


def simplify(pts, tol):
    if len(pts) < 3: return pts
    (ax, az), (bx, bz) = pts[0], pts[-1]
    L = math.hypot(bx - ax, bz - az) or 1e-9
    d = [abs((bx - ax) * (az - z) - (ax - x) * (bz - az)) / L for x, z in pts[1:-1]]
    i = max(range(len(d)), key=d.__getitem__)
    if d[i] <= tol: return [pts[0], pts[-1]]
    return simplify(pts[:i + 2], tol)[:-1] + simplify(pts[i + 1:], tol)
line = simplify(line, 0.3)


def nearest_on_line(x, z):
    best = (1e9, 0, None, None)
    for i in range(len(line) - 1):
        (ax, az), (bx, bz) = line[i], line[i + 1]
        dx, dz = bx - ax, bz - az
        t = max(0, min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz or 1e-9)))
        q = (ax + dx * t, az + dz * t)
        d = math.dist((x, z), q)
        if d < best[0]: best = (d, i, q, (dx, dz))
    return best

crossings = []
for lat, lon in D['crossings']:
    x, z = proj(lat, lon)
    d, _, q, _ = nearest_on_line(x, z)
    if d < 1.5 and inside(*q, pad=6) and all(math.dist(q, c) > 6 for c in crossings):
        crossings.append(q)

# ---- station: along the line at the station building; the building stands on one side
town = {w['id']: w for w in D['town']}
cen = lambda w: tuple(sum(v) / len(w['pts']) for v in zip(*(proj(*p) for p in w['pts'])))
bx, bz = cen(town[STATION_BUILDING])
d, i, (sx, sz), (dx, dz) = nearest_on_line(bx, bz)
l = math.hypot(dx, dz)
tx, tz = dx / l, dz / l
side = 1 if (-tz) * (bx - sx) + tx * (bz - sz) > 0 else -1   # +1: building on the left of the line's direction
# platform length from the mapped platforms, measured along the line
plen = max(abs((x - sx) * tx + (z - sz) * tz) for p in PLATFORMS for x, z in (proj(*q) for q in town[p]['pts'])) * 2
station = dict(x=round(sx, 2), z=round(sz, 2), rot=round(math.atan2(tx, tz), 4), side=side, len=round(min(max(plen, 40), 70), 1))

# ---- bus terminal: the yard, its long axis, and the terminal buildings
yard = [proj(*p) for p in town[BUS_YARD]['pts']]
yx, yz = (min(x for x, z in yard) + max(x for x, z in yard)) / 2, (min(z for x, z in yard) + max(z for x, z in yard)) / 2
# principal axis of the yard outline
sxx = sum((x - yx) ** 2 for x, z in yard); szz = sum((z - yz) ** 2 for x, z in yard); sxz = sum((x - yx) * (z - yz) for x, z in yard)
axis = 0.5 * math.atan2(2 * sxz, sxx - szz)
bus = dict(x=round(yx, 2), z=round(yz, 2), rot=round(math.pi / 2 - axis, 4),
           buildings=[[round(v, 2) for v in cen(town[b])] for b in BUS_BUILDINGS])

r2 = lambda v: round(v, 2)
out = f"""// Generated by scripts/build-rail.py from OpenStreetMap data. Do not edit by hand.
// Map data (c) OpenStreetMap contributors, ODbL 1.0. https://www.openstreetmap.org/copyright

/** The Mangalore-Shoranur line: centreline of the double track, bridges over water, level crossings. */
export const RAILWAY = {json.dumps(dict(
    line=[r2(v) for p in line for v in p],
    bridges=[[r2(v) for p in b[:1] + b[-1:] for v in p] for b in bridges if inside(*b[0])],
    crossings=[[r2(v) for v in c] for c in crossings],
), separators=(',', ':'))};

/** Kannur railway station: a point on the line, its direction, which side the building is on, platform length. */
export const STATION = {json.dumps(station)};

/** Thavakkara bus terminal: the yard centre and long axis, and the terminal buildings beside it. */
export const BUS_TERMINAL = {json.dumps(bus)};
"""
open(os.path.join(ROOT, 'shared', 'rail-data.js'), 'w').write(out)
print(f'line {len(line)} points, {len(crossings)} level crossings, {len(bridges)} bridges')
print('station', station)
print('bus terminal', bus)
