// Graphics quality: Low / Medium / High, chosen in the Garage and kept on this device.
// Phones and tablets start on Low, computers on High. Changing it reloads the page.
const KEY = 'kd_quality';
const PRESETS = {
  low: { name: 'Low', pixelRatio: 1, shadows: 0, softShadows: false, bloom: false, palmRange: 80, groundDetail: true },
  medium: { name: 'Medium', pixelRatio: 1.5, shadows: 1024, softShadows: false, bloom: false, palmRange: 120, groundDetail: true },
  high: { name: 'High', pixelRatio: 2, shadows: 2048, softShadows: true, bloom: true, palmRange: 160, groundDetail: true },
};

function stored() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
export const QUALITY_ID = PRESETS[stored()] ? stored() : touch ? 'low' : 'high';
export const QUALITY = PRESETS[QUALITY_ID];
export const QUALITY_LEVELS = Object.entries(PRESETS).map(([id, p]) => ({ id, name: p.name }));

// Time of day, also kept on this device: afternoon sun, or low golden evening light over the sea.
const TIME_KEY = 'kd_time';
const TIMES = {
  day: { name: 'Day', sun: [-0.5, 0.66, 0.56], sunColor: 0xfff0d6, sunPower: 2.6, skyLight: 1.35, zenith: 0x5d9ccc, horizon: 0xcfe3ea, glare: [1.0, 0.9, 0.7] },
  evening: { name: 'Evening', sun: [-0.86, 0.2, 0.42], sunColor: 0xffb070, sunPower: 2.4, skyLight: 0.95, zenith: 0x4f6f9e, horizon: 0xf4c69a, glare: [1.0, 0.62, 0.3] },
};
function storedTime() {
  try { return localStorage.getItem(TIME_KEY); } catch { return null; }
}
export const TIME_ID = TIMES[storedTime()] ? storedTime() : 'day';
export const TIME = TIMES[TIME_ID];
export const TIME_LEVELS = Object.entries(TIMES).map(([id, t]) => ({ id, name: t.name }));
export function setTime(id) {
  if (!TIMES[id] || id === TIME_ID) return;
  try { localStorage.setItem(TIME_KEY, id); } catch { /* private mode */ }
  location.reload();
}

export function setQuality(id) {
  if (!PRESETS[id] || id === QUALITY_ID) return;
  try { localStorage.setItem(KEY, id); } catch { /* private mode: lasts until reload only */ }
  location.reload();
}
