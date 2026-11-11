#!/usr/bin/env python3
"""Build the elevation raster for Kannur Drive from open terrain tiles.

Usage:  python3 scripts/build-elevation.py

Downloads Terrarium elevation tiles (AWS Open Data "Terrain Tiles", built from SRTM and other public
sources) for the map area, caches them in data-src/elevation-cache/, and writes

  client/assets/elevation.png   real ground height in metres: (R * 256 + G) / 10 - 100

at ELEV_RES game units per pixel, covering BOUNDS from shared/map-data.js. Needs numpy and Pillow.
The projection matches scripts/build-map.py (1 game unit = 10 real metres).
"""
import io, json, math, os, re, urllib.request
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'data-src', 'elevation-cache')
ZOOM = 13                                    # about 19 m per tile pixel at this latitude
ELEV_RES = 4.0                               # game units per output pixel (40 m)
URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

# same projection as build-map.py
LAT0, LON0 = 11.885, 75.415
KX = 111320 * math.cos(math.radians(LAT0))
KZ = 110574
SCALE = 10.0

src = open(os.path.join(ROOT, 'shared', 'map-data.js')).read()
B = json.loads(re.search(r'export const BOUNDS = (\{.*?\});', src).group(1))
W = int(round((B['x1'] - B['x0']) / ELEV_RES))
H = int(round((B['z1'] - B['z0']) / ELEV_RES))


def lonlat(x, z):
    return LON0 + x * SCALE / KX, LAT0 - z * SCALE / KZ


def tile_xy(lon, lat):
    n = 2 ** ZOOM
    tx = (lon + 180) / 360 * n
    ty = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return tx, ty


tiles = {}
def tile(tx, ty):
    if (tx, ty) not in tiles:
        os.makedirs(CACHE, exist_ok=True)
        path = os.path.join(CACHE, f'{ZOOM}-{tx}-{ty}.png')
        if not os.path.exists(path):
            req = urllib.request.Request(URL.format(z=ZOOM, x=tx, y=ty), headers={'User-Agent': 'kannur-drive-map-build'})
            data = urllib.request.urlopen(req, timeout=60).read()
            open(path, 'wb').write(data)
        a = np.asarray(Image.open(path).convert('RGB'), dtype=np.float64)
        tiles[(tx, ty)] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    return tiles[(tx, ty)]


def sample(lon, lat):
    """Bilinear elevation in metres at a point, across tile edges."""
    fx, fy = tile_xy(lon, lat)
    px, py = fx * 256 - 0.5, fy * 256 - 0.5
    x0, y0 = math.floor(px), math.floor(py)
    tx, ty = px - x0, py - y0
    def at(gx, gy):
        return tile(gx // 256, gy // 256)[gy % 256, gx % 256]
    return ((at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty)
            + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty)


elev = np.zeros((H, W))
for i in range(H):
    z = B['z0'] + (i + 0.5) * ELEV_RES
    for j in range(W):
        x = B['x0'] + (j + 0.5) * ELEV_RES
        elev[i, j] = sample(*lonlat(x, z))

print(f'elevation raster {W}x{H} from {len(tiles)} tiles, '
      f'min {elev.min():.1f} m, median {np.median(elev):.1f} m, max {elev.max():.1f} m')
enc = np.clip(np.round((elev + 100) * 10), 0, 65535).astype(np.uint32)
img = np.dstack([(enc >> 8).astype(np.uint8), (enc & 255).astype(np.uint8), np.zeros((H, W), np.uint8)])
out = os.path.join(ROOT, 'client', 'assets', 'elevation.png')
Image.fromarray(img, 'RGB').save(out, optimize=True)
print('wrote', os.path.relpath(out, ROOT), os.path.getsize(out) // 1024, 'KB')
