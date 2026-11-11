// How the world is lit and shown: the sky and sun, sun shadows that follow the player, filmic tone
// mapping, sky reflections for glass and car paint, and (on High) a soft glow on lamps.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { QUALITY, TIME } from './quality.js';

/** Direction towards the sun (from over the sea, to the south-west) and the sky colours, by time of day. */
export const SUN_DIR = new THREE.Vector3(...TIME.sun).normalize();
export const HORIZON = new THREE.Color(TIME.horizon), ZENITH = new THREE.Color(TIME.zenith);

/** The sky reflection every shiny material uses; set once the renderer exists. */
export const ENV = { map: null };

export function setupLook(renderer, scene, camera) {
  renderer.setPixelRatio(Math.min(devicePixelRatio, QUALITY.pixelRatio));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.info.autoReset = false;

  // sky dome: a gradient from hazy horizon to blue overhead, with the sun and its glare.
  // It follows the camera and is drawn behind everything.
  const skyMat = () => new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: ZENITH }, horizon: { value: HORIZON }, sunDir: { value: SUN_DIR }, glare: { value: new THREE.Vector3(...TIME.glare) } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 top, horizon, sunDir, glare; varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = mix(horizon, top, pow(clamp(d.y, 0.0, 1.0), 0.55));
        float s = max(dot(d, sunDir), 0.0);
        col += glare * (pow(s, 24.0) * 0.18 + pow(s, 900.0) * 6.0);   // glare and the disc
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(820, 24, 12), skyMat());
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  sky.userData.shadow = 'none';
  scene.add(sky);
  scene.background = HORIZON.clone();
  scene.fog = new THREE.Fog(HORIZON.clone(), 190, 800);

  // reflections: render the sky alone into an environment map, once
  {
    // (a plain cube map: the Lambert and Phong materials used here cannot read PMREM maps)
    const only = new THREE.Scene(), target = new THREE.WebGLCubeRenderTarget(128);
    only.add(new THREE.Mesh(new THREE.SphereGeometry(100, 24, 12), skyMat()));
    const tm = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    new THREE.CubeCamera(0.1, 500, target).update(renderer, only);
    renderer.toneMapping = tm;
    ENV.map = target.texture;
  }

  // light: soft sky light plus the sun
  const hemi = new THREE.HemisphereLight(ZENITH.clone().lerp(new THREE.Color(0xffffff), 0.7), 0x7a9455, TIME.skyLight);
  const sun = new THREE.DirectionalLight(TIME.sunColor, TIME.sunPower);
  sun.position.copy(SUN_DIR).multiplyScalar(300);
  scene.add(hemi, sun, sun.target);

  // shadows: one map covering a square around the player, snapped to its texels so edges hold still
  const range = QUALITY.shadows >= 2048 ? 120 : 85;
  if (QUALITY.shadows) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = QUALITY.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    sun.castShadow = true;
    sun.shadow.mapSize.set(QUALITY.shadows, QUALITY.shadows);
    Object.assign(sun.shadow.camera, { left: -range, right: range, top: range, bottom: -range, near: 1, far: 700 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.06;
  }
  const texel = (2 * range) / Math.max(1, QUALITY.shadows);
  const lightRot = new THREE.Matrix4().lookAt(SUN_DIR, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  const inv = lightRot.clone().invert(), v = new THREE.Vector3();
  function follow(x, y, z) {
    // move the shadow square with the player, in whole texels as seen from the sun
    v.set(x, y, z).applyMatrix4(inv);
    v.x = Math.round(v.x / texel) * texel;
    v.y = Math.round(v.y / texel) * texel;
    v.applyMatrix4(lightRot);
    sun.target.position.copy(v);
    sun.position.copy(v).addScaledVector(SUN_DIR, 300);
    sky.position.copy(camera.position);
  }

  // bloom on High: only lamps and the sun's glare are bright enough to glow
  let composer = null;
  if (QUALITY.bloom) {
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.45, 1.05));
    composer.addPass(new OutputPass());
  }

  // Shadows on everything that should have them. New objects (cars, people) get picked up by
  // calling this again; `userData.shadow` = 'receive' or 'none' opts a mesh out of casting.
  function applyShadows(root = scene) {
    if (!QUALITY.shadows) return;
    root.traverse((o) => {
      if (!(o.isMesh || o.isInstancedMesh) || o.userData.shadowDone) return;
      const mode = o.userData.shadow;
      o.castShadow = mode !== 'receive' && mode !== 'none';
      o.receiveShadow = mode !== 'none';
      o.userData.shadowDone = true;
    });
  }

  return {
    sun, follow, applyShadows,
    // counts for the whole frame (shadow pass, scene and effects), read by tests via renderer.info
    render: () => { renderer.info.reset(); if (composer) composer.render(); else renderer.render(scene, camera); },
    setSize: (w, h) => { renderer.setSize(w, h, false); composer?.setSize(w, h); },
  };
}

/** Give a material the sky reflection: glass and paint. */
export function reflective(mat, amount = 0.35) {
  if (!ENV.map || !mat) return mat;
  mat.envMap = ENV.map;
  mat.combine = THREE.MixOperation; // blend the sky in, rather than multiplying it into dark glass
  if ('reflectivity' in mat) mat.reflectivity = amount;
  mat.needsUpdate = true;
  return mat;
}
