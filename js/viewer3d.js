// Sancho Rossi — vue 3D d'un tracé sur relief réel
// Terrain : tuiles d'élévation Terrarium (Mapzen/AWS) · Texture : imagerie Esri
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

let renderer = null;
let scene = null;
let controls = null;
let camera = null;
let rafId = null;
let progress = null; // { pts, cum, marker } pour la jauge de position
let terrainMesh = null;
const raycaster = new THREE.Raycaster();

const TERRAIN_SAMPLES = 224;
const TEXTURE_SIZE = 2048;
const Z_EXAGGERATION = 1.35;

function lonToX(lon, z) { return ((lon + 180) / 360) * 2 ** z; }
function latToY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("tuile inaccessible"));
    img.src = url;
  });
}

// Mosaïque de tuiles → canvas unique couvrant [x0,x1]×[y0,y1] au zoom z
async function buildMosaic(urlFn, z, x0, x1, y0, y1, size) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const tile = size / Math.max(cols, rows);
  const jobs = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      jobs.push(
        loadImage(urlFn(z, x, y)).then((img) =>
          ctx.drawImage(img, (x - x0) * tile, (y - y0) * tile, tile, tile)
        ).catch(() => {}) // tuile manquante : trou toléré
      );
    }
  }
  await Promise.all(jobs);
  return { canvas, ctx, cols, rows, tile };
}

export async function open(container, trail, track, eles) {
  dispose();

  // Emprise du tracé + marge
  const lats = track.map((p) => p[0]);
  const lons = track.map((p) => p[1]);
  let latMin = Math.min(...lats), latMax = Math.max(...lats);
  let lonMin = Math.min(...lons), lonMax = Math.max(...lons);
  const mLat = Math.max((latMax - latMin) * 0.25, 0.01);
  const mLon = Math.max((lonMax - lonMin) * 0.25, 0.015);
  latMin -= mLat; latMax += mLat; lonMin -= mLon; lonMax += mLon;

  // Zoom : au plus 5×5 tuiles, le plus fin possible (rendu façon AllTrails)
  let z = 14;
  while (z > 8) {
    const nx = Math.floor(lonToX(lonMax, z)) - Math.floor(lonToX(lonMin, z)) + 1;
    const ny = Math.floor(latToY(latMin, z)) - Math.floor(latToY(latMax, z)) + 1;
    if (nx <= 5 && ny <= 5) break;
    z--;
  }
  const tx0 = Math.floor(lonToX(lonMin, z)), tx1 = Math.floor(lonToX(lonMax, z));
  const ty0 = Math.floor(latToY(latMax, z)), ty1 = Math.floor(latToY(latMin, z));

  // Élévations Terrarium + texture satellite en parallèle
  const [terr, sat] = await Promise.all([
    buildMosaic(
      (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
      z, tx0, tx1, ty0, ty1, 512
    ),
    buildMosaic(
      (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
      z, tx0, tx1, ty0, ty1, TEXTURE_SIZE
    ),
  ]);

  const terrData = terr.ctx.getImageData(0, 0, 512, 512).data;

  // (lat, lon) → pixel de la mosaïque (fraction 0..1 sur l'emprise des tuiles)
  const fx = (lon) => (lonToX(lon, z) - tx0) / Math.max(terr.cols, terr.rows);
  const fy = (lat) => (latToY(lat, z) - ty0) / Math.max(terr.cols, terr.rows);

  function elevationAt(lat, lon) {
    const px = Math.min(511, Math.max(0, Math.round(fx(lon) * 512)));
    const py = Math.min(511, Math.max(0, Math.round(fy(lat) * 512)));
    const i = (py * 512 + px) * 4;
    return terrData[i] * 256 + terrData[i + 1] + terrData[i + 2] / 256 - 32768;
  }

  // Dimensions locales en mètres
  const midLat = (latMin + latMax) / 2;
  const mPerLon = 111320 * Math.cos((midLat * Math.PI) / 180);
  const mPerLat = 110540;
  const width = (lonMax - lonMin) * mPerLon;
  const height = (latMax - latMin) * mPerLat;

  // Scène
  scene = new THREE.Scene();
  scene.background = new THREE.Color(
    document.documentElement.dataset.theme === "dark" ? 0x101510 : 0xdfeaf4
  );

  const geo = new THREE.PlaneGeometry(width, height, TERRAIN_SAMPLES - 1, TERRAIN_SAMPLES - 1);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  let zMin = Infinity;
  for (let iy = 0; iy < TERRAIN_SAMPLES; iy++) {
    for (let ix = 0; ix < TERRAIN_SAMPLES; ix++) {
      const lon = lonMin + (ix / (TERRAIN_SAMPLES - 1)) * (lonMax - lonMin);
      const lat = latMax - (iy / (TERRAIN_SAMPLES - 1)) * (latMax - latMin);
      const i = iy * TERRAIN_SAMPLES + ix;
      const e = elevationAt(lat, lon) * Z_EXAGGERATION;
      pos.setZ(i, e);
      // UV calés sur l'emprise réelle du terrain dans la mosaïque de tuiles
      uv.setXY(i, fx(lon), 1 - fy(lat));
      if (e < zMin) zMin = e;
    }
  }
  geo.computeVertexNormals();

  const texture = new THREE.CanvasTexture(sat.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const terrain = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95, metalness: 0 })
  );
  terrain.rotation.x = -Math.PI / 2;
  scene.add(terrain);
  terrainMesh = terrain;

  // Légère brume d'altitude pour la profondeur
  const span0 = Math.max(width, height);
  scene.fog = new THREE.Fog(scene.background, span0 * 2.2, span0 * 6);

  // Tracé drapé sur le relief
  const toLocal = (lat, lon) => [
    (lon - (lonMin + lonMax) / 2) * mPerLon,
    (lat - (latMin + latMax) / 2) * mPerLat,
  ];
  // Plan tourné de -90° autour de X : le nord local (+y) devient -z dans la scène
  const linePts = track.map(([lat, lon]) => {
    const [x, y] = toLocal(lat, lon);
    return new THREE.Vector3(x, elevationAt(lat, lon) * Z_EXAGGERATION + 25, -y);
  });

  // Tracé en tube 3D : les lignes WebGL font toujours 1 px, un tube reste
  // lisible quelle que soit la distance de la caméra.
  const tubeRadius = Math.max(width, height) / 380;
  const tube = new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(linePts),
      Math.min(linePts.length * 3, 900),
      tubeRadius,
      6,
      false
    ),
    new THREE.MeshBasicMaterial({ color: 0xff2d20 })
  );
  scene.add(tube);
  // Liseré sombre au sol pour le contraste sur les faces claires
  const shadowLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(
      linePts.map((v) => new THREE.Vector3(v.x, v.y - 18, v.z))
    ),
    new THREE.LineBasicMaterial({ color: 0x0a4020, transparent: true, opacity: 0.65 })
  );
  scene.add(shadowLine);

  const mkSphere = (v, color) => {
    const s = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(width, height) / 120, 16, 16),
      new THREE.MeshBasicMaterial({ color })
    );
    s.position.copy(v);
    scene.add(s);
  };
  mkSphere(linePts[0], 0xffffff);
  mkSphere(linePts[linePts.length - 1], 0x101010);

  // Jauge de position : distances cumulées réelles + marqueur mobile
  const cum = [0];
  for (let i = 1; i < track.length; i++) {
    const [la1, lo1] = track[i - 1];
    const [la2, lo2] = track[i];
    const dx = (lo2 - lo1) * mPerLon;
    const dy = (la2 - la1) * mPerLat;
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  const progressMarker = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(width, height) / 80, 20, 20),
    new THREE.MeshBasicMaterial({ color: 0xffd23e })
  );
  progressMarker.position.copy(linePts[0]);
  scene.add(progressMarker);
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(width, height) / 55, 20, 20),
    new THREE.MeshBasicMaterial({ color: 0xffd23e, transparent: true, opacity: 0.25 })
  );
  halo.position.copy(linePts[0]);
  scene.add(halo);
  progress = { pts: linePts, cum, marker: progressMarker, halo };

  // Lumières
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 1.1));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
  sun.position.set(-width, Math.max(width, height), height / 2);
  scene.add(sun);

  // Caméra + rendu
  const rect = container.getBoundingClientRect();
  camera = new THREE.PerspectiveCamera(55, rect.width / rect.height, 10, width * 6);
  const span = Math.max(width, height);
  camera.position.set(0, span * 0.7, span * 0.75);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(rect.width, rect.height);
  container.innerHTML = "";
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, zMin + 200, 0);
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.enableDamping = true;

  const animate = () => {
    rafId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();
}

// f ∈ [0,1] : place le marqueur à cette fraction du tracé,
// renvoie la distance parcourue (km) et l'altitude réelle (m) au point.
export function setProgress(f) {
  if (!progress) return null;
  const { pts, cum, marker, halo } = progress;
  const x = Math.min(Math.max(f, 0), 1) * (pts.length - 1);
  const i = Math.floor(x);
  const j = Math.min(i + 1, pts.length - 1);
  const r = x - i;
  const pos = pts[i].clone().lerp(pts[j], r);
  marker.position.copy(pos);
  halo.position.copy(pos);
  // On ne recentre pas systématiquement : la caméra ne bouge que si la bille
  // sort du cadre ou passe derrière un relief (test d'occlusion par lancer de rayon).
  if (controls && camera) {
    const ndc = pos.clone().project(camera);
    const offScreen = Math.abs(ndc.x) > 0.8 || Math.abs(ndc.y) > 0.8 || ndc.z > 1;
    let occluded = false;
    if (terrainMesh) {
      const toMarker = pos.clone().sub(camera.position);
      const dist = toMarker.length();
      raycaster.set(camera.position, toMarker.normalize());
      raycaster.far = dist;
      const hit = raycaster.intersectObject(terrainMesh, false)[0];
      occluded = !!hit && hit.distance < dist - 50;
    }
    if (offScreen || occluded) {
      // Glissement doux vers le point (sans imposer le centrage permanent)
      const delta = pos.clone().sub(controls.target).multiplyScalar(0.5);
      controls.target.add(delta);
      camera.position.add(delta);
    }
    if (occluded) {
      // Pas de dézoom ni de surélévation : la caméra PIVOTE autour de la cible
      // (rayon et hauteur conservés) jusqu'à dégager la ligne de vue.
      const offset = camera.position.clone().sub(controls.target);
      const up = new THREE.Vector3(0, 1, 0);
      const step = Math.PI / 18; // crans de 10°, en alternant gauche/droite
      for (let k = 1; k <= 36 && occluded; k++) {
        const angle = step * Math.ceil(k / 2) * (k % 2 ? 1 : -1);
        const candidate = controls.target.clone()
          .add(offset.clone().applyAxisAngle(up, angle));
        const toMarker = pos.clone().sub(candidate);
        const dist = toMarker.length();
        raycaster.set(candidate, toMarker.clone().normalize());
        raycaster.far = dist;
        const hit = raycaster.intersectObject(terrainMesh, false)[0];
        if (!hit || hit.distance >= dist - 50) {
          camera.position.copy(candidate);
          occluded = false;
        }
      }
    }
  }
  return {
    km: (cum[i] + (cum[j] - cum[i]) * r) / 1000,
    alt: (pos.y - 25) / Z_EXAGGERATION,
  };
}

export function dispose() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  controls?.dispose();
  controls = null;
  // Libère explicitement la mémoire GPU (géométries, matériaux, textures) : sinon
  // chaque ouverture fuit ~16 Mo de texture + le relief, jamais récupérés.
  scene?.traverse((obj) => {
    obj.geometry?.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    mats.forEach((m) => { m.map?.dispose(); m.dispose(); });
  });
  if (renderer) {
    renderer.dispose();
    // renderer.dispose() NE libère PAS le contexte WebGL : sans forceContextLoss, les
    // contextes s'accumulent jusqu'à la limite du navigateur (~16) qui perd alors le plus
    // ancien → vue noire / « crash ». On le relâche donc à chaque fermeture.
    renderer.forceContextLoss();
    renderer.domElement.remove();
    renderer = null;
  }
  scene = null;
  camera = null;
  progress = null;
  terrainMesh = null;
}
