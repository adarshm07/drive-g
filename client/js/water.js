// The sea and rivers: one big plane with a shader. Colour goes from turquoise shallows to deep teal
// with distance from the shore (read from the terrain raster), small waves reflect the sky and the
// sun, and bands of foam roll in along every shoreline.
import * as THREE from 'three';
import { TERRAIN, BOUNDS, WORLD, terrainSD } from '/shared/world.js';
import { SUN_DIR, HORIZON, ZENITH } from './look.js';

const vertex = /* glsl */ `
  #include <fog_pars_vertex>
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

const fragment = /* glsl */ `
  uniform float time;
  uniform sampler2D sdTex;
  uniform vec4 area;          // x0, z0, width, depth of the raster in world units
  uniform vec3 sunDir, skyTop, skyHorizon, deepCol, shallowCol;
  varying vec3 vWorld;
  #include <fog_pars_fragment>

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float waves(vec2 q) {
    return noise(q * 0.18 + vec2(time * 0.06, time * 0.03)) + 0.5 * noise(q * 0.41 - vec2(time * 0.09, -time * 0.05))
         + 0.25 * noise(q * 0.93 + vec2(-time * 0.13, time * 0.11));
  }

  void main() {
    vec2 uv = (vWorld.xz - area.xy) / area.zw;
    bool inside = uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0;
    float sd = inside ? texture2D(sdTex, uv).r * 80.0 - 40.0 : -40.0;   // + land, - water (units)
    float depth = clamp(-sd / 22.0, 0.0, 1.0);

    vec2 p = vWorld.xz;
    float e = 0.5;
    vec3 n = normalize(vec3(waves(p - vec2(e, 0.0)) - waves(p + vec2(e, 0.0)), 1.6, waves(p - vec2(0.0, e)) - waves(p + vec2(0.0, e))));
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 R = reflect(-V, n);
    float fres = 0.06 + 0.8 * pow(1.0 - max(dot(n, V), 0.0), 4.0);
    vec3 sky = mix(skyHorizon, skyTop, clamp(R.y * 1.6, 0.0, 1.0));
    vec3 col = mix(mix(shallowCol, deepCol, sqrt(depth)), sky, fres);
    col += vec3(1.0, 0.92, 0.78) * pow(max(dot(R, sunDir), 0.0), 220.0) * 3.0;      // sun glint

    // foam: a line at the water's edge and bands rolling in towards it
    float shore = smoothstep(-5.0, -0.2, sd);                   // 1 near the shore
    float bands = smoothstep(0.75, 1.0, sin(sd * 1.9 + time * 1.7 + noise(p * 0.25) * 4.0));
    float edge = smoothstep(-1.4, -0.3, sd);
    float foam = clamp(shore * (0.5 * bands + 0.6 * edge) * (0.55 + 0.45 * noise(p * 1.7 + time * 0.4)), 0.0, 1.0);
    col = mix(col, vec3(0.96, 0.98, 1.0), foam);

    float alpha = max(mix(0.72, 0.93, depth), foam);
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

export function makeWater() {
  const B = BOUNDS, W = B.x1 - B.x0, D = B.z1 - B.z0;
  // shoreline raster as an 8-bit texture (signed distance -40..40 mapped to 0..255)
  const sd = terrainSD(), data = new Uint8Array(TERRAIN.w * TERRAIN.h);
  for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(((sd[i] + 40) / 80) * 255)));
  const tex = new THREE.DataTexture(data, TERRAIN.w, TERRAIN.h, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    time: { value: 0 },
    sdTex: { value: null },
    area: { value: new THREE.Vector4(TERRAIN.x0, TERRAIN.z0, TERRAIN.w * TERRAIN.res, TERRAIN.h * TERRAIN.res) },
    sunDir: { value: SUN_DIR.clone() },
    skyTop: { value: ZENITH.clone() },
    skyHorizon: { value: HORIZON.clone() },
    deepCol: { value: new THREE.Color(0x0f5c7a) },
    shallowCol: { value: new THREE.Color(0x3fb8b0) },
  }]);
  uniforms.sdTex.value = tex;
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: vertex, fragmentShader: fragment, transparent: true, fog: true });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W + 3000, D + 3000).rotateX(-Math.PI / 2), mat);
  mesh.position.set((B.x0 + B.x1) / 2, WORLD.water, (B.z0 + B.z1) / 2);
  mesh.userData.shadow = 'none';
  mesh.onBeforeRender = () => { uniforms.time.value = performance.now() / 1000; };
  return mesh;
}
