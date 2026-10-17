// 3D backdrop for the host screen: floating answer shapes that react to
// the game phase, a countdown-driven "urgency" effect, and a podium finale.
import * as THREE from 'three';
import { COLORS } from './net.js';

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const calmBg = new THREE.Color('#2a0d5e');
  const urgentBg = new THREE.Color('#5e0d24');
  scene.background = calmBg.clone();
  scene.fog = new THREE.Fog(scene.background, 18, 46);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  camera.position.set(0, 0, 20);

  scene.add(new THREE.AmbientLight('#ffffff', 0.55));
  const key = new THREE.DirectionalLight('#ffffff', 1.6);
  key.position.set(6, 10, 12);
  scene.add(key);
  const rim = new THREE.PointLight('#b388ff', 60, 60);
  rim.position.set(-10, -6, 8);
  scene.add(rim);

  // ---- answer shapes ----
  const geos = makeShapeGeometries();
  const field = new THREE.Group();
  scene.add(field);
  const shapes = [];
  for (let i = 0; i < 32; i++) {
    const type = i % 4;
    const mat = new THREE.MeshStandardMaterial({
      color: COLORS[type], roughness: 0.35, metalness: 0.1, transparent: true, emissive: COLORS[type], emissiveIntensity: 0,
    });
    const mesh = new THREE.Mesh(geos[type], mat);
    const home = new THREE.Vector3((Math.random() - 0.5) * 34, (Math.random() - 0.5) * 20, -Math.random() * 22 + 2);
    mesh.position.copy(home);
    mesh.rotation.set(Math.random() * 6, Math.random() * 6, 0);
    const s = 0.6 + Math.random() * 0.7;
    mesh.userData = { type, home, baseScale: s, targetScale: s, targetOpacity: 1, targetGlow: 0, spin: (Math.random() - 0.5) * 1.2, phase: Math.random() * 6 };
    mesh.scale.setScalar(s);
    field.add(mesh);
    shapes.push(mesh);
  }

  // ---- confetti ----
  const CONFETTI = 400;
  const confettiMesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.22, 0.12),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    CONFETTI,
  );
  const confetti = Array.from({ length: CONFETTI }, () => ({ p: new THREE.Vector3(0, -99, 0), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), alive: false }));
  const palette = [...COLORS, '#ffffff', '#ffd54f'].map((c) => new THREE.Color(c));
  for (let i = 0; i < CONFETTI; i++) confettiMesh.setColorAt(i, palette[i % palette.length]);
  confettiMesh.frustumCulled = false;
  scene.add(confettiMesh);
  let confettiRain = false;

  function burst(n = 160, origin = new THREE.Vector3(0, -2, 4)) {
    let spawned = 0;
    for (const c of confetti) {
      if (c.alive) continue;
      c.alive = true;
      c.p.copy(origin);
      c.v.set((Math.random() - 0.5) * 14, 8 + Math.random() * 9, (Math.random() - 0.5) * 6);
      c.w.set(Math.random() * 8, Math.random() * 8, Math.random() * 8);
      if (++spawned >= n) break;
    }
  }

  // ---- podium ----
  const podium = new THREE.Group();
  podium.visible = false;
  scene.add(podium);

  function buildPodium(top) {
    podium.clear();
    const slots = [
      { place: 1, x: 0, h: 5.2, color: '#ffc107' },
      { place: 2, x: -4.4, h: 3.6, color: '#cfd8dc' },
      { place: 3, x: 4.4, h: 2.4, color: '#d38b4b' },
    ];
    slots.forEach((slot) => {
      const entry = top[slot.place - 1];
      if (!entry) return;
      const col = new THREE.Group();
      col.position.set(slot.x, -9, 0);
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(3.8, slot.h, 3),
        new THREE.MeshStandardMaterial({ color: slot.color, roughness: 0.3, metalness: 0.5 }),
      );
      box.position.y = slot.h / 2;
      col.add(box);
      const num = textSprite(String(slot.place), { size: 140, color: '#2a0d5e', w: 256, h: 256 });
      num.position.set(0, slot.h / 2, 1.55);
      num.scale.set(2, 2, 1);
      col.add(num);
      const label = textSprite(`${entry.name}\n${entry.score.toLocaleString()} pts`, { size: 60, color: '#ffffff', w: 768, h: 256, shadow: true });
      label.position.set(0, slot.h + 1.4, 0);
      label.scale.set(6, 2, 1);
      col.add(label);
      // Reveal 3rd, then 2nd, then 1st, like the real thing.
      col.userData = { targetY: -6, delay: { 3: 0.2, 2: 1.4, 1: 2.8 }[slot.place], t: 0 };
      podium.add(col);
    });
  }

  // ---- state ----
  let mode = 'lobby';
  let urgency = 0;
  let swirl = 0;

  function setMode(next, opts = {}) {
    mode = next;
    confettiRain = false;
    podium.visible = next === 'podium';
    for (const m of shapes) {
      const d = m.userData;
      d.targetGlow = 0;
      d.targetOpacity = next === 'podium' ? 0.25 : 1;
      d.targetScale = d.baseScale;
      if (next === 'reveal' && opts.correctIndex !== undefined) {
        const hit = d.type === opts.correctIndex;
        d.targetScale = d.baseScale * (hit ? 1.7 : 0.55);
        d.targetOpacity = hit ? 1 : 0.25;
        d.targetGlow = hit ? 0.6 : 0;
      }
    }
    if (next !== 'question') urgency = 0;
    if (next === 'preview') swirl = 1;
    if (next === 'reveal') burst(90);
    if (next === 'podium') {
      buildPodium(opts.top || []);
      confettiRain = true;
      burst(200, new THREE.Vector3(0, -4, 2));
    }
  }

  function setUrgency(u) { urgency = Math.max(0, Math.min(1, u)); }

  // ---- loop ----
  const clock = new THREE.Clock();
  const dummy = new THREE.Object3D();

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    swirl = Math.max(0, swirl - dt * 0.5);
    const speed = 1 + urgency * 3 + swirl * 4;

    scene.background.copy(calmBg).lerp(urgentBg, urgency * urgency);
    scene.fog.color.copy(scene.background);

    field.rotation.y += dt * 0.03 * speed;
    for (const m of shapes) {
      const d = m.userData;
      m.rotation.x += dt * d.spin * speed;
      m.rotation.y += dt * d.spin * 0.7 * speed;
      m.position.y = d.home.y + Math.sin(t * 0.8 + d.phase) * 0.6;
      // Shake when time is nearly out.
      m.position.x = d.home.x + (urgency > 0.75 ? (Math.random() - 0.5) * 0.12 * urgency : 0);
      const k = 1 - Math.exp(-dt * 6);
      m.scale.setScalar(THREE.MathUtils.lerp(m.scale.x, d.targetScale, k));
      m.material.opacity = THREE.MathUtils.lerp(m.material.opacity, d.targetOpacity, k);
      const pulse = d.targetGlow ? d.targetGlow * (0.7 + 0.3 * Math.sin(t * 6)) : 0;
      m.material.emissiveIntensity = THREE.MathUtils.lerp(m.material.emissiveIntensity, pulse, k);
    }

    // Gentle camera drift; pull in for the podium.
    const camZ = mode === 'podium' ? 15 : 20;
    camera.position.x = Math.sin(t * 0.15) * 1.5;
    camera.position.z = THREE.MathUtils.lerp(camera.position.z, camZ, 1 - Math.exp(-dt * 2));
    camera.lookAt(0, mode === 'podium' ? -3 : 0, 0);

    if (podium.visible) {
      for (const col of podium.children) {
        const u = col.userData;
        u.t += dt;
        if (u.t > u.delay) {
          const before = col.position.y;
          col.position.y = THREE.MathUtils.lerp(col.position.y, u.targetY, 1 - Math.exp(-dt * 3));
          if (before < u.targetY - 0.5 && col.position.y >= u.targetY - 0.5) burst(60, new THREE.Vector3(col.position.x, 0, 2));
        }
      }
    }

    if (confettiRain && Math.random() < 0.3) burst(3, new THREE.Vector3((Math.random() - 0.5) * 24, 12, (Math.random() - 0.5) * 6));
    for (let i = 0; i < CONFETTI; i++) {
      const c = confetti[i];
      if (c.alive) {
        c.v.y -= 9.8 * dt * 0.6;
        c.v.multiplyScalar(1 - dt * 0.8); // air drag makes it flutter
        c.p.addScaledVector(c.v, dt);
        c.r.x += c.w.x * dt; c.r.y += c.w.y * dt; c.r.z += c.w.z * dt;
        if (c.p.y < -14) { c.alive = false; c.p.y = -99; }
      }
      dummy.position.copy(c.p);
      dummy.rotation.copy(c.r);
      dummy.updateMatrix();
      confettiMesh.setMatrixAt(i, dummy.matrix);
    }
    confettiMesh.instanceMatrix.needsUpdate = true;

    renderer.render(scene, camera);
  });

  return { setMode, setUrgency, burst };
}

function makeShapeGeometries() {
  const extrude = { depth: 0.5, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.1, bevelSegments: 3, curveSegments: 24 };
  const tri = new THREE.Shape();
  tri.moveTo(0, 1.1); tri.lineTo(1.05, -0.7); tri.lineTo(-1.05, -0.7); tri.closePath();
  const dia = new THREE.Shape();
  dia.moveTo(0, 1.15); dia.lineTo(1, 0); dia.lineTo(0, -1.15); dia.lineTo(-1, 0); dia.closePath();
  const cir = new THREE.Shape();
  cir.absarc(0, 0, 0.95, 0, Math.PI * 2, false);
  const sq = new THREE.Shape();
  sq.moveTo(-0.85, -0.85); sq.lineTo(0.85, -0.85); sq.lineTo(0.85, 0.85); sq.lineTo(-0.85, 0.85); sq.closePath();
  return [tri, dia, cir, sq].map((s) => new THREE.ExtrudeGeometry(s, extrude).center());
}

function textSprite(text, { size = 64, color = '#fff', w = 512, h = 256, shadow = false }) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.font = `800 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = color;
  if (shadow) { g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 12; }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    let s = line;
    while (g.measureText(s).width > w - 20 && s.length > 1) s = s.slice(0, -1);
    g.fillText(s === line ? s : s + '…', w / 2, h / 2 + (i - (lines.length - 1) / 2) * size * 1.15);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
}
