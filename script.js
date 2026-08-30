import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Reflector } from "three/addons/objects/Reflector.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

/* ======================================================================
   NEO PLAZA NOCTURNA — modelo base 3D
   Escena urbana nocturna estilo "cañón" de plaza publicitaria,
   con letreros de neón, lluvia, calle mojada reflectante y niebla.
   ====================================================================== */

let scene, camera, renderer, controls, composer, clock;
let rainSystem, rainOn = true;
let neonMaterials = [];
let cars = [];
let peds = [];
let autoRotate = false;
let cameraCinematic = null;
const storyFlow = {
  introDone: false,
  storyVisible: false,
  cinematicCompleted: false,
  finalImageShown: false,
  phase: 'intro'
};
window.storyFlow = storyFlow;
const BB_SCALE = 1.28; // makes every billboard more prominent
const ADS_AS_COLOR_BLOCKS = true; // render every billboard as a plain colored rectangle, no text
let leftBuildings = [], rightBuildings = []; // real building geometry, for gluing signs to walls
let adPanels = []; // registry: {id, mesh} for every billboard, so images can be targeted by ID
let panelCounter = 0;
let introScreen, storyOverlay, storyImage, defaultStorySrc, finalStoryUrl, initialCameraPos, initialCameraTarget;

function syncStoryFlow(){
  window.storyFlow = storyFlow;
}

function setStoryOverlayImage(url){
  if (!storyImage) return;

  const nextUrl = url || defaultStorySrc;
  storyImage.style.transition = 'opacity 0.12s ease';
  storyImage.style.opacity = '0';
  storyImage.style.visibility = 'hidden';
  storyOverlay.classList.remove('visible');

  const applyImage = () => {
    storyImage.src = nextUrl;
    const reveal = () => {
      requestAnimationFrame(() => {
        storyImage.style.visibility = 'visible';
        storyImage.style.opacity = '1';
        storyOverlay.classList.add('visible');
      });
    };

    if (storyImage.complete && storyImage.naturalWidth > 0) {
      reveal();
      return;
    }

    storyImage.onload = reveal;
  };

  requestAnimationFrame(applyImage);
}

function showStoryOverlay(url = defaultStorySrc){
  storyFlow.storyVisible = true;
  setStoryOverlayImage(url);
  syncStoryFlow();
}

function hideStoryOverlay(){
  storyFlow.storyVisible = false;
  if (!storyImage) return;
  storyImage.style.transition = 'opacity 0.12s ease';
  storyImage.style.opacity = '0';
  storyImage.style.visibility = 'hidden';
  storyOverlay.classList.remove('visible');
  syncStoryFlow();
}

function startExperience(){
  if (storyFlow.introDone) return;
  storyFlow.introDone = true;
  storyFlow.phase = 'story';
  introScreen.classList.add('hidden');
  syncStoryFlow();
}

function toggleStoryOverlay(forceState){
  if (typeof forceState === 'boolean') {
    storyFlow.storyVisible = forceState;
  } else {
    storyFlow.storyVisible = !storyFlow.storyVisible;
  }
  storyOverlay.classList.toggle('visible', storyFlow.storyVisible);
  syncStoryFlow();
}

function startCameraCinematicToPanel(panelId, duration = 2.4){
  const entry = resolvePanelEntry(panelId);
  if (!entry || !entry.mesh) return;

  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const endTarget = entry.mesh.getWorldPosition(new THREE.Vector3());

  const faceNormal = new THREE.Vector3(0, 0, 1)
    .applyQuaternion(entry.mesh.getWorldQuaternion(new THREE.Quaternion()))
    .normalize();

  // Scale the viewing distance to this panel's own size, so bigger
  // billboards don't end up too zoomed-in (or smaller ones too far away).
  const geoParams = entry.mesh.geometry && entry.mesh.geometry.parameters;
  const panelSize = geoParams ? Math.max(geoParams.width, geoParams.height) : 6;
  let viewDistance = Math.max(9, panelSize * 1.1 + 2);

  // Panels 73 and 19 get a closer, more zoomed-in shot than the rest;
  // panel 19 a bit closer still than panel 73.
  const idNum = (typeof panelId === 'string') ? parseInt(panelId, 10) : panelId;
  if (idNum === 19) {
    viewDistance = Math.max(controls.minDistance + 0.5, viewDistance * 0.55);
  } else if (idNum === 73) {
    viewDistance = Math.max(controls.minDistance + 0.5, viewDistance * 0.65);
  }

  const normalOffset = faceNormal.clone().multiplyScalar(viewDistance);
  const endPos = endTarget.clone()
    .add(normalOffset)
    .add(new THREE.Vector3(0, 0.6, 0));

  // Force a strictly frontal, eye-level view so the billboard is seen head-on.
  const lookAt = endTarget.clone();
  const viewDirection = new THREE.Vector3().subVectors(lookAt, endPos).normalize();
  const desiredUp = new THREE.Vector3(0, 1, 0);
  const frontalQuat = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(endPos, lookAt, desiredUp)
  );
  camera.quaternion.copy(frontalQuat);

  cameraCinematic = {
    startPos,
    startTarget,
    endPos,
    endTarget,
    duration,
    elapsed: 0,
    mode: 'panel',
  };

  controls.enabled = false;
}

function startCameraReturnToOrigin(duration = 2.2){
  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();

  cameraCinematic = {
    startPos,
    startTarget,
    endPos: initialCameraPos.clone(),
    endTarget: initialCameraTarget.clone(),
    duration,
    elapsed: 0,
    mode: 'return',
  };

  controls.enabled = false;
}

// Make scene generation deterministic by replacing Math.random with a
// seedable PRNG. Change `window.SCENE_SEED` to any number to vary layout.
window.SCENE_SEED = window.SCENE_SEED || 1337;
function mulberry32(a){
  return function(){
    var t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}
Math.random = mulberry32(window.SCENE_SEED >>> 0);

init();
buildCity();
animate();

/* ---------------------------- INIT ---------------------------- */
function init(){
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1626);
  scene.fog = new THREE.FogExp2(0x18324f, 0.009);

  camera = new THREE.PerspectiveCamera(52, window.innerWidth/window.innerHeight, 0.1, 400);
  camera.position.set(0, 18, 60);

  renderer = new THREE.WebGLRenderer({ antialias:true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enableZoom = true;
  controls.zoomSpeed = 1.1;
  controls.minDistance = 8;
  controls.maxDistance = 160;
  controls.maxPolarAngle = Math.PI/2 - 0.02;
  controls.target.set(0, 15, -40);
  controls.autoRotate = false;
  controls.autoRotateSpeed = 0.55;
  controls.addEventListener('start', ()=>{ /* keep autorotate flag independent */ });

  clock = new THREE.Clock();

  // Lights
  const hemi = new THREE.HemisphereLight(0x4a7aa8, 0x1a2a3a, 1.35);
  scene.add(hemi);

  const fill = new THREE.AmbientLight(0x4a6a8a, 0.7);
  scene.add(fill);

  const moon = new THREE.DirectionalLight(0x9fc8ff, 0.75);
  moon.position.set(-30, 40, -20);
  moon.castShadow = true;
  moon.shadow.mapSize.set(1024,1024);
  moon.shadow.camera.left = -40;
  moon.shadow.camera.right = 40;
  moon.shadow.camera.top = 40;
  moon.shadow.camera.bottom = -40;
  scene.add(moon);

  // Post-processing (bloom for neon glow)
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.38, 0.7, 0.18);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  window.addEventListener('resize', onResize);

  const updateFullscreenCursor = () => {
    const active = !!document.fullscreenElement || !!document.webkitFullscreenElement;
    document.body.classList.toggle('fullscreen-active', active);
    document.documentElement.classList.toggle('fullscreen-active', active);
  };

  document.addEventListener('fullscreenchange', updateFullscreenCursor);
  document.addEventListener('webkitfullscreenchange', updateFullscreenCursor);
  updateFullscreenCursor();

  introScreen = document.getElementById('intro-screen');
  storyOverlay = document.getElementById('story-overlay');
  storyImage = storyOverlay.querySelector('img');
  defaultStorySrc = storyImage ? storyImage.src : '';
  finalStoryUrl = 'https://cdn.phototourl.com/free/2026-08-29-8edc7eea-283e-4aed-abab-f6c05c4db1a2.png';
  initialCameraPos = camera.position.clone();
  initialCameraTarget = controls.target.clone();

  // Preload every narrative overlay image right away so they're already
  // cached by the browser and appear instantly when their cinematic ends,
  // instead of only starting to download at that moment.
  [
    finalStoryUrl,
    'https://cdn.phototourl.com/member/2026-08-29-79f8de58-ebee-42aa-ba13-407e39ab6e53.png',
    'https://cdn.phototourl.com/member/2026-08-29-4e2acc6f-d008-4dc9-8b22-e30aad3421ad.png',
  ].forEach(url => { const preload = new Image(); preload.src = url; });

  const toggleFullscreen = () => {
    const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsElement) {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      return;
    }

    const target = document.documentElement;
    if (target.requestFullscreen) target.requestFullscreen();
    else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen();
  };

  window.addEventListener('keydown', (event) => {
    if (event.repeat) return;

    if (event.code === 'KeyF' || event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      toggleFullscreen();
      return;
    }

    if (event.code === 'Space' || event.key === 'ArrowRight' || event.key === 'Right') {
      if (!storyFlow.introDone) {
        startExperience();
        return;
      }

      if (cameraCinematic) {
        return;
      }

      if (storyFlow.phase === 'panel-41-cinematic') {
        return;
      }

      if (storyFlow.phase === 'panel-41-done') {
        startCameraReturnToOrigin(1.9);
        storyFlow.phase = 'panel-41-return';
        storyFlow.cinematicCompleted = false;
        syncStoryFlow();
        return;
      }

      if (storyFlow.phase === 'panel-28-cinematic') {
        return;
      }

      if (storyFlow.phase === 'panel-28-done') {
        startCameraReturnToOrigin(1.9);
        storyFlow.phase = 'panel-28-return';
        storyFlow.cinematicCompleted = false;
        syncStoryFlow();
        return;
      }

      if (storyFlow.phase === 'panel-41-epilogue') {
        hideStoryOverlay();
        storyFlow.cinematicCompleted = false;
        storyFlow.phase = 'panel-28-cinematic';
        startCameraCinematicToPanel(28, 2.2);
        syncStoryFlow();
        return;
      }

      if (storyFlow.phase === 'panel-19-cinematic') {
        return;
      }

      if (storyFlow.phase === 'panel-19-done') {
        startCameraReturnToOrigin(1.9);
        storyFlow.phase = 'panel-19-return';
        storyFlow.cinematicCompleted = false;
        syncStoryFlow();
        return;
      }

      if (storyFlow.phase === 'panel-28-epilogue') {
        hideStoryOverlay();
        storyFlow.cinematicCompleted = false;
        storyFlow.phase = 'panel-19-cinematic';
        startCameraCinematicToPanel(19, 2.2);
        syncStoryFlow();
        return;
      }

      if (storyFlow.phase === 'final-image') {
        hideStoryOverlay();
        storyFlow.finalImageShown = false;
        storyFlow.storyVisible = false;
        storyFlow.cinematicCompleted = false;
        storyFlow.phase = 'panel-41-cinematic';
        startCameraCinematicToPanel(41, 2.2);
        syncStoryFlow();
        return;
      }

      if (storyFlow.finalImageShown && storyFlow.phase !== 'final-image') {
        return;
      }

      if (storyFlow.phase === 'story') {
        showStoryOverlay();
        storyFlow.phase = 'story-visible';
        syncStoryFlow();
        return;
      }

      if (storyFlow.phase === 'story-visible') {
        hideStoryOverlay();
        storyFlow.phase = 'panel-cinematic';
        storyFlow.cinematicCompleted = false;
        startCameraCinematicToPanel(73, 2.2);
        syncStoryFlow();
        return;
      }

      if (storyFlow.phase === 'panel-cinematic' && storyFlow.cinematicCompleted) {
        startCameraReturnToOrigin(1.9);
        storyFlow.phase = 'return-cinematic';
        storyFlow.cinematicCompleted = false;
        syncStoryFlow();
      }
    }
  });

  renderer.domElement.addEventListener('click', () => {
    if (!storyFlow.introDone) {
      startExperience();
    }
  });
}

function onResize(){
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
}

/* ---------------------- CANVAS TEXTURE HELPERS ---------------------- */

function makeCanvas(w,h){
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function roundRect(ctx,x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}

// Building facade with lit windows
function windowTexture(cols, rows, baseColor, litColor, litRatio){
  const c = makeCanvas(256,384);
  const ctx = c.getContext('2d');
  ctx.fillStyle = baseColor;
  ctx.fillRect(0,0,c.width,c.height);
  const cw = c.width/cols, rh = c.height/rows;
  for(let y=0;y<rows;y++){
    for(let x=0;x<cols;x++){
      const lit = Math.random() < litRatio;
      ctx.fillStyle = lit ? litColor : 'rgba(255,255,255,0.03)';
      const pad = cw*0.22;
      ctx.fillRect(x*cw+pad, y*rh+pad*1.3, cw-pad*2, rh-pad*2.2);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Neon sign texture generator
function neonSignTexture({w=512,h=512,bg='#050505',text='',sub='',fg='#ffffff',accent='#20e8ff',shape='panel',fontSize=110}){
  const c = makeCanvas(w,h);
  const ctx = c.getContext('2d');

  // background
  ctx.fillStyle = bg;
  ctx.fillRect(0,0,w,h);

  if(ADS_AS_COLOR_BLOCKS){
    // Plain colored rectangle, no text — solid block of the accent color
    ctx.fillStyle = accent;
    ctx.fillRect(0,0,w,h);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  if(shape==='circle'){
    const r = Math.min(w,h)*0.42;
    ctx.save();
    ctx.beginPath();
    ctx.arc(w/2,h/2,r,0,Math.PI*2);
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 35;
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#ffffff';
    ctx.font = `900 ${fontSize}px 'Segoe UI', sans-serif`;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(text, w/2, h/2 + 6);
  } else if (shape==='camera'){
    // phone-style ad: dark panel + circular lens glow
    ctx.fillStyle = '#0c0d10';
    ctx.fillRect(0,0,w,h);
    ctx.beginPath();
    ctx.arc(w*0.5,h*0.38,h*0.16,0,Math.PI*2);
    ctx.fillStyle = '#1a1c22';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(w*0.5,h*0.38,h*0.09,0,Math.PI*2);
    const grad = ctx.createRadialGradient(w*0.5,h*0.38,4,w*0.5,h*0.38,h*0.09);
    grad.addColorStop(0,'#bfe9ff');
    grad.addColorStop(1,'#1b3550');
    ctx.fillStyle = grad;
    ctx.shadowColor = accent; ctx.shadowBlur = 20;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle='#ffffff';
    ctx.font = `700 ${fontSize*0.55}px 'Segoe UI', sans-serif`;
    ctx.textAlign='center';
    ctx.fillText(text, w/2, h*0.72);
  } else {
    // panel with border glow
    ctx.fillStyle = bg;
    ctx.fillRect(0,0,w,h);
    ctx.strokeStyle = accent;
    ctx.lineWidth = w*0.02;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 30;
    roundRect(ctx, w*0.04,h*0.04,w*0.92,h*0.92, w*0.03);
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${fontSize}px 'Segoe UI', sans-serif`;
    ctx.shadowColor = fg; ctx.shadowBlur = 10;
    wrapText(ctx, text, w/2, sub? h*0.42 : h/2, w*0.86, fontSize*1.05);
    if(sub){
      ctx.font = `700 ${fontSize*0.32}px 'Segoe UI', sans-serif`;
      ctx.fillStyle = accent;
      ctx.shadowColor = accent;
      wrapText(ctx, sub, w/2, h*0.72, w*0.86, fontSize*0.4);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function wrapText(ctx,text,x,y,maxWidth,lineHeight){
  const words = text.split(' ');
  let line='', lines=[];
  for(let n=0;n<words.length;n++){
    const test = line + words[n] + ' ';
    if(ctx.measureText(test).width > maxWidth && n>0){
      lines.push(line); line = words[n]+' ';
    } else { line = test; }
  }
  lines.push(line);
  const startY = y - (lines.length-1)*lineHeight/2;
  lines.forEach((l,i)=> ctx.fillText(l.trim(), x, startY + i*lineHeight));
}

function verticalSignTexture(text, bg, accent){
  const w=128,h=768;
  const c = makeCanvas(w,h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0,0,w,h);

  if(ADS_AS_COLOR_BLOCKS){
    ctx.fillStyle = accent;
    ctx.fillRect(0,0,w,h);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  ctx.strokeStyle = accent;
  ctx.lineWidth = 6;
  ctx.shadowColor = accent; ctx.shadowBlur = 24;
  roundRect(ctx,8,8,w-16,h-16,14);
  ctx.stroke();
  ctx.shadowBlur=0;
  ctx.save();
  ctx.translate(w/2,h/2);
  ctx.rotate(-Math.PI/2);
  ctx.fillStyle='#ffffff';
  ctx.font = `900 64px 'Segoe UI', sans-serif`;
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.shadowColor='#ffffff'; ctx.shadowBlur=18;
  ctx.fillText(text,0,0);
  ctx.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ---------------------------- CITY BUILD ---------------------------- */

function buildCity(){
  buildGround();
  buildStreetProps();
  buildBuildingCanyon();
  buildCentralTower();
  buildBillboards();
  // After all panels are created, assign deterministic IDs so numbers
  // remain stable for this scene generation (ordered by z, then x).
  normalizePanelIds();
  buildRain();
  buildTraffic();
  buildPedestrians();
}

// Assign deterministic, reproducible IDs to panels based on world position.
// This replaces the runtime creation-order IDs which could vary.
function normalizePanelIds(){
  if(!adPanels || adPanels.length===0) return;

  // Assign a deterministic two-digit ID (01..99) derived from position.
  // If collisions occur, use a deterministic linear probe. If there are
  // more than 99 panels, IDs will repeat deterministically (unlikely).
  const used = new Set();
  const STORAGE_KEY = 'panelIdMap_v1';
  let panelIdMap = {};
  try{ panelIdMap = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }catch(e){ panelIdMap = {}; }
  function stableIdFromMesh(mesh){
    const x = Math.round(mesh.position.x * 100);
    const y = Math.round(mesh.position.y * 100);
    const z = Math.round(mesh.position.z * 100);
    const key = `${x},${y},${z}`;
    // FNV-1a 32-bit hash (deterministic)
    let h = 2166136261 >>> 0;
    for(let i=0;i<key.length;i++){
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    // Map into 1..99 (two-digit space)
    return (h % 99) + 1;
  }

  let maxAssigned = 0;
  for(const entry of adPanels){
    const mesh = entry.mesh;
    const x = Math.round(mesh.position.x * 100);
    const y = Math.round(mesh.position.y * 100);
    const z = Math.round(mesh.position.z * 100);
    const key = `${x},${y},${z}`;

    let id;
    if(panelIdMap[key]){
      id = panelIdMap[key];
    } else {
      id = stableIdFromMesh(entry.mesh);
      const start = id;
      while(used.has(id)){
        id = (id % 99) + 1;
        if(id === start){
          console.warn('Todos los IDs de dos dígitos están ocupados — se repetirán IDs de forma determinista.');
          break;
        }
      }
      panelIdMap[key] = id;
    }
    used.add(id);
    entry.id = id;
    entry.mesh.userData.panelId = id;
    // update the small id label texture
    const label = entry.mesh.children[0];
    if(label && label.material){
      label.material.map = idLabelTexture(id);
      label.material.needsUpdate = true;
      label.visible = true;
    }
    if(id > maxAssigned) maxAssigned = id;
  }
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(panelIdMap)); }catch(e){ /* ignore storage errors */ }
  panelCounter = Math.max(panelCounter || 0, maxAssigned);
}

/* -------- Reusable neon-panel helper (bigger, with glow backing) -------- */

function glowTexture(color){
  const c = makeCanvas(256,256);
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(128,128,0,128,128,128);
  grad.addColorStop(0, color);
  grad.addColorStop(0.55, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0,0,256,256);
  return new THREE.CanvasTexture(c);
}

// Small numbered chip drawn in a corner of a color-block panel, so you can
// identify which square is which when you go to swap in a real image later.
function idLabelTexture(id){
  const c = makeCanvas(128,128);
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,128,128);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  roundRect(ctx, 4,4,120,120,18);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 52px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Ensure IDs are always two digits (01, 02, ...)
  ctx.fillText(String(id).padStart(2, '0'), 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function addPanel(group, {x,y,z,ry,w,h,tex,glow}){
  const W = w*BB_SCALE, H = h*BB_SCALE;

  let halo = null;
  // soft glow halo behind the panel so it reads brightly even from afar
  if(glow){
    const haloMat = new THREE.MeshBasicMaterial({
      map: glowTexture(glow), transparent:true, opacity:0.12,
      blending: THREE.AdditiveBlending, depthWrite:false, toneMapped:false
    });
    halo = new THREE.Mesh(new THREE.PlaneGeometry(W*2,H*2), haloMat);
    halo.position.set(x,y,z);
    halo.rotation.y = ry;
    halo.translateZ(-0.35);
    group.add(halo);
  }

  const mat = new THREE.MeshBasicMaterial({ map:tex, toneMapped:false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W,H), mat);
  mesh.position.set(x,y,z);
  mesh.rotation.y = ry;
  group.add(mesh);
  neonMaterials.push(mat);

  // Give this panel an ID and register it so an image can be dropped onto
  // it later, e.g. from the console: setPanelImage(7, "https://...jpg")
  panelCounter++;
  const id = panelCounter;
  mesh.userData.panelId = id;
  // store the original material map so we can restore it later
  adPanels.push({ id, mesh, halo, originalMap: mat.map });

  if(ADS_AS_COLOR_BLOCKS){
    const labelSize = Math.min(W,H)*0.34;
    const labelMat = new THREE.MeshBasicMaterial({
      map: idLabelTexture(id), transparent:true, depthWrite:false, toneMapped:false
    });
    const label = new THREE.Mesh(new THREE.PlaneGeometry(labelSize, labelSize), labelMat);
    // positioned in the panel's own local space (top-left corner), so it
    // stays correct no matter which way the panel is rotated
    label.position.set(-W/2 + labelSize/2 + W*0.04, H/2 - labelSize/2 - H*0.04, 0.03);
    mesh.add(label);
  }

  return mesh;
}

// Call from the browser console (or from your own code) to replace a
// color-block panel with a real image, once you know which ID you want:
//   setPanelImage(7, "https://example.com/my-ad.jpg")
// The panel keeps its size and position — only the picture changes, and
// its ID number chip is hidden automatically once an image is applied.
const _panelTexLoader = new THREE.TextureLoader();
// Helper: resolve a panel entry by numeric ID or two-digit string ("07").
function resolvePanelEntry(idInput){
  if(idInput === undefined || idInput === null) return null;
  // accept numeric or string like "07" or "7"
  const n = (typeof idInput === 'string') ? parseInt(idInput, 10) : idInput;
  if(!Number.isNaN(n)){
    return adPanels.find(p => p.id === n || (p.mesh && p.mesh.userData && p.mesh.userData.panelId === n)) || null;
  }
  // fallback: compare padded strings
  const s = String(idInput).padStart(2,'0');
  return adPanels.find(p => String(p.id).padStart(2,'0') === s) || null;
}

function nearestWallX(list, z, side){
  if(!list || !list.length) return 0;
  let best = list[0], bestD = Infinity;
  for(const b of list){
    const d = Math.abs(b.z - z);
    if(d < bestD){ bestD = d; best = b; }
  }
  const faceX = best.x + side*(best.width/2);
  return faceX + side*0.08;
}

function movePanelToBuilding(id, side, z, y){
  const entry = resolvePanelEntry(id);
  if(!entry) return false;
  const list = side === -1 ? rightBuildings : leftBuildings;
  const x = nearestWallX(list, z, side);

  entry.mesh.position.set(x, y, z);
  entry.mesh.rotation.y = side === -1 ? -Math.PI/2 : Math.PI/2;

  if(entry.halo){
    entry.halo.position.set(x, y, z);
    entry.halo.rotation.y = entry.mesh.rotation.y;
    entry.halo.translateZ(-0.35);
  }

  return true;
}

window.movePanelToBuilding = movePanelToBuilding;

window.setPanelImage = function(id, url){
  const entry = resolvePanelEntry(id);
  if(!entry){
    console.warn('No existe ningun panel con id', id, '— IDs validos van de 1 a', panelCounter);
    return;
  }
  _panelTexLoader.load(url, (imgTex)=>{
    imgTex.colorSpace = THREE.SRGBColorSpace;
    imgTex.wrapS = THREE.ClampToEdgeWrapping;
    imgTex.wrapT = THREE.ClampToEdgeWrapping;
    imgTex.repeat.set(1, 1);
    imgTex.offset.set(0, 0);
    entry.mesh.material.map = imgTex;
    entry.mesh.material.needsUpdate = true;
    const label = entry.mesh.children[0];
    if(label) label.visible = false;
  }, undefined, (err)=>{
    console.error('No se pudo cargar la imagen para el panel', id, err);
  });
};
window.listPanels = function(){
  console.log('Paneles disponibles: 1 a', panelCounter);
};

// Imagen solicitada para el cuadro 24 (incrustada en base64, sin depender de un servidor externo)
const PANEL_24_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAeAAAAJYCAIAAAA1x6JHAAAQAElEQVR4Aex8BcBlR3X/78zMlSefrbtvXCBClLhghbZ4oaW0/HEp0EKBFrdgxQIJMWJAoUJLqVE8uBcCISGySdbtk2f33pH/b97b3WySDSQtlGzybs69b+7MmTPn/M6ZM3PnW1A3NZcNaYjAEIEhAkME7ocIKAyvIQJDBIYIDBG4XyIwTND3S7cMlRoiMETgVyLwIGAYJugHgZOHJg4RGCKwfyIwTND7p9+GWg8RGCLwIEBgmKAfBE4emvhgRGBo8wMBgWGCfiB4cWjDEIEhAg9IBIYJ+gHp1qFRQwSGCDwQEBgm6AeCF4c23FcEhvxDBPYLBIYJer9w01DJIQJDBB6MCAwT9IPR60ObhwgMEdgvEBgm6P3CTf+3Sg5HGyIwROD+gcAwQd8//DDUYojAEIEhAndDYJig7wbJsGKIwBCBIQL3DwSGCfq++mHIP0RgiMAQgf8jBIYJ+v8I6OEwQwSGCAwRuK8IDBP0fUVsyD9EYIjAEIH/IwR+zQn6/0jr4TBDBIYIDBF4ECAwTNAPAicPTRwiMERg/0RgmKD3T78NtR4iMETg14zA/VHcMEHfH70y1GmIwBCBIQJEYJigCcKQhggMERgicH9EYJig749eGeo0ROD+hsBQn98KAsME/VuBfTjoEIEhAkMEfjUCwwT9qzEacgwRGCIwROC3gsAwQf9WYB8O+sBCYGjNEIHfDALDBP2bwXUodYjAEIEhAv9rBIYJ+n8N4VDAEIEhAkMEfjMIDBP0bwbXodQ7EBiWhggMEfgfIjBM0P9D4IbdhggMERgi8JtGYJigf9MID+UPERgiMETgf4jAMEH/D4H7dXUbyhkiMERgiMA9ITBM0PeEzLB+iMAQgSECv2UEhgn6t+yA4fBDBIYIDBG4JwTu3wn6nrQe1g8RGCIwROBBgMAwQT8InDw0cYjAEIH9E4Fhgt4//TbUeojAEIH7NwK/Fu2GCfrXAuNQyBCBIQJDBH79CAwT9K8f06HEIQJDBIYI/FoQGCboXwuMQyFDBIYI3BcEhrz3DoFhgr53OA25hggMERgi8H+OwDBB/59DPhxwiMAQgSEC9w6BYYK+dzgNuYYI/N8hMBxpiMAuBIYJehcQw58hAkMEhgjc3xAYJuj7m0eG+gwRGCIwRGAXAsMEvQuI4c/+gsBQzyECDx4Ehgn6weProaVDBIYI7GcIDBP0fuawobpDBIYIPHgQGCboB5avh9YMERgi8ABCYJigH0DOHJoyRGCIwAMLgWGCfmD5c2jNEIEhAg8gBB5UCfoB5LehKUMEhgg8CBAYJugHgZOHJg4RGCKwfyIwTND7p9+GWg8RGCLwIEDgjgT9IDB2aOIQgSECQwT2JwSGCXp/8tZQ1yECQwQeVAgME/SDyt1DY4cIPCAReMAaNUzQD1jXDg0bIjBEYH9HYJig93cPDvUfIjBE4AGLwDBBP2BdOzRsiMAAgeFz/0VgmKD3X98NNR8iMETgAY7AMEE/wB08NG+IwBCB/ReBYYLef3031PzXgcBQxhCB+zECwwR9P3bOULUhAkMEHtwIDBP0g9v/Q+uHCAwRuB8jMEzQ92Pn/PZVG2owRGCIwG8TgWGC/m2iPxx7iMAQgSECvwSBYYL+JeAMm4YIDBEYIvDbRGCYoP/n6A97DhEYIjBE4DeKwDBB/0bhHQofIjBEYIjA/xyBYYL+n2M37DlEYIjAEIHfKAK/sQT9G9V6KHyIwBCBIQIPAgSGCfpB4OShiUMEhgjsnwgME/T+6beh1kMEhgj8xhC4/wgeJuj7jy+GmgwRGCIwROBOCAwT9J3gGL4MERgiMETg/oPAMEHff3wx1GSIwP6AwFDH/0MEhgn6/xDs4VBDBIYIDBG4LwgME/R9QWvIO0RgiMAQgf9DBIYJ+v8Q7OFQD3wEhh";
// Imagen del cuadro 24 removida intencionalmente.
// setPanelImage(24, PANEL_24_IMAGE);

// Assign an image to a panel and fit it using a cover-style crop so the
// billboard is filled without stretching (keeps image centered).
window.setPanelImageFit = function(id, url){
  const entry = resolvePanelEntry(id);
  if(!entry){
    console.warn('No existe ningun panel con id', id, '— IDs validos van de 1 a', panelCounter);
    return;
  }
  _panelTexLoader.load(url, (imgTex)=>{
    imgTex.colorSpace = THREE.SRGBColorSpace;

    // Determine panel geometry size (PlaneGeometry parameters are available)
    const mesh = entry.mesh;
    let pw = 1, ph = 1;
    if(mesh.geometry && mesh.geometry.parameters && mesh.geometry.parameters.width && mesh.geometry.parameters.height){
      pw = mesh.geometry.parameters.width;
      ph = mesh.geometry.parameters.height;
    } else {
      pw = mesh.scale.x || 1;
      ph = mesh.scale.y || 1;
    }

    const panelAspect = pw / ph;
    const imgW = (imgTex.image && imgTex.image.width) || 1;
    const imgH = (imgTex.image && imgTex.image.height) || 1;
    const imgAspect = imgW / imgH;

    // Use cover behavior: crop the longer axis so the panel is fully filled.
    imgTex.wrapS = THREE.ClampToEdgeWrapping;
    imgTex.wrapT = THREE.ClampToEdgeWrapping;
    if(imgAspect > panelAspect){
      // image is wider — crop horizontally
      const rx = panelAspect / imgAspect;
      imgTex.repeat.set(rx, 1);
      imgTex.offset.set((1 - rx)/2, 0);
    } else {
      // image is taller — crop vertically
      const ry = imgAspect / panelAspect;
      imgTex.repeat.set(1, ry);
      imgTex.offset.set(0, (1 - ry)/2);
    }

    entry.mesh.material.map = imgTex;
    entry.mesh.material.needsUpdate = true;
    const label = entry.mesh.children[0];
    if(label) label.visible = false;
  }, undefined, (err)=>{
    console.error('No se pudo cargar la imagen para el panel', id, err);
  });
};

window.setPanelImageContain = function(id, url){
  const entry = resolvePanelEntry(id);
  if(!entry){
    console.warn('No existe ningun panel con id', id, '— IDs validos van de 1 a', panelCounter);
    return;
  }
  _panelTexLoader.load(url, (imgTex)=>{
    imgTex.colorSpace = THREE.SRGBColorSpace;
    imgTex.wrapS = THREE.ClampToEdgeWrapping;
    imgTex.wrapT = THREE.ClampToEdgeWrapping;
    imgTex.repeat.set(1, 1);
    imgTex.offset.set(0, 0);
    imgTex.center.set(0, 0);

    entry.mesh.material.map = imgTex;
    entry.mesh.material.needsUpdate = true;
    const label = entry.mesh.children[0];
    if(label) label.visible = false;
  }, undefined, (err)=>{
    console.error('No se pudo cargar la imagen para el panel', id, err);
  });
};
// Helpers to clear images and restore original color-blocks
window.clearPanelImage = function(id){
  const entry = resolvePanelEntry(id);
  if(!entry) return;
  entry.mesh.material.map = entry.originalMap || idLabelTexture(entry.id);
  entry.mesh.material.needsUpdate = true;
  const label = entry.mesh.children[0];
  if(label) label.visible = true;
};

window.clearAllPanelImages = function(){
  adPanels.forEach(entry=>{
    entry.mesh.material.map = entry.originalMap || idLabelTexture(entry.id);
    entry.mesh.material.needsUpdate = true;
    const label = entry.mesh.children[0];
    if(label) label.visible = true;
  });
};

// Remove images from all panels, then apply the requested images to the relevant panels.
window.clearAllPanelImages();
window.setPanelImage(19, "https://i.postimg.cc/x8DSbLfh/imagen-2026-08-29-001734402.png");
window.setPanelImageFit(28, "https://i.postimg.cc/kMk2Zj16/imagen-2026-08-29-183707620.png");
window.setPanelImage(41, "https://i.postimg.cc/wjz7x1d8/imagen-2026-08-29-183741864.png");
window.setPanelImageFit(52, "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTI4xZ9kDUu4phler2R-EHHyBiZ2DAHvoI4D1OKziQPbkroHnnlLhtrL86L&s=10");
window.setPanelImageFit(73, "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcR6hnbadu0mW0qWu4oOX1LTI9Gjkhqt_DazMc7_YVwovg&s=10");
window.setPanelImageContain(66, "https://crehana-blog.imgix.net/media/filer_public/90/83/9083027a-fc03-4e3f-8f55-636ffce6d36c/mcdonalds-happy-meal.jpg?auto=format&q=50");

// Reubicar los paneles que estaban chocando en otras fachadas del mismo conjunto urbano.
window.movePanelToBuilding(40, 1, 18, 12);
window.movePanelToBuilding(41, 1, 30, 16);
window.movePanelToBuilding(87, -1, 26, 18);
window.movePanelToBuilding(94, -1, 42, 22);

function buildCentralTower(){
  // The big front-and-center tower the whole avenue funnels toward,
  // carrying the largest, most legible stack of ads.
  const height = 64, width = 17, depth = 13;
  const cz = -46;

  const towerWinTex = windowTexture(12, Math.floor(height*1.6), '#0a0f16', '#ffe6b8', 0.32);
  towerWinTex.repeat.set(3, Math.round(height/9));
  const towerMat = new THREE.MeshStandardMaterial({ color:0x11161f, map: towerWinTex, roughness:0.82, metalness:0.18 });
  const tower = new THREE.Mesh(new THREE.BoxGeometry(width,height,depth), towerMat);
  tower.position.set(0, height/2, cz);
  tower.castShadow = true;
  tower.receiveShadow = true;
  scene.add(tower);

  // a stepped base so it doesn't look like a flat slab
  const baseMat = new THREE.MeshStandardMaterial({ color:0x0d141c, roughness:0.75 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(width+3, 9, depth+3), baseMat);
  base.position.set(0, 4.5, cz+0.5);
  base.castShadow = true; base.receiveShadow = true;
  scene.add(base);

  const bbCenter = new THREE.Group();
  scene.add(bbCenter);
  const frontZ = cz + depth/2 + 0.15;

  addPanel(bbCenter, { x:0, y:53, z:frontZ, ry:0, w:9.5, h:4.4, glow:'#ff5566',
    tex:neonSignTexture({ text:'AXIS', sub:'NEWS NETWORK · LIVE', bg:'#7a0d16', accent:'#ff5566', fontSize:140 }) });

  addPanel(bbCenter, { x:0, y:45.5, z:frontZ, ry:0, w:9.5, h:6.2, glow:'#5ec9ff',
    tex:neonSignTexture({ shape:'camera', text:'NOVA S1', accent:'#5ec9ff', fontSize:95 }) });

  addPanel(bbCenter, { x:-3.6, y:36.5, z:frontZ, ry:0, w:4.8, h:5.6, glow:'#5cff8f',
    tex:neonSignTexture({ text:'SPUD', sub:'RUSH · LATER', bg:'#0c3d1f', accent:'#5cff8f', fontSize:120 }) });

  addPanel(bbCenter, { x:3.6, y:36.5, z:frontZ, ry:0, w:4.8, h:5.6, glow:'#5cff8f',
    tex:neonSignTexture({ text:'SPUD', sub:'RUSH · LATER', bg:'#0c3d1f', accent:'#5cff8f', fontSize:120 }) });

  addPanel(bbCenter, { x:0, y:28, z:frontZ, ry:0, w:9.8, h:6.6, glow:'#ff4d4d',
    tex:neonSignTexture({ text:'KOI', sub:'COLA', bg:'#7a0f12', accent:'#ff4d4d', fontSize:170 }) });

  addPanel(bbCenter, { x:0, y:18.8, z:frontZ, ry:0, w:9.4, h:5.2, glow:'#ff2d7a',
    tex:neonSignTexture({ shape:'circle', text:'ZX', accent:'#ff2d7a', fontSize:210 }) });

  // wraparound side faces so the tower still reads from an angle
  addPanel(bbCenter, { x:-8.6, y:26, z:cz-4, ry:Math.PI/2, w:6.4, h:9.6, glow:'#4de0ff',
    tex:neonSignTexture({ text:'POLAR', sub:'M A R T', bg:'#062230', accent:'#4de0ff', fontSize:120 }) });

  addPanel(bbCenter, { x:8.6, y:26, z:cz-4, ry:-Math.PI/2, w:2.6, h:15,
    tex:verticalSignTexture('ORBIT HOTEL', '#07141c', '#20e8ff') });

  // strong colored spotlights so the tower dominates the vista
  const spots = [
    { c:0xff2d7a, p:[0, 19, frontZ+1.5] },
    { c:0xff4d4d, p:[0, 28, frontZ+1.5] },
    { c:0x5cff8f, p:[0, 37, frontZ+1.5] },
    { c:0x5ec9ff, p:[0, 46, frontZ+1.5] },
    { c:0xff5566, p:[0, 53, frontZ+1.5] },
  ];
  spots.forEach(s=>{
    const l = new THREE.PointLight(s.c, 6, 34, 2);
    l.position.set(...s.p);
    scene.add(l);
  });
}

function buildGround(){
  // Reflective wet asphalt
  const geo = new THREE.PlaneGeometry(70, 140);
  const reflector = new Reflector(geo, {
    clipBias: 0.003,
    textureWidth: window.innerWidth * window.devicePixelRatio,
    textureHeight: window.innerHeight * window.devicePixelRatio,
    color: 0x0a0f14,
  });
  reflector.rotation.x = -Math.PI/2;
  reflector.position.y = 0;
  scene.add(reflector);

  // Dark translucent overlay to mute reflection + add asphalt texture feel
  const overlay = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color:0x050a0f, roughness:0.55, metalness:0.1, transparent:true, opacity:0.55 })
  );
  overlay.rotation.x = -Math.PI/2;
  overlay.position.y = 0.01;
  overlay.receiveShadow = true;
  scene.add(overlay);

  // Sidewalks
  const sidewalkMat = new THREE.MeshStandardMaterial({ color:0x1b232b, roughness:0.9 });
  [-1,1].forEach(side=>{
    const sw = new THREE.Mesh(new THREE.BoxGeometry(6,0.25,140), sidewalkMat);
    sw.position.set(side*13, 0.12, 0);
    sw.receiveShadow = true;
    scene.add(sw);
  });

  // Lane markings
  const laneMat = new THREE.MeshBasicMaterial({ color:0xffcf4d, transparent:true, opacity:0.4 });
  for(let z=-60;z<60;z+=6){
    const seg = new THREE.Mesh(new THREE.PlaneGeometry(0.25,3), laneMat);
    seg.rotation.x = -Math.PI/2;
    seg.position.set(0, 0.03, z);
    scene.add(seg);
  }
}

function buildStreetProps(){
  const postMat = new THREE.MeshStandardMaterial({ color:0x111417, roughness:0.4, metalness:0.7 });
  for(let side of [-1,1]){
    for(let z=-50; z<=50; z+=17){
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09,0.12,5.4,8), postMat);
      post.position.set(side*10.4, 2.7, z);
      post.castShadow = true;
      scene.add(post);

      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.06,1.6,6), postMat);
      arm.rotation.z = Math.PI/2;
      arm.position.set(side*10.4 - side*0.8, 5.3, z);
      scene.add(arm);

      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.16,10,10),
        new THREE.MeshBasicMaterial({ color:0xffdca3 })
      );
      bulb.position.set(side*10.4 - side*1.6, 5.2, z);
      scene.add(bulb);

      const lamp = new THREE.PointLight(0xffb877, 13, 20, 2);
      lamp.position.copy(bulb.position);
      scene.add(lamp);
    }
  }
}

function buildBuildingCanyon(){
  const facadeColors = [0x0c1420,0x0e1522,0x0a121c,0x101826,0x0b131e];
  const litColors = ['#ffd98a','#8ad9ff','#ffe9c4'];

  // extra fictional-brand ad panels scattered across the canyon buildings
  const adPalette = [
    {text:'NEBULA', sub:'PHONES · 5G',      bg:'#1a063d', accent:'#b388ff'},
    {text:'ECHO',   sub:'AUDIO GEAR',       bg:'#052b2b', accent:'#33ffe0'},
    {text:'RIFT',   sub:'STREAMING',        bg:'#3d0a1a', accent:'#ff3d7a'},
    {text:'ORCA',   sub:'BANK',             bg:'#04182b', accent:'#4dc3ff'},
    {text:'VOLT',   sub:'ENERGY DRINK',     bg:'#2b1a03', accent:'#ffb84d'},
    {text:'LUMEN',  sub:'SKIN CARE',        bg:'#2b0522', accent:'#ff7ad9'},
    {text:'HAZE',   sub:'SNEAKERS',         bg:'#0a2b12', accent:'#7dffb0'},
    {text:'PULSE',  sub:'FITNESS APP',      bg:'#241305', accent:'#ffd24d'},
    {text:'DRIFT',  sub:'RIDE SHARE',       bg:'#0a1a2b', accent:'#4de0ff'},
    {text:'ZEN',    sub:'NOODLE BAR',       bg:'#1f0a04', accent:'#ff8a4d'},
    {text:'GRID',   sub:'ELECTRIC MOTORS',  bg:'#031a12', accent:'#4dffb0'},
    {text:'IRIS',   sub:'EYEWEAR',          bg:'#0d0d2b', accent:'#8ab0ff'},
    {text:'KESTREL',sub:'AIRLINES',         bg:'#031225', accent:'#5ec9ff'},
    {text:'NOVAK',  sub:'WATCHES',          bg:'#150a02', accent:'#ffcf7a'},
    {text:'GLIMMER',sub:'JEWELRY',          bg:'#2b0a1f', accent:'#ff9ad4'},
    {text:'CIRCUIT',sub:'ARCADE',           bg:'#080826', accent:'#7a5eff'},
    {text:'TIDE',   sub:'LAUNDRY',          bg:'#02202b', accent:'#5ee0ff'},
    {text:'ONYX',   sub:'NIGHTCLUB',        bg:'#150215', accent:'#e34dff'},
    {text:'FERAL',  sub:'PET FOOD',         bg:'#122b04', accent:'#a6ff4d'},
    {text:'STRATA', sub:'REAL ESTATE',      bg:'#0a141f', accent:'#8fc8ff'},
  ];
  // z-zones already covered by hand-placed billboards elsewhere; skip near these
  const reservedZ = [-46, 2, 6, 9, 12, 20, 24];
  const farFromReserved = z => reservedZ.every(rz => Math.abs(rz - z) > 6);

  for(let side of [-1,1]){
    let z = -55;
    let idx = 0;
    while(z < 55){
      const depth = 8 + Math.random()*6;
      const height = 16 + Math.random()*30;
      const width = 8 + Math.random()*5;

      const facadeTex = windowTexture(
        6 + Math.floor(Math.random()*4),
        Math.floor(height*1.6),
        '#0a0f16',
        litColors[idx % litColors.length],
        0.18 + Math.random()*0.22
      );
      facadeTex.repeat.set(1, Math.max(1, Math.round(height/10)));

      const mat = new THREE.MeshStandardMaterial({
        color: facadeColors[idx % facadeColors.length],
        map: facadeTex,
        roughness: 0.85,
        metalness: 0.15
      });

      const bld = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), mat);
      bld.position.set(side*(17 + depth/2), height/2, z);
      bld.castShadow = true;
      bld.receiveShadow = true;
      scene.add(bld);

      (side === -1 ? leftBuildings : rightBuildings).push({ x: bld.position.x, z, width, depth, height });

      // glue random ad panel(s) to this building's street-facing wall
      if(farFromReserved(z) && Math.random() < 0.85 && height > 14){
        const faceX = bld.position.x + side*(width/2 + 0.06);
        const ry = side===-1 ? Math.PI/2 : -Math.PI/2;
        const pw = Math.min(width, depth) * 0.72;

        // lower panel — almost every eligible building gets at least this one
        const spec1 = adPalette[Math.floor(Math.random()*adPalette.length)];
        const ph1 = pw * (0.75 + Math.random()*0.4);
        const py1 = height * (0.28 + Math.random()*0.18);
        addPanel(scene, {
          x:faceX, y:py1, z, ry, w:pw, h:ph1, glow:spec1.accent,
          tex: neonSignTexture({ text:spec1.text, sub:spec1.sub, bg:spec1.bg, accent:spec1.accent, fontSize:120 })
        });

        // second, higher panel on taller buildings for a denser skyline of ads
        if(height > 26 && Math.random() < 0.7){
          let spec2 = adPalette[Math.floor(Math.random()*adPalette.length)];
          while(spec2.text === spec1.text){
            spec2 = adPalette[Math.floor(Math.random()*adPalette.length)];
          }
          const ph2 = pw * (0.75 + Math.random()*0.4);
          const py2 = height * (0.62 + Math.random()*0.2);
          addPanel(scene, {
            x:faceX, y:py2, z, ry, w:pw, h:ph2, glow:spec2.accent,
            tex: neonSignTexture({ text:spec2.text, sub:spec2.sub, bg:spec2.bg, accent:spec2.accent, fontSize:120 })
          });
        }
      }

      z += depth + 1.5 + Math.random()*3;
      idx++;
    }
  }

  // Distant skyline silhouettes for depth
  const skylineMat = new THREE.MeshBasicMaterial({ color:0x040810, transparent:true, opacity:0.85 });
  for(let side of [-1,1]){
    for(let i=0;i<14;i++){
      const h = 30 + Math.random()*55;
      const w = 6 + Math.random()*10;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w,h,w), skylineMat);
      b.position.set(side*(46+Math.random()*20), h/2, -70+ i*11 + Math.random()*6);
      scene.add(b);
    }
  }
}

function buildBillboards(){
  const bbGroupLeft = new THREE.Group();
  const bbGroupRight = new THREE.Group();
  scene.add(bbGroupLeft, bbGroupRight);

  const EPS = 0.08; // tiny gap to avoid z-fighting with the wall

  // Find the building whose z is closest to the requested z, and return
  // the x of its street-facing wall (so signs sit flush against it).
  function wallX(list, z, side){
    let best = list[0], bestD = Infinity;
    for(const b of list){
      const d = Math.abs(b.z - z);
      if(d < bestD){ bestD = d; best = b; }
    }
    const faceX = best.x + side*(best.width/2); // face pointing toward the street
    return faceX + side*EPS;
  }

  // LEFT stack (near camera) — mimics layered ad tower, glued to the left canyon wall
  const lx6 = wallX(leftBuildings, 6, 1);
  addPanel(bbGroupLeft, { x:lx6, y:26, z:6, ry:Math.PI/2, w:6, h:4.4, glow:'#ff5566',
    tex:neonSignTexture({text:'AXIS', sub:'NEWS NETWORK', bg:'#7a0d16', accent:'#ff5566', fontSize:150}) });

  addPanel(bbGroupLeft, { x:lx6, y:20.5, z:6, ry:Math.PI/2, w:6, h:5.4, glow:'#5ec9ff',
    tex:neonSignTexture({shape:'camera', text:'NOVA S1', accent:'#5ec9ff', fontSize:90}) });

  const lx9 = wallX(leftBuildings, 9, 1);
  addPanel(bbGroupLeft, { x:lx9, y:16, z:9, ry:Math.PI/2, w:4.6, h:5.2, glow:'#5cff8f',
    tex:neonSignTexture({text:'SPUD', sub:'RUSH · LATER', bg:'#0c3d1f', accent:'#5cff8f', fontSize:130}) });

  addPanel(bbGroupLeft, { x:lx6, y:10.5, z:6, ry:Math.PI/2, w:6, h:5.6, glow:'#ff4d4d',
    tex:neonSignTexture({text:'KOI', sub:'COLA', bg:'#7a0f12', accent:'#ff4d4d', fontSize:170}) });

  // RIGHT stack, glued to the right canyon wall
  const rx2 = wallX(rightBuildings, 2, -1);
  addPanel(bbGroupRight, { x:rx2, y:30, z:2, ry:-Math.PI/2, w:9, h:9, glow:'#ff2d7a',
    tex:neonSignTexture({shape:'circle', text:'ZX', accent:'#ff2d7a', fontSize:230}) });

  const rx12 = wallX(rightBuildings, 12, -1);
  addPanel(bbGroupRight, { x:rx12, y:14, z:12, ry:-Math.PI/2, w:8, h:11, glow:'#4de0ff',
    tex:neonSignTexture({text:'POLAR', sub:'M A R T', bg:'#062230', accent:'#4de0ff', fontSize:150}) });

  const rx20 = wallX(rightBuildings, 20, -1);
  addPanel(bbGroupRight, { x:rx20, y:6.5, z:20, ry:-Math.PI/2, w:6.5, h:5.5, glow:'#ffcf4d',
    tex:neonSignTexture({text:'GOLDEN', sub:'THRONE · NOW SHOWING', bg:'#241305', accent:'#ffcf4d', fontSize:110}) });

  // Ground-level bookshop marquee (Strand-style, generic)
  const marqueeTex = neonSignTexture({text:'PAGE & CO', sub:'B O O K S · E S T 1927', bg:'#7a0d16', accent:'#ffffff', fontSize:100});
  const lx24 = wallX(leftBuildings, 24, 1);
  addPanel(bbGroupLeft, { x:lx24, y:4.2, z:24, ry:Math.PI/2 - 0.55, w:6.5, h:3.2, glow:'#ff8899', tex:marqueeTex });

}

/* ---------------------------- RAIN ---------------------------- */
function buildRain(){
  const count = 6000;
  const positions = new Float32Array(count*3);
  const speeds = new Float32Array(count);
  for(let i=0;i<count;i++){
    positions[i*3+0] = (Math.random()-0.5)*70;
    positions[i*3+1] = Math.random()*45;
    positions[i*3+2] = (Math.random()-0.5)*140;
    speeds[i] = 0.4 + Math.random()*0.5;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions,3));
  rainSystem = new THREE.Points(geo, new THREE.PointsMaterial({
    color:0xaee6ff, size:0.09, transparent:true, opacity:0.55, depthWrite:false
  }));
  rainSystem.userData.speeds = speeds;
  scene.add(rainSystem);
}

function updateRain(dt){
  if(!rainOn) return;
  const pos = rainSystem.geometry.attributes.position;
  const speeds = rainSystem.userData.speeds;
  for(let i=0;i<pos.count;i++){
    let y = pos.getY(i) - speeds[i]*dt*60;
    if(y < 0){ y = 45; }
    pos.setY(i, y);
  }
  pos.needsUpdate = true;
}

/* ---------------------------- TRAFFIC ---------------------------- */
function buildTraffic(){
  const bodyGeo = new THREE.BoxGeometry(1.6, 0.6, 3.2);
  for(let i=0;i<10;i++){
    const dir = i%2===0 ? 1 : -1;
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(Math.random(),0.5,0.35), roughness:0.4, metalness:0.5 });
    const car = new THREE.Mesh(bodyGeo, mat);
    const lane = dir>0 ? -2.3 : 2.3;
    car.position.set(lane, 0.45, -60 + Math.random()*120);
    car.rotation.y = dir>0 ? 0 : Math.PI;
    car.castShadow = true;
    scene.add(car);

    const lightMat = new THREE.MeshBasicMaterial({ color: dir>0 ? 0xfff2c9 : 0xff3b3b });
    const lightGeo = new THREE.BoxGeometry(1.5,0.15,0.1);
    const lights = new THREE.Mesh(lightGeo, lightMat);
    lights.position.set(lane, 0.5, car.position.z + dir*1.65);
    scene.add(lights);

    cars.push({ mesh:car, lightMesh:lights, dir, speed:6+Math.random()*4, lane });
  }
}

function updateTraffic(dt){
  cars.forEach(c=>{
    c.mesh.position.z += c.dir*c.speed*dt;
    c.lightMesh.position.z = c.mesh.position.z + c.dir*1.65;
    if(c.mesh.position.z > 65) c.mesh.position.z = -65;
    if(c.mesh.position.z < -65) c.mesh.position.z = 65;
  });
}

/* ---------------------------- PEDESTRIANS ---------------------------- */
function buildPedestrians(){
  const mat = new THREE.MeshStandardMaterial({ color:0x11151a, roughness:0.9 });
  const umbrellaColors = [0x8a1030, 0x105c8a, 0x2c2c2c, 0x8a6a10];
  for(let i=0;i<16;i++){
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22,0.9,4,8), mat);
    body.position.y = 0.75;
    body.castShadow = true;
    g.add(body);

    if(Math.random() < 0.4){
      const umbrella = new THREE.Mesh(
        new THREE.ConeGeometry(0.55,0.35,10),
        new THREE.MeshStandardMaterial({ color: umbrellaColors[Math.floor(Math.random()*umbrellaColors.length)], roughness:0.6 })
      );
      umbrella.position.y = 1.55;
      g.add(umbrella);
    }

    const side = Math.random()<0.5 ? -1 : 1;
    const z0 = -50 + Math.random()*100;
    g.position.set(side*(9 + Math.random()*3.4), 0, z0);
    g.rotation.y = Math.random()*Math.PI*2;
    scene.add(g);
    peds.push({ mesh:g, dirZ: Math.random()<0.5?1:-1, speed:0.6+Math.random()*0.6, side });
  }
}

function updatePedestrians(dt){
  peds.forEach(p=>{
    p.mesh.position.z += p.dirZ*p.speed*dt;
    p.mesh.rotation.y = p.dirZ>0 ? 0 : Math.PI;
    if(p.mesh.position.z > 55) p.mesh.position.z = -55;
    if(p.mesh.position.z < -55) p.mesh.position.z = 55;
  });
}

/* ---------------------------- LOOP ---------------------------- */
function animate(){
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (cameraCinematic) {
    cameraCinematic.elapsed += dt;
    const p = Math.min(cameraCinematic.elapsed / cameraCinematic.duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);

    camera.position.lerpVectors(cameraCinematic.startPos, cameraCinematic.endPos, eased);
    controls.target.lerpVectors(cameraCinematic.startTarget, cameraCinematic.endTarget, eased);

    if (p >= 1) {
      const finishedMode = cameraCinematic.mode;
      // Clear the finished cinematic BEFORE running the transition logic below,
      // so that if that logic starts a brand-new cinematic (chaining straight
      // into the next panel), it doesn't get wiped out afterward.
      cameraCinematic = null;

      if (finishedMode === 'panel') {
        storyFlow.cinematicCompleted = true;
        if (storyFlow.phase === 'panel-41-cinematic') {
          storyFlow.phase = 'panel-41-done';
        } else if (storyFlow.phase === 'panel-28-cinematic') {
          storyFlow.phase = 'panel-28-done';
        } else if (storyFlow.phase === 'panel-19-cinematic') {
          storyFlow.phase = 'panel-19-done';
        } else if (storyFlow.phase === 'final-image') {
          storyFlow.phase = 'panel-41-cinematic';
        } else {
          storyFlow.phase = 'panel-cinematic';
        }
      } else if (finishedMode === 'return') {
        if (storyFlow.phase === 'panel-41-return') {
          // Show the "arriving back" image first — the panel 28 cinematic
          // only starts once the user presses Space again on this image.
          storyFlow.phase = 'panel-41-epilogue';
          showStoryOverlay('https://cdn.phototourl.com/member/2026-08-29-79f8de58-ebee-42aa-ba13-407e39ab6e53.png');
        } else if (storyFlow.phase === 'panel-28-return') {
          // Same pattern: show this image first, the panel 19 cinematic
          // waits for the next Space press.
          storyFlow.phase = 'panel-28-epilogue';
          showStoryOverlay('https://cdn.phototourl.com/member/2026-08-29-4e2acc6f-d008-4dc9-8b22-e30aad3421ad.png');
        } else if (storyFlow.phase === 'panel-19-return') {
          storyFlow.phase = 'panel-19-done';
          showStoryOverlay('https://cdn.phototourl.com/member/2026-08-30-45be1a29-e5fa-423a-9e5d-02446c8e340a.png');
        } else {
          storyFlow.finalImageShown = true;
          storyFlow.phase = 'final-image';
          showStoryOverlay(finalStoryUrl);
        }
      }

      if (!cameraCinematic) {
        controls.enabled = true;
      }
      syncStoryFlow();
    }
  }

  updateRain(dt);
  updateTraffic(dt);
  updatePedestrians(dt);

  // Gentle billboard flicker only for pure neon/color-block panels.
  // Image-based panels stay fully stable so the artwork is easier to read.
  const t = clock.getElapsedTime();
  neonMaterials.forEach((m, i) => {
    if (m.map && m.map.image && m.map.image.width) {
      m.color.set(0xffffff);
      return;
    }

    const flick = 1 + Math.sin(t * 1.3 + i * 1.4) * 0.01;
    m.color.setScalar(Math.min(1.0, Math.max(0.9, flick)));
  });

  controls.update();
  composer.render();
}
