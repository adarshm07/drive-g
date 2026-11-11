# Kannur Drive

A multiplayer, low-poly driving game set in Kannur, Kerala. Open the page, pick a car, and you are dropped into a public room (up to 8 players) to drive around together.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Open the URL in two browser tabs (or share it on your network) to see multiplayer working. Needs Node 18 or newer.

`npm run smoke` runs an end-to-end check (accounts, matchmaking, coconuts, discovery, leaderboard) against a running server.

## What is in the game

- **World:** real Kannur at 1:10 scale, built from OpenStreetMap: NH 66, state and district roads, the coastline, Dharmadam Island, the Valapattanam, Anjarakandy and Dharmadam rivers, with bridges where roads cross water. The hills and valleys are real too, from open elevation data (shown twice their real height so they read at 1:10), and roads are graded: they climb smoothly, sit level from edge to edge, and the ground beside them is cut or filled to meet them.
- **Places to discover (13):** Muzhappilangad drive-in beach, Dharmadam Island view, Parassinikadavu Muthappan temple, Valapattanam bridge, St. Angelo Fort, Kannur Lighthouse, Payyambalam Beach, Kannur Railway Station, Thavakkara Bus Terminal, Gandhi Circle (Caltex Junction), Arakkal Museum, the Chovva junction chayakada and the paddy fields.
- **Roads:** laterite shoulders, edge lines, lane markings that stop at junctions, electric poles, and four marked lanes on NH 66.
- **Traffic:** 160 vehicles of 12 kinds (buses, mini buses, lorries, mini trucks, vans, cars, hatchbacks, SUVs, jeeps, autorickshaws, motorbikes, scooters) drive the main roads, keeping left. Their positions come from the clock, so every player sees the same traffic (`client/js/traffic.js`).
- **Drive anything:** get close to any traffic vehicle and press F to take it. Each kind handles and sounds different. Other players see you in it, and R returns you to your own car.
- **Sound:** a synthesised engine with gear changes, tyre and wind noise, and a horn that depends on the vehicle.
- **Land:** flat coast, hills growing inland, lush and dry grass, red laterite, wet river banks, with coconut and areca palms, banana plants, forest trees, mangroves, scrub and boulders placed to suit.
- **Buildings:** tiled houses, two-storey concrete homes, traditional long houses, roadside shops, sheds, multi-storey town blocks, mosques, churches and small temples.
- **Cars:** sedan, hatchback and open-top 4x4, all original low-poly designs built in code (`client/js/sedan.js`, `client/js/cars.js`), free to pick, in 8 colours. The sedan wears a Kannur `KL 13` number plate.
- **On foot:** press F to get out of the car, walk with WASD, hold Shift to run, and press F next to your car to drive again. Other players see you walking.
- **Shops:** 90 shopkeepers of 14 kinds, in Kannur town and along the roads outside it. Stop near one and press E to talk: local tips, directions to the nearest place you have not found, who else is online, and a chaya that gives a one-minute speed boost.
- **Chat:** press Enter to type. Messages go to everyone in your room and appear as a speech bubble over the speaker.
- **Accounts (optional):** guests can play straight away. An account saves coconuts, distance and places for the leaderboard.
- **Controls:** WASD or arrows, Space brake, F get out / in, Shift run, E talk, Enter chat, H horn, R respawn, M whole map. Touch buttons appear on phones.

## Rebuilding the map

`python3 scripts/build-map.py data-src/kannur-osm-raw.json` regenerates `shared/map-data.js` and `client/assets/terrain.png` from the OpenStreetMap export (needs numpy, scipy and Pillow). Map data (c) OpenStreetMap contributors, ODbL.

`python3 scripts/build-elevation.py` regenerates `client/assets/elevation.png`, the real ground heights, from the open [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on AWS (needs numpy and Pillow; tiles are cached in `data-src/elevation-cache/`). Elevation data: Terrain Tiles, from SRTM (NASA) and other public sources. `shared/world.js` turns the heights into terrain and road levels when the game loads (`setElevation`, `heightAt`).

## How it is built

| Path | What it does |
| --- | --- |
| `server/index.js` | Express + Socket.IO. REST API for accounts and leaderboard, public room matchmaking, 15 Hz position broadcast, server-checked coconut pickups and place discovery. |
| `server/store.js` | JSON-file persistence (`data/db.json`). |
| `shared/world.js` | World logic used by both server and client: road lookup, terrain height, car stats. |
| `shared/map-data.js` | Generated map: roads, landmarks, spawn points, coconut spots. |
| `client/js/shops.js` | Shop types, shopkeeper lines and the low-poly person model. |
| `client/js/scene.js` | Builds the 3D world with Three.js. |
| `client/js/cars.js` | Low-poly car models and name tags. |
| `client/js/sedan.js` | The sedan, built from extruded side profiles. |
| `client/js/parts.js` | Shared car parts: materials, tyres and wheels. |
| `client/js/main.js` | Menu, driving physics, networking, HUD and minimap. |

There is no build step: the browser loads Three.js as an ES module straight from `node_modules`.

## Deploying

Any host that runs a long-lived Node process with WebSockets works (Render, Railway, Fly.io, an EC2 or Azure VM).

- `PORT` sets the port (default 3000).
- `DATA_FILE` sets where the JSON database is written. Point it at a persistent disk, otherwise accounts reset on each deploy.

## Known limits of this first version

- **Storage is a JSON file**, chosen so the game runs with zero setup. It is fine for a single server and a few hundred accounts. For more, replace `server/store.js` with Postgres (users, sessions) and keep the same call sites.
- **Rooms live in one process.** To run several server instances you would add the Socket.IO Redis adapter and move room state to Redis.
- **Movement is client-authoritative.** The server validates pickups and discoveries by distance, but a modified client could still report false positions. Fine for a friendly game, not for competitive play.
- **Landmarks, cars and people are stylised** low-poly models, not traced from photos.

## Using your own 3D car models

Put a `.glb` file at `client/assets/cars/<type>.glb` (`sedan`, `hatch` or `suv`; none ship by default) and list it in `MODEL_FILES` in `client/js/cars.js`. The game scales it, sits it on the ground and recolours any material named `bodypaint` with the player's colour. Objects with `tire` or `wheel` in the name spin as wheels. `scripts/export-car.py` converts a Blender file (`python3 scripts/export-car.py -- car.blend out.glb`, needs the `bpy` package). Check the licence of any model you did not make before publishing the game.
