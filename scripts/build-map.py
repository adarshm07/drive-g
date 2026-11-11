#!/usr/bin/env python3
"""Build the Kannur Drive map from an OpenStreetMap (Overpass JSON) export.

Usage:  python3 scripts/build-map.py data-src/kannur-osm-raw.json

Writes:
  shared/map-data.js        roads, landmarks, spawn points, paddy fields (used by server and client)
  client/assets/terrain.png terrain raster: R = signed distance to water, G = surface type

Map data (c) OpenStreetMap contributors, ODbL.
"""
import json, math, sys, os
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

SRC = sys.argv[1] if len(sys.argv) > 1 else 'data-src/kannur-osm-raw.json'
rnd = lambda v: round(float(v), 1)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LAT0, LON0 = 11.885, 75.415
KX = 111320 * math.cos(math.radians(LAT0))
KZ = 110574
SCALE = 10.0                                   # real metres per game unit
X0, X1, Z0, Z1 = -920.0, 580.0, -1180.0, 1360.0  # game units; +x east, +z south
RES = 2.0                                      # game units per raster pixel
W, H = int((X1 - X0) / RES), int((Z1 - Z0) / RES)


def proj(lat, lon):
    return ((lon - LON0) * KX / SCALE, -(lat - LAT0) * KZ / SCALE)


def px(x, z):
    return ((x - X0) / RES, (z - Z0) / RES)


def dp(pts, tol):
    """Douglas-Peucker simplification."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, az), (bx, bz) = pts[a], pts[b]
        L = math.hypot(bx - ax, bz - az) or 1e-9
        md, mi = 0, -1
        for i in range(a + 1, b):
            d = abs((bx - ax) * (az - pts[i][1]) - (ax - pts[i][0]) * (bz - az)) / L
            if d > md:
                md, mi = d, i
        if md > tol:
            keep[mi] = True
            stack += [(a, mi), (mi, b)]
    return [p for p, k in zip(pts, keep) if k]


def inside(x, z, pad=0):
    return X0 - pad < x < X1 + pad and Z0 - pad < z < Z1 + pad


def centroid(pts):
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


data = json.load(open(SRC))
els = data['elements']
geom = lambda e: [proj(g['lat'], g['lon']) for g in e.get('geometry', []) if g]

# ---------------------------------------------------------------- water raster
barrier = Image.new('L', (W, H), 0)
bd = ImageDraw.Draw(barrier)
for e in els:
    if e.get('tags', {}).get('natural') == 'coastline':
        pts = [px(*p) for p in geom(e)]
        if len(pts) > 1:
            bd.line(pts, fill=255, width=3)
bar = np.array(barrier) > 0

# Sea = everything connected to a point known to be open sea (west of Payyambalam),
# without crossing the coastline.
lab, _ = ndimage.label(~bar)
si, sj = map(int, px(X0 + 6, 0)[::-1])
sea = lab == lab[si, sj]
# the coastline pixels themselves next to sea count as sea (half of them) – thin them back
sea |= bar & ndimage.binary_dilation(sea, iterations=1) & ~ndimage.binary_dilation(~sea & ~bar, iterations=1)

RIVER_W = {'Valapattanam': 24, 'anjarakandy river': 14, 'Dharmadam River': 11, 'Kuyyali River': 9,
           'Kaanaam River': 4, 'Mayyazhi Puzha': 10}
riv_img = Image.new('L', (W, H), 0)
rd = ImageDraw.Draw(riv_img)
rivers = []
for e in els:
    t = e.get('tags', {})
    if t.get('waterway') != 'river':
        continue
    name = t.get('name') or ''
    w = RIVER_W.get(name, 9)
    pts = geom(e)
    if len(pts) < 2:
        continue
    rivers.append((name, pts))
    q = [px(*p) for p in pts]
    rd.line(q, fill=255, width=max(2, int(w / RES)), joint='curve')
    for p in q:  # round the joints
        r = w / RES / 2
        rd.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=255)
river = (np.array(riv_img) > 0) & ~sea
water = sea | river

# Signed distance to water in game units: + on land, - in water.
d_land = ndimage.distance_transform_edt(~water) * RES
d_water = ndimage.distance_transform_edt(water) * RES
sd = np.where(water, -d_water, d_land)

# ---------------------------------------------------------------- surfaces
SURF_GRASS, SURF_SAND, SURF_DRIVEIN, SURF_PADDY = 0, 80, 160, 240
surf = np.zeros((H, W), np.uint8)
beach_img = Image.new('L', (W, H), 0)
bimg = ImageDraw.Draw(beach_img)
beaches = {}
for e in els:
    t = e.get('tags', {})
    if t.get('natural') != 'beach':
        continue
    pts = geom(e)
    if len(pts) < 3:
        continue
    name = t.get('name') or ''
    beaches[name] = pts
    bimg.polygon([px(*p) for p in pts], fill=200 if name == 'Muzhappilangad Beach' else 100)
bmask = np.array(beach_img)
# a sand strip along the whole sea coast, wider on the open beaches
sea_dist = ndimage.distance_transform_edt(~sea) * RES
surf[(sea_dist < 6) & ~water] = SURF_SAND
surf[(bmask == 100) & ~water] = SURF_SAND
# the drive-in beach: the beach polygon plus the strip between it and the sea
drive = ndimage.binary_dilation(bmask == 200, iterations=3) & ~water
surf[drive] = SURF_DRIVEIN

# ---------------------------------------------------------------- roads
CLS = {'motorway': 't', 'trunk': 't', 'trunk_link': 't', 'primary': 'p', 'primary_link': 'p',
       'secondary': 's', 'secondary_link': 's', 'tertiary': 'q', 'unclassified': 'q', 'residential': 'q'}
roads = []
road_img = Image.new('L', (W, H), 0)
rdraw = ImageDraw.Draw(road_img)
for e in els:
    t = e.get('tags', {})
    c = CLS.get(t.get('highway'))
    if not c:
        continue
    pts = geom(e)
    # clip: keep runs that are inside the map
    runs, cur = [], []
    for p in pts:
        if inside(*p, pad=-6):
            cur.append(p)
        else:
            if len(cur) > 1:
                runs.append(cur)
            cur = []
    if len(cur) > 1:
        runs.append(cur)
    for r in runs:
        r = dp(r, 0.6)
        if sum(math.hypot(r[i + 1][0] - r[i][0], r[i + 1][1] - r[i][1]) for i in range(len(r) - 1)) < 2:
            continue
        name = t.get('name') or t.get('ref') or ''
        roads.append({'c': c, 'n': name, 'b': 1 if t.get('bridge') else 0, 'p': r})
        rdraw.line([px(*p) for p in r], fill=255, width=3)
# Dual carriageways are mapped as two parallel one-way lines. At 1:10 they sit on top of each
# other, so keep one and drop any road that runs along an already-kept road for most of its length.
def _samples(pts, step=1.0):
    out = []
    for (ax, az), (bx, bz) in zip(pts, pts[1:]):
        n = max(1, int(math.hypot(bx - ax, bz - az) / step))
        out += [(ax + (bx - ax) * k / n, az + (bz - az) * k / n) for k in range(n)]
    return out + [pts[-1]]
_kept, _grid = [], {}
for r in sorted(roads, key=lambda r: ('tpsq'.index(r['c']), -len(r['p']))):
    sm = _samples(r['p'])
    cov = 0
    for x, z in sm:
        ci, cj = int(x // 2), int(z // 2)
        if any(math.hypot(x - qx, z - qz) < 3.4 for i in (ci - 2, ci - 1, ci, ci + 1, ci + 2) for j in (cj - 2, cj - 1, cj, cj + 1, cj + 2) for qx, qz in _grid.get((i, j), ())):
            cov += 1
    if cov / len(sm) > 0.7:
        continue
    _kept.append(r)
    for x, z in sm[4:-4]:   # leave the ends out so roads that only meet at a junction are not counted
        _grid.setdefault((int(x // 2), int(z // 2)), []).append((x, z))
print('roads', len(roads), '-> after removing duplicate carriageways', len(_kept))
roads = _kept

# Close gaps: a road end that stops just short of another road (because its duplicate was removed,
# or the mapper left a small gap) is extended to meet it.
def _nearest_on(r, x, z):
    best = (1e9, None)
    for a, b in zip(r['p'], r['p'][1:]):
        dx, dz = b[0] - a[0], b[1] - a[1]
        t = max(0, min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz or 1e-9)))
        q = (a[0] + dx * t, a[1] + dz * t)
        d = math.hypot(x - q[0], z - q[1])
        if d < best[0]:
            best = (d, q)
    return best
_bb = [(min(p[0] for p in r['p']), max(p[0] for p in r['p']), min(p[1] for p in r['p']), max(p[1] for p in r['p'])) for r in roads]
_joined = 0
for i, r in enumerate(roads):
    for end in (0, -1):
        x, z = r['p'][end]
        best = (1e9, None)
        for j, o in enumerate(roads):
            if j == i or x < _bb[j][0] - 8 or x > _bb[j][1] + 8 or z < _bb[j][2] - 8 or z > _bb[j][3] + 8:
                continue
            c = _nearest_on(o, x, z)
            if c[0] < best[0]:
                best = c
        if 0.25 < best[0] < 8 and inside(x, z, pad=-12):
            if end == 0:
                r['p'].insert(0, best[1])
            else:
                r['p'].append(best[1])
            _joined += 1
print('road ends extended to meet another road:', _joined)
_dangling = 0
for i, r in enumerate(roads):
    for end in (0, -1):
        x, z = r['p'][end]
        if inside(x, z, pad=-12) and all(_nearest_on(o, x, z)[0] > 0.3 for j, o in enumerate(roads) if j != i and _bb[j][0] - 1 < x < _bb[j][1] + 1 and _bb[j][2] - 1 < z < _bb[j][3] + 1):
            _dangling += 1
print('road ends that are genuine dead ends:', _dangling)
road_img = Image.new('L', (W, H), 0)
rdraw = ImageDraw.Draw(road_img)
for r in roads:
    rdraw.line([px(*p) for p in r['p']], fill=255, width=3)
road_mask = np.array(road_img) > 0
road_dist = ndimage.distance_transform_edt(~road_mask) * RES


def sd_at(x, z):
    i, j = int((z - Z0) / RES), int((x - X0) / RES)
    if 0 <= i < H and 0 <= j < W:
        return sd[i, j]
    return -99


def road_dist_at(x, z):
    i, j = int((z - Z0) / RES), int((x - X0) / RES)
    if 0 <= i < H and 0 <= j < W:
        return road_dist[i, j]
    return 0


def nearest_road(x, z, classes='tpsq'):
    best = (1e9, None, None)
    for r in roads:
        if r['c'] not in classes:
            continue
        for a, b in zip(r['p'], r['p'][1:]):
            dx, dz = b[0] - a[0], b[1] - a[1]
            L2 = dx * dx + dz * dz or 1e-9
            t = max(0, min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2))
            qx, qz = a[0] + dx * t, a[1] + dz * t
            d = math.hypot(x - qx, z - qz)
            if d < best[0]:
                best = (d, (qx, qz), math.atan2(dx, dz))
    return best


def free_spot(x, z, min_road=10, min_sd=4, max_r=60, max_road=30):
    """Nearest land point close to (x, z) that is clear of roads and water."""
    for r in range(0, max_r, 2):
        for k in range(max(1, r * 2)):
            a = k / max(1, r * 2) * math.tau
            qx, qz = x + math.cos(a) * r, z + math.sin(a) * r
            if sd_at(qx, qz) > min_sd and min_road < road_dist_at(qx, qz) < max_road:
                return qx, qz
    return x, z


def face(x, z, tx, tz):
    """Rotation (about y) that turns a model's +z towards (tx, tz)."""
    return math.atan2(tx - x, tz - z)


def find_named(pattern, key=None):
    for e in els:
        t = e.get('tags', {})
        if pattern.lower() in (t.get('name') or '').lower() and (key is None or key(t)):
            if 'lat' in e:
                return proj(e['lat'], e['lon'])
            g = geom(e)
            if g:
                return centroid(g)
            if 'bounds' in e:
                b = e['bounds']
                return proj((b['minlat'] + b['maxlat']) / 2, (b['minlon'] + b['maxlon']) / 2)
    raise SystemExit('not found: ' + pattern)


def water_dir(x, z, rad=40):
    """Point on the nearest water within rad (used to face buildings towards the sea/river)."""
    best = None
    for a in range(0, 360, 10):
        for r in range(2, rad, 2):
            qx, qz = x + math.cos(math.radians(a)) * r, z + math.sin(math.radians(a)) * r
            if sd_at(qx, qz) < 0:
                if best is None or r < best[0]:
                    best = (r, qx, qz)
                break
    return best


landmarks = []

# Muzhappilangad drive-in beach
ii, jj = np.nonzero(surf == SURF_DRIVEIN)          # middle of the drive-in sand
k = np.argsort(ii)[len(ii) // 2]
bx, bz = X0 + (jj[k] + 0.5) * RES, Z0 + (ii[k] + 0.5) * RES
landmarks.append(dict(id='beach', name='Muzhappilangad Drive-in Beach', ml='മുഴപ്പിലങ്ങാട് ഡ്രൈവ്-ഇൻ ബീച്ച്', x=bx, z=bz, r=40))
# Beach entry: where the "Muzhappilangad beach road" reaches the sand
entry = None
for r in roads:
    if 'Muzhappilangad beach road' in r['n']:
        for p in r['p']:
            if entry is None or math.hypot(p[0] - bx, p[1] - bz) < math.hypot(entry[0] - bx, entry[1] - bz):
                entry = p
beach_entry = entry or (bx, bz)

# Dharmadam island view (southern end of the beach, looking at the island)
isl = None
for e in els:
    if (e.get('tags', {}).get('name') or '') == 'Dharmadam Island':
        isl = geom(e)
ix, iz = centroid(isl)
dvx, dvz = centroid(beaches['Dharmadam Beach'])
landmarks.append(dict(id='dharmadam', name='Dharmadam Island View', ml='ധർമ്മടം തുരുത്ത്', x=dvx, z=dvz, r=24))

# Parassinikadavu temple: on the river bank, ghat facing the river
tx, tz = find_named('Parassinikkadavu Muthappan')
tbx, tbz = free_spot(tx, tz, min_road=12, min_sd=10, max_road=40)
w = water_dir(tbx, tbz, 60)
trot = face(tbx, tbz, w[1], w[2]) + math.pi if w else 0  # model front (+z) faces away from the river
landmarks.append(dict(id='temple', name='Parassinikadavu Muthappan Temple', ml='പറശ്ശിനിക്കടവ് മുത്തപ്പൻ ക്ഷേത്രം',
                      x=tbx + math.sin(trot) * 14, z=tbz + math.cos(trot) * 14, r=26, bx=tbx, bz=tbz, rot=trot))

# Valapattanam bridge: the highway bridge at Valapattanam town (the one over water nearest that spot)
best = None
for r in roads:
    if not r['b']:
        continue
    mx, mz_ = centroid(r['p'])
    D = math.hypot(mx + 676, mz_ + 530)
    if sd_at(mx, mz_) < 10 and (best is None or D < best[0]):
        best = (D, mx, mz_, r['n'], r['c'])
landmarks.append(dict(id='bridge', name='Valapattanam River Bridge', ml='വളപട്ടണം പുഴ', x=best[1], z=best[2], r=16))
print('longest bridge:', best)

# St. Angelo Fort
fx, fz = find_named('St. Angelo Fort')
fbx, fbz = free_spot(fx, fz, min_road=12, min_sd=6, max_road=60)
w = water_dir(fbx, fbz, 60)
frot = face(fbx, fbz, w[1], w[2]) if w else 0  # cannons (+z) face the sea
landmarks.append(dict(id='fort', name='St. Angelo Fort', ml='സെന്റ് ആഞ്ചലോ കോട്ട', x=fbx - math.sin(frot) * 14,
                      z=fbz - math.cos(frot) * 14, r=24, bx=fbx, bz=fbz, rot=frot))

# Kannur lighthouse
lx, lz = find_named('Kannur Lighthouse', key=lambda t: t.get('man_made') == 'lighthouse')
lbx, lbz = free_spot(lx, lz, min_road=6, min_sd=3, max_road=40)
landmarks.append(dict(id='lighthouse', name='Kannur Lighthouse', ml='കണ്ണൂർ വിളക്കുമാടം', x=lbx, z=lbz, r=18, bx=lbx, bz=lbz))

# Payyambalam beach
pyx, pyz = centroid(beaches['Payyambalam Beach'])
landmarks.append(dict(id='payyambalam', name='Payyambalam Beach', ml='പയ്യാമ്പലം ബീച്ച്', x=pyx, z=pyz, r=30))

# Chayakada at the Thazhe Chovva junction on NH 66
d, (jx, jz), _ = nearest_road(-79, 222, 't')
cbx, cbz = free_spot(jx, jz, min_road=7, min_sd=4, max_road=12)
_, (rx, rz), _ = nearest_road(cbx, cbz)
landmarks.append(dict(id='chayakada', name='Chovva Junction Chayakada', ml='ചായക്കട', x=rx, z=rz, r=16,
                      bx=cbx, bz=cbz, rot=face(cbx, cbz, rx, rz)))

# Kannur town: places positioned from the mapped roads (Station Road, the bus stand road) and from
# published coordinates (KSRTC depot at Caltex junction, Arakkal Museum).
def ll(lat, lon):
    return proj(lat, lon)

def town_place(id, name, ml, x, z, r=20, min_road=8, max_road=24):
    bx_, bz_ = free_spot(x, z, min_road=min_road, min_sd=4, max_road=max_road)
    _, (rx_, rz_), _ = nearest_road(bx_, bz_)
    landmarks.append(dict(id=id, name=name, ml=ml, x=rx_, z=rz_, r=r, bx=bx_, bz=bz_, rot=face(bx_, bz_, rx_, rz_)))

def road_mid(name):
    pts = [p for r in roads if r['n'] == name for p in r['p']]
    return centroid(pts)

sx_, sz_ = road_mid('Station Road')
town_place('station', 'Kannur Railway Station', 'കണ്ണൂർ റെയിൽവേ സ്റ്റേഷൻ', sx_ - 14, sz_ - 6, r=22, min_road=10, max_road=30)
tx_, tz_ = road_mid('thavakarra road')
town_place('busstand', 'Thavakkara Bus Terminal', 'താവക്കര ബസ് ടെർമിനൽ', tx_, tz_, r=22, min_road=10, max_road=30)
cx_, cz_ = ll(11.8755571, 75.3747994)
town_place('caltex', 'Gandhi Circle (Caltex Junction)', 'ഗാന്ധി സർക്കിൾ', cx_, cz_, r=20, min_road=7, max_road=14)
ax_, az_ = ll(11.8594598, 75.3782215)
town_place('arakkal', 'Arakkal Museum', 'അറക്കൽ മ്യൂസിയം', ax_, az_, r=20, min_road=8, max_road=24)

# ---------------------------------------------------------------- paddy fields
rng = np.random.default_rng(7)
paddies = []
for _ in range(4000):
    if len(paddies) >= 9:
        break
    x, z = rng.uniform(-300, 520), rng.uniform(-1150, 1300)
    w_, d_ = rng.uniform(40, 80), rng.uniform(30, 60)
    ok = True
    for qx in np.linspace(x, x + w_, 6):
        for qz in np.linspace(z, z + d_, 6):
            if sd_at(qx, qz) < 6 or road_dist_at(qx, qz) < 12:
                ok = False
    if ok and all(abs(x - p['x0']) > 90 or abs(z - p['z0']) > 90 for p in paddies):
        paddies.append(dict(x0=x, x1=x + w_, z0=z, z1=z + d_))
for p in paddies:
    j0, j1 = int((p['x0'] - X0) / RES), int((p['x1'] - X0) / RES)
    i0, i1 = int((p['z0'] - Z0) / RES), int((p['z1'] - Z0) / RES)
    surf[i0:i1, j0:j1] = SURF_PADDY
pd = paddies[0]
landmarks.append(dict(id='paddy', name='Paddy Fields', ml='നെൽപ്പാടം', x=(pd['x0'] + pd['x1']) / 2, z=(pd['z0'] + pd['z1']) / 2, r=22))

# ---------------------------------------------------------------- spawn points along NH 66 in Kannur town
spawns = []
for r in roads:
    if r['c'] != 't':
        continue
    for a, b in zip(r['p'], r['p'][1:]):
        mx, mz_ = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        if math.hypot(mx + 300, mz_ - 70) < 140 and sd_at(mx, mz_) > 5:
            spawns.append([round(mx, 1), round(mz_, 1), round(math.atan2(b[0] - a[0], b[1] - a[1]), 3)])
spawns = spawns[:: max(1, len(spawns) // 10)][:10]

# ---------------------------------------------------------------- coconut spots (roads + drive-in beach)
coco = []
for r in roads:
    pts, acc, flip = r['p'], 0.0, 1
    for a, b in zip(pts, pts[1:]):
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if L < 1e-6:
            continue
        ux, uz = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        t = 30 - acc
        while t < L:
            x, z = a[0] + ux * t, a[1] + uz * t
            flip = -flip
            ox, oz = -uz * 1.8 * flip, ux * 1.8 * flip
            if sd_at(x, z) > 4 and inside(x, z, pad=-10):
                coco.append([rnd(x + ox), rnd(z + oz)])
            t += 30
        acc = (acc + L) % 30
ii, jj = np.nonzero(surf[::7, ::7] == SURF_DRIVEIN)
for i, j in zip(ii, jj):
    coco.append([rnd(X0 + (j * 7 + 0.5) * RES), rnd(Z0 + (i * 7 + 0.5) * RES)])

# ---------------------------------------------------------------- write outputs
rd2 = lambda v: round(v, 1)
for lm in landmarks:
    for k in ('x', 'z', 'bx', 'bz'):
        if k in lm:
            lm[k] = rd2(lm[k])
    if 'rot' in lm:
        lm['rot'] = round(lm['rot'], 3)
road_out = [{'c': r['c'], 'n': r['n'], 'b': r['b'], 'p': [v for p in r['p'] for v in (rd2(p[0]), rd2(p[1]))]} for r in roads]
island = [v for p in dp(isl, 0.8) for v in (rd2(p[0]), rd2(p[1]))]

js = f"""// Generated by scripts/build-map.py from OpenStreetMap data. Do not edit by hand.
// Map data (c) OpenStreetMap contributors, ODbL 1.0. https://www.openstreetmap.org/copyright
// Scale: 1 game unit = {SCALE:g} real metres. +x = east, +z = south.

export const BOUNDS = {json.dumps(dict(x0=X0, x1=X1, z0=Z0, z1=Z1))};
export const TERRAIN = {json.dumps(dict(w=W, h=H, res=RES, x0=X0, z0=Z0, sdRange=40))};
export const LANDMARKS = {json.dumps(landmarks, ensure_ascii=False)};
export const BEACH_ENTRY = {json.dumps([rd2(beach_entry[0]), rd2(beach_entry[1])])};
export const ISLAND = {json.dumps(island)};
export const SPAWNS = {json.dumps(spawns)};
export const PADDIES = {json.dumps([{k: rd2(v) for k, v in p.items()} for p in paddies])};
export const COCONUT_SPOTS = {json.dumps(coco, separators=(',', ':'))};
export const ROADS = {json.dumps(road_out, ensure_ascii=False, separators=(',', ':'))};
"""
open(os.path.join(ROOT, 'shared/map-data.js'), 'w').write(js)

os.makedirs(os.path.join(ROOT, 'client/assets'), exist_ok=True)
r_ch = np.clip((sd + 40) / 80 * 255, 0, 255).round().astype(np.uint8)
img = np.dstack([r_ch, surf, np.zeros_like(surf)])
Image.fromarray(img, 'RGB').save(os.path.join(ROOT, 'client/assets/terrain.png'), optimize=True)

print(f'coconut spots {len(coco)}, raster {W}x{H}, roads {len(roads)}, spawns {len(spawns)}, paddies {len(paddies)}')
for lm in landmarks:
    print(' ', lm['id'], lm['x'], lm['z'], lm.get('rot'))
print('map-data.js', len(js) // 1024, 'KB')
