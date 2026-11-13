// ---------------------------------------------------------------------------
// The 3D race track: an oval with rails, grandstand, trees and a camera.
// Used in two modes:
//   mode="home"  — the landing page: the field gallops laps while a camera
//                  dollies alongside them
//   mode="race"  — the game: the race is run down the home straight, left to
//                  right, in front of the grandstand. The camera holds a
//                  side-on broadcast shot from the infield, slightly above,
//                  so all four lanes and the six track cards stay readable.
// The four horse photos stand on the track as upright cutouts that always turn
// to face the camera, mirrored so they point the way they are running.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from "react";
import * as THREE from "three";

const SUIT_KEYS = ["S", "H", "D", "C"];
const SUIT_SYM = { S: "♠", H: "♥", D: "♦", C: "♣" };
const IS_RED = { H: true, D: true };
const STEPS = 7; // gate → six track cards → past the wire

// ---- track geometry: two straights joined by two half-circles --------------
const A = 18;           // half the length of each straight
const R = 14;           // turn radius, measured to the middle of the track
const W = 10.4;         // track width
const TURN = Math.PI * R;
const L = 4 * A + 2 * TURN; // one lap along the middle of the track
// lane offsets across the track: positive is the grandstand side (far from the
// race camera), so Spades runs the far lane and Clubs the near one
const LANE = { S: 3.6, H: 1.2, D: -1.2, C: -3.6 };
const HORSE_H = { home: 2.8, race: 3.7 };

// the race course along the home straight. On that straight x equals the lap
// distance d, and the infield camera sees -x as "to the right", so horses start
// at +x and run toward -x.
const X0 = 15.3;        // where a horse stands at the gate (step 0)
const STEP = 4.35;      // distance covered by one card
const stepX = (k) => X0 - k * STEP;
// the wire sits well clear of the sixth line; the winner's last stride is
// stretched (see trackX) so it still gallops cleanly through it
const WIRE_X = stepX(6.85);
const trackX = (k) => stepX(k <= 6 ? k : 6 + (k - 6) * 1.55);
// Each photo is cropped differently (Clubs is at full stretch, Diamonds has the
// least horse in its frame), so equal frame heights give unequal horses. These
// were measured from the photos: they make the visible horse cover the same
// area in each one.
const HORSE_FIT = { S: 0.961, H: 0.97, D: 1.092, C: 0.992 };

/** Point d units along the lap, shifted `off` units outward. Also returns the
 *  direction of travel (tx, tz) and the outward direction (nx, nz). */
function pt(d, off = 0) {
  d = ((d % L) + L) % L;
  let x, z, tx, tz, nx, nz;
  if (d < A) {
    x = d; z = R; tx = 1; tz = 0; nx = 0; nz = 1;
  } else if (d < A + TURN) {
    const al = Math.PI / 2 - (d - A) / R;
    nx = Math.cos(al); nz = Math.sin(al);
    x = A + R * nx; z = R * nz; tx = nz; tz = -nx;
  } else if (d < 3 * A + TURN) {
    x = A - (d - A - TURN); z = -R; tx = -1; tz = 0; nx = 0; nz = -1;
  } else if (d < 3 * A + 2 * TURN) {
    const al = -Math.PI / 2 - (d - 3 * A - TURN) / R;
    nx = Math.cos(al); nz = Math.sin(al);
    x = -A + R * nx; z = R * nz; tx = nz; tz = -nx;
  } else {
    x = -A + (d - 3 * A - 2 * TURN); z = R; tx = 1; tz = 0; nx = 0; nz = 1;
  }
  return { x: x + nx * off, z: z + nz * off, tx, tz, nx, nz };
}

// small deterministic random so the scenery is the same on every device
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- painted textures (no image files needed) ------------------------------
function canvasTex(w, h, draw, opts = {}) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 4;
  return t;
}

function dirtTexture() {
  const r = rng(11);
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = "#C28C57"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = r() > 0.5 ? "rgba(255,236,205,.10)" : "rgba(70,42,16,.10)";
      g.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2);
    }
    // harrow lines, running the way the horses run
    for (let y = 6; y < h; y += 13) {
      g.fillStyle = "rgba(60,36,14,.13)"; g.fillRect(0, y + r() * 3, w, 2);
      g.fillStyle = "rgba(255,240,214,.08)"; g.fillRect(0, y + 4, w, 1);
    }
  }, { repeat: true });
}

function grassTexture() {
  const r = rng(5);
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = "#4E9E57"; g.fillRect(0, 0, w / 2, h);
    g.fillStyle = "#3F8A4B"; g.fillRect(w / 2, 0, w / 2, h);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = r() > 0.5 ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.06)";
      g.fillRect(r() * w, r() * h, 2, 2);
    }
  }, { repeat: true });
}

function crowdTexture() {
  const r = rng(23);
  const cols = ["#F4E7D3", "#E8B694", "#7FA2D0", "#E05252", "#F0C24B", "#FFFFFF", "#3E5F8A", "#D9749C"];
  return canvasTex(512, 128, (g, w, h) => {
    g.fillStyle = "#6F7B86"; g.fillRect(0, 0, w, h);
    for (let row = 0; row < 9; row++) {
      g.fillStyle = "rgba(0,0,0,.18)"; g.fillRect(0, row * 14 + 12, w, 2);
      for (let x = 3; x < w; x += 7) {
        if (r() < 0.14) continue;
        g.fillStyle = cols[Math.floor(r() * cols.length)];
        g.beginPath(); g.arc(x + r() * 2, row * 14 + 6, 2.6, 0, 7); g.fill();
      }
    }
  });
}

function skyTexture() {
  return canvasTex(4, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, "#4FA6E2");
    gr.addColorStop(0.45, "#8CCAF0");
    gr.addColorStop(0.75, "#CFE8F8");
    gr.addColorStop(1, "#EAF4F8");
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
}

function softDot(inner, outer) {
  return canvasTex(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    gr.addColorStop(0, inner); gr.addColorStop(1, outer);
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  });
}

function checkerTexture(nx, ny) {
  return canvasTex(nx * 16, ny * 16, (g) => {
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      g.fillStyle = (i + j) % 2 ? "#1D1D1D" : "#FFFFFF";
      g.fillRect(i * 16, j * 16, 16, 16);
    }
  });
}

function badgeTexture(s) {
  return canvasTex(96, 96, (g) => {
    g.fillStyle = "#FBF7EA";
    g.beginPath(); g.arc(48, 48, 43, 0, 7); g.fill();
    g.lineWidth = 5; g.strokeStyle = "rgba(0,0,0,.55)"; g.stroke();
    g.fillStyle = IS_RED[s] ? "#D63A3A" : "#131009";
    g.font = "bold 62px Georgia, 'Times New Roman', serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(SUIT_SYM[s], 48, 52);
  });
}

/** A track card board: face-down (numbered) or the revealed card. */
function cardTexture(card, n) {
  return canvasTex(128, 176, (g, w, h) => {
    const rr = (x, y, ww, hh, rad) => {
      g.beginPath();
      g.moveTo(x + rad, y); g.arcTo(x + ww, y, x + ww, y + hh, rad);
      g.arcTo(x + ww, y + hh, x, y + hh, rad); g.arcTo(x, y + hh, x, y, rad);
      g.arcTo(x, y, x + ww, y, rad); g.closePath();
    };
    if (!card) {
      rr(2, 2, w - 4, h - 4, 14); g.fillStyle = "#1D3560"; g.fill();
      g.save(); g.clip();
      g.strokeStyle = "#2E4F8C"; g.lineWidth = 6;
      for (let i = -h; i < w + h; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + h, h); g.stroke(); }
      g.restore();
      rr(2, 2, w - 4, h - 4, 14); g.lineWidth = 5; g.strokeStyle = "#F4EFDF"; g.stroke();
      g.fillStyle = "#F4EFDF"; g.font = "bold 76px Impact, 'Arial Narrow', sans-serif";
      g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(String(n), w / 2, h / 2 + 4);
    } else {
      const s = card.slice(-1), rank = card.slice(0, -1);
      rr(2, 2, w - 4, h - 4, 14); g.fillStyle = "#FBF7EA"; g.fill();
      g.lineWidth = 4; g.strokeStyle = "rgba(0,0,0,.5)"; g.stroke();
      g.fillStyle = IS_RED[s] ? "#D63A3A" : "#131009";
      g.textAlign = "center"; g.textBaseline = "middle";
      // corner indices (rank over suit), mirrored in the opposite corner
      const corner = () => {
        g.font = `bold ${rank.length > 1 ? 26 : 30}px Georgia, 'Times New Roman', serif`; g.fillText(rank, 22, 24);
        g.font = "bold 24px Georgia, 'Times New Roman', serif"; g.fillText(SUIT_SYM[s], 22, 50);
      };
      corner();
      g.save(); g.translate(w, h); g.rotate(Math.PI); corner(); g.restore();
      // one big pip in the middle
      g.font = "bold 74px Georgia, 'Times New Roman', serif"; g.fillText(SUIT_SYM[s], w / 2, h / 2 + 4);
    }
  });
}

// ---- geometry helpers ------------------------------------------------------
/** A flat band that follows the lap between two offsets. */
function ribbon(o1, o2, y, d0 = 0, d1 = L, n = 260, uScale = 0.09) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= n; i++) {
    const d = d0 + (i / n) * (d1 - d0);
    const a = pt(d, o1), b = pt(d, o2);
    pos.push(a.x, y, a.z, b.x, y, b.z);
    uv.push(d * uScale, 0, d * uScale, 1);
    if (i < n) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** The grass inside the track. */
function infield(off, y, n = 200, uvScale = 0.11) {
  const pos = [0, y, 0], uv = [0, 0], idx = [];
  for (let i = 0; i <= n; i++) {
    const p = pt((i / n) * L, off);
    pos.push(p.x, y, p.z); uv.push(p.x * uvScale, p.z * uvScale);
    if (i < n) idx.push(0, i + 1, i + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

class LapCurve extends THREE.Curve {
  constructor(off, y) { super(); this.off = off; this.y = y; }
  getPoint(t, target = new THREE.Vector3()) {
    const p = pt(t * L, this.off);
    return target.set(p.x, this.y, p.z);
  }
}

// ---------------------------------------------------------------------------
function createScene(host, imgs, live) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.style.cssText = "display:block;width:100%;height:100%;opacity:0;transition:opacity .7s ease";
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = skyTexture();
  scene.fog = new THREE.Fog(0xD3E8F6, 95, 300);
  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.5, 600);

  scene.add(new THREE.HemisphereLight(0xFFFFFF, 0x7FA26B, 2.1));
  const sun = new THREE.DirectionalLight(0xFFF1D6, 1.9);
  sun.position.set(40, 60, -25);
  scene.add(sun);

  const disposables = [];
  const keep = (x) => { disposables.push(x); return x; };
  const lam = (o) => keep(new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, ...o }));
  const basic = (o) => keep(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, ...o }));
  const add = (geo, mat, parent = scene) => { const m = new THREE.Mesh(keep(geo), mat); parent.add(m); return m; };

  // ---- ground, infield, dirt ----
  const grass = keep(grassTexture());
  const farGrass = grass.clone(); keep(farGrass); farGrass.repeat.set(70, 70); farGrass.needsUpdate = true;
  const ground = add(new THREE.PlaneGeometry(700, 700), lam({ map: farGrass, color: 0xDDE8D6 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.03;

  add(infield(-(W / 2 + 0.2), 0), lam({ map: grass, color: 0xFFFFFF }));

  const dirt = keep(dirtTexture());
  add(ribbon(-W / 2, W / 2, 0.02), lam({ map: dirt }));

  // a pond in the infield
  const pond = add(new THREE.CircleGeometry(1, 40), lam({ color: 0x5FA9DA }));
  pond.rotation.x = -Math.PI / 2; pond.scale.set(9, 4.4, 1); pond.position.set(-5, 0.03, -1.5);
  const bank = add(new THREE.RingGeometry(1, 1.07, 40), lam({ color: 0xD9C79B }));
  bank.rotation.x = -Math.PI / 2; bank.scale.copy(pond.scale); bank.position.set(-5, 0.035, -1.5);

  // step lines across the dirt: where the horses stand after each move
  const lineMat = basic({ color: 0xFFFFFF, transparent: true, opacity: 0.55 });
  for (let k = 0; k < STEPS; k++) {
    const d = stepX(k);
    add(ribbon(-W / 2, W / 2, 0.04, d - 0.1, d + 0.1, 2), lineMat);
  }

  // suit markers painted on the dirt at the head of each lane
  const laneMarks = [];
  SUIT_KEYS.forEach((s) => {
    const m = add(new THREE.PlaneGeometry(1.5, 1.5), basic({ map: keep(badgeTexture(s)), transparent: true }));
    m.rotation.x = Math.PI / 2;            // flat on the ground, reading upright from the infield
    m.position.set(X0 + 2.3, 0.05, R + LANE[s]);
    laneMarks.push(m);
  });

  // ---- rails ----
  const railMat = lam({ color: 0xFFFFFF });
  const postGeo = keep(new THREE.CylinderGeometry(0.055, 0.055, 1.05, 6));
  const railOffs = [-(W / 2 + 0.35), W / 2 + 0.35];
  const nPosts = 2 * 70;
  const posts = new THREE.InstancedMesh(postGeo, railMat, nPosts);
  const dummy = new THREE.Object3D();
  let pi = 0;
  railOffs.forEach((off) => {
    add(new THREE.TubeGeometry(new LapCurve(off, 1.05), 260, 0.075, 6, true), railMat);
    add(new THREE.TubeGeometry(new LapCurve(off, 0.6), 260, 0.045, 5, true), railMat);
    for (let i = 0; i < 70; i++) {
      const p = pt((i / 70) * L, off);
      dummy.position.set(p.x, 0.525, p.z); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1);
      dummy.updateMatrix(); posts.setMatrixAt(pi++, dummy.matrix);
    }
  });
  posts.instanceMatrix.needsUpdate = true;
  scene.add(posts);

  // ---- the wire: checkered line and a finish arch ----
  const checker = keep(checkerTexture(16, 2));
  const wire = add(new THREE.PlaneGeometry(1.5, W), basic({ map: keep(checkerTexture(2, 12)) }));
  wire.rotation.x = -Math.PI / 2; wire.position.set(WIRE_X, 0.05, R);
  const archMat = lam({ color: 0xFFFFFF });
  [-(W / 2 + 0.75), W / 2 + 0.75].forEach((o) => {
    const p = add(new THREE.CylinderGeometry(0.16, 0.16, 5.6, 10), archMat);
    p.position.set(WIRE_X, 2.8, R + o);
    const ball = add(new THREE.SphereGeometry(0.34, 14, 10), lam({ color: 0xC93A2E }));
    ball.position.set(WIRE_X, 5.8, R + o);
  });
  const beam = add(new THREE.BoxGeometry(0.3, 0.9, W + 1.5), basic({ map: checker }));
  beam.position.set(WIRE_X, 5.05, R);
  // BoxGeometry maps the texture on every face; the long faces are the ones seen
  checker.wrapS = THREE.RepeatWrapping;

  // ---- grandstand, outside the home straight ----
  const stand = new THREE.Group();
  stand.position.set(0, 0, R + W / 2 + 3.2);
  scene.add(stand);
  const crowd = add(new THREE.PlaneGeometry(38, 9.5), lam({ map: keep(crowdTexture()) }), stand);
  crowd.rotation.x = -Math.PI / 2 + 0.72; crowd.position.set(0, 3.6, 3.2);
  const base = add(new THREE.BoxGeometry(38, 0.9, 1.2), lam({ color: 0xF4F1E8 }), stand);
  base.position.set(0, 0.45, -0.4);
  const back = add(new THREE.BoxGeometry(38.6, 10.5, 0.8), lam({ color: 0xE9E4D6 }), stand);
  back.position.set(0, 5.25, 7.4);
  const roof = add(new THREE.BoxGeometry(40, 0.45, 9.5), lam({ color: 0x2F6B48 }), stand);
  roof.position.set(0, 10.6, 3.4); roof.rotation.x = 0.08;
  const fascia = add(new THREE.BoxGeometry(40, 0.7, 0.2), lam({ color: 0xF0C24B }), stand);
  fascia.position.set(0, 10.0, -1.35);
  for (let i = -3; i <= 3; i++) {
    const col = add(new THREE.CylinderGeometry(0.16, 0.16, 10.2, 8), lam({ color: 0xFFFFFF }), stand);
    col.position.set(i * 6.2, 5.1, -1.2);
  }

  // ---- trees around the outside ----
  const r = rng(77);
  const nTrees = 110;
  const crowns = new THREE.InstancedMesh(keep(new THREE.IcosahedronGeometry(1, 1)), lam({ color: 0xFFFFFF }), nTrees);
  const trunks = new THREE.InstancedMesh(keep(new THREE.CylinderGeometry(0.22, 0.3, 1, 6)), lam({ color: 0x6B4A2E }), nTrees);
  const col = new THREE.Color();
  for (let i = 0; i < nTrees; i++) {
    const p = pt(r() * L, W / 2 + 9 + r() * 34);
    // keep the view of the grandstand clear
    const behindStand = p.z > R + 2 && Math.abs(p.x) < 24;
    const x = behindStand ? p.x * 1.0 : p.x, z = behindStand ? p.z + 16 : p.z;
    const s = 2.2 + r() * 2.6, trunk = 1.4 + r() * 1.2;
    dummy.rotation.set(0, r() * 6, 0);
    dummy.position.set(x, trunk + s * 0.75, z); dummy.scale.set(s, s * (0.95 + r() * 0.5), s);
    dummy.updateMatrix(); crowns.setMatrixAt(i, dummy.matrix);
    crowns.setColorAt(i, col.setHSL(0.31 + r() * 0.06, 0.42 + r() * 0.15, 0.24 + r() * 0.12));
    dummy.position.set(x, trunk / 2, z); dummy.scale.set(1, trunk, 1);
    dummy.updateMatrix(); trunks.setMatrixAt(i, dummy.matrix);
  }
  crowns.instanceMatrix.needsUpdate = true; trunks.instanceMatrix.needsUpdate = true;
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  scene.add(crowns, trunks);

  // ---- a few clouds ----
  const cloudMat = keep(new THREE.SpriteMaterial({
    map: keep(softDot("rgba(255,255,255,.95)", "rgba(255,255,255,0)")), fog: false, depthWrite: false, transparent: true,
  }));
  for (let i = 0; i < 9; i++) {
    const c = new THREE.Sprite(cloudMat);
    const a = r() * Math.PI * 2;
    c.position.set(Math.cos(a) * (170 + r() * 60), 46 + r() * 34, Math.sin(a) * (170 + r() * 60));
    c.scale.set(80 + r() * 60, 26 + r() * 14, 1);
    scene.add(c);
  }

  // ---- the six track cards, on poles along the far rail, one above each step ----
  const boardGeo = keep(new THREE.PlaneGeometry(2.9, 3.9));
  const poleGeo = keep(new THREE.CylinderGeometry(0.07, 0.07, 3.6, 6));
  const poleMat = lam({ color: 0xF4EFDF });
  const boards = [], boardPoles = [];
  for (let k = 1; k < STEPS; k++) {
    const p = pt(stepX(k), W / 2 + 1.5);
    const pole = add(poleGeo, poleMat); pole.position.set(p.x, 1.8, p.z);
    const mat = basic({ map: null, transparent: true, alphaTest: 0.5 });
    const m = new THREE.Mesh(boardGeo, mat);
    m.position.set(p.x, 5.5, p.z);
    scene.add(m);
    boardPoles.push(pole);
    boards.push({ mesh: m, mat, tex: null, shown: undefined, flipAt: 0, spin: 0 });
  }
  function setBoard(i, card) {
    const b = boards[i];
    if (b.tex) b.tex.dispose();
    b.tex = cardTexture(card, i + 1);
    b.mat.map = b.tex; b.mat.needsUpdate = true;
    b.shown = card || null;
  }

  // ---- horses ----
  const loader = new THREE.TextureLoader();
  const unit = keep(new THREE.PlaneGeometry(1, 1)); unit.translate(0, 0.5, 0);
  const shadowTex = keep(softDot("rgba(0,0,0,.5)", "rgba(0,0,0,0)"));
  const dustTex = keep(softDot("rgba(232,205,165,.85)", "rgba(232,205,165,0)"));
  const ringGeo = keep(new THREE.RingGeometry(1.5, 1.9, 40));
  const horses = {};
  SUIT_KEYS.forEach((s, i) => {
    const tex = loader.load(imgs[s], (t) => { h.aspect = t.image.width / t.image.height; });
    tex.colorSpace = THREE.SRGBColorSpace; keep(tex);
    const mesh = new THREE.Mesh(unit, basic({ map: tex, transparent: true, alphaTest: 0.35 }));
    mesh.rotation.order = "YXZ";
    const shadow = new THREE.Mesh(keep(new THREE.PlaneGeometry(1, 1)),
      basic({ map: shadowTex, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    const badge = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: keep(badgeTexture(s)), depthTest: false, transparent: true })));
    badge.renderOrder = 5;
    const dust = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: dustTex, transparent: true, depthWrite: false, opacity: 0 })));
    const ring = new THREE.Mesh(ringGeo, basic({ color: 0xF0C24B, transparent: true, opacity: 0.9 }));
    ring.rotation.x = -Math.PI / 2; ring.visible = false;
    scene.add(shadow, ring, dust, mesh, badge);
    const h = {
      s, mesh, shadow, badge, dust, ring, aspect: 1.45, facing: 1,
      cur: 0, from: 0, to: 0, target: null, t0: 0, moving: 0,
      stumbleAt: -99, phase: i * 1.7, pos: new THREE.Vector3(), d: 0,
    };
    horses[s] = h;
  });

  // ---- camera state ----
  const camPos = new THREE.Vector3(0, 30, -56);
  const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
  const camLook = new THREE.Vector3(0, 0, 0);
  const wantPos = new THREE.Vector3(), wantLook = new THREE.Vector3();
  const right = new THREE.Vector3();
  let snap = true;                 // jump straight to the first shot
  const seen = { roundId: null, drawIdx: null, flipped: 0, winner: null };
  let homeD = 0;

  function resize() {
    const w = host.clientWidth || 1, hgt = host.clientHeight || 1;
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  let raf = 0, last = performance.now() / 1000;
  function frame(ms) {
    raf = requestAnimationFrame(frame);
    const now = ms / 1000;
    const dt = Math.min(0.05, Math.max(0, now - last));
    last = now;
    const { mode, round, racing } = live.current;
    const home = mode === "home" || !round;
    const narrow = camera.aspect < 1.25;

    // ---------- where should every horse be? ----------
    if (home) {
      homeD -= dt * 9.5;
      SUIT_KEYS.forEach((s, i) => {
        const h = horses[s];
        h.d = homeD - [0, -3.1, 1.9, -5.4][i] - Math.sin(now * 0.55 + h.phase) * 1.5;
        h.moving = 1;
      });
    } else {
      const fresh = seen.roundId !== round.roundId;
      if (fresh) {
        boards.forEach((b, i) => { b.flipAt = 0; setBoard(i, i < round.flipped ? round.trackSuits[i] : null); });
        seen.flipped = round.flipped;
      }
      const drew = !fresh && seen.drawIdx !== null && round.drawIdx !== seen.drawIdx;
      const drawnSuit = drew && round.lastCard ? round.lastCard.slice(-1) : null;
      // suits of the track cards turned over by this draw
      const knocked = drew ? round.trackSuits.slice(seen.flipped, round.flipped).map((c) => c.slice(-1)) : [];
      SUIT_KEYS.forEach((s) => {
        const h = horses[s];
        const tgt = Math.min(round.positions[s], STEPS);
        const stumble = round.lastFlip === s && !round.winner;
        // where the drawn horse got to before any track card knocked it back
        const pre = s === drawnSuit ? Math.min(h.target + 1, STEPS) : h.target;
        if (fresh || h.target === null) {
          h.cur = h.from = h.to = h.target = tgt; h.moving = 0; h.stumbleAt = -99; h.next = null;
        } else if (drew && s === drawnSuit && knocked.includes(s) && pre !== tgt) {
          // its own suit came up on the track: gallop forward on the draw, then
          // fall back when that card turns over
          h.from = h.cur; h.to = pre; h.t0 = now + 0.5;
          h.next = { to: tgt, t0: now + 2.1 };
          h.target = tgt;
        } else if (tgt !== h.target) {
          // a beat after the reveal, later if knocked back
          h.from = h.cur; h.to = h.target = tgt;
          h.t0 = now + (stumble ? 2.1 : 0.5);
          h.next = null;
        }
        if (drew && (stumble || knocked.includes(s))) h.stumbleAt = now + 1.8;
        if (h.cur !== h.to) {
          const t = (now - h.t0) / 1.1;
          if (t >= 1) { h.cur = h.to; h.moving = 0; }
          else if (t > 0) { h.cur = h.from + (h.to - h.from) * ease(t); h.moving = 1; }
          else h.moving = 0;
        } else h.moving = 0;
        // the second leg, once the first has finished
        if (h.next && h.cur === h.to && now >= h.next.t0) {
          h.from = h.cur; h.to = h.next.to; h.t0 = h.next.t0; h.next = null;
        }
        h.d = trackX(h.cur);
      });

      // track cards turn over a moment after the gallop that triggered them
      if (round.flipped > seen.flipped) {
        for (let i = seen.flipped; i < round.flipped; i++) boards[i].flipAt = now + 1.4;
        seen.flipped = round.flipped;
      }
      boards.forEach((b, i) => {
        if (b.flipAt && now >= b.flipAt) { b.flipAt = 0; b.spin = 1; setBoard(i, round.trackSuits[i]); }
      });

      seen.roundId = round.roundId; seen.drawIdx = round.drawIdx; seen.winner = round.winner;
    }

    // ---------- place the horses ----------
    camera.position.copy(camPos); camera.lookAt(camLook); camera.updateMatrixWorld();
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    SUIT_KEYS.forEach((s) => {
      const h = horses[s];
      const p = pt(h.d, LANE[s]);
      const won = !home && round.winner === s;
      const idle = !home && racing && !round.winner && !h.moving;
      const stride = now * 15 + h.phase;
      const bob = h.moving ? Math.abs(Math.sin(stride)) * 0.2 : idle ? Math.abs(Math.sin(now * 5 + h.phase)) * 0.04 : 0;
      h.pos.set(p.x, bob, p.z);

      // face the way it is running, as seen from this camera
      const side = -(p.tx * right.x + p.tz * right.z);   // horses travel against d
      if (Math.abs(side) > 0.16) h.facing = side > 0 ? 1 : -1;

      // the near lane is closer to the camera and would look bigger; scale each
      // horse by its distance against the middle of the track so all four read
      // the same size, whatever the camera angle
      const mid = pt(h.d, 0);
      tmpV.set(mid.x, 1.6, mid.z);
      const near = THREE.MathUtils.clamp(camPos.distanceTo(tmpV2.set(p.x, 1.6, p.z)) / camPos.distanceTo(tmpV), 0.75, 1.3);
      const hgt = (home ? HORSE_H.home : HORSE_H.race) * HORSE_FIT[s] * near;
      h.mesh.position.copy(h.pos);
      h.mesh.scale.set(h.facing * hgt * h.aspect, hgt, 1);
      h.mesh.rotation.y = Math.atan2(camPos.x - p.x, camPos.z - p.z);
      let roll = h.moving ? Math.sin(stride) * 0.035 : 0;
      const st = now - h.stumbleAt;
      if (st > 0 && st < 0.7) roll -= Math.sin((st / 0.7) * Math.PI) * 0.26;       // pitch forward
      if (won) roll += (0.5 - 0.5 * Math.cos(Math.min(1, (now % 2.6) / 1.2) * Math.PI * 2)) * 0.2; // rear up
      h.mesh.rotation.z = roll * h.facing;

      h.shadow.position.set(p.x, 0.06, p.z);
      h.shadow.scale.set(hgt * h.aspect * 0.95, 1.5, 1);
      h.shadow.rotation.z = Math.atan2(-p.tz, p.tx);

      const dist = camPos.distanceTo(h.pos);
      const bs = THREE.MathUtils.clamp(dist * 0.034, 0.75, 2.6);
      h.badge.position.set(p.x, hgt + bob + 0.25 + bs * 0.5, p.z);
      h.badge.scale.set(bs, bs, 1);
      h.badge.visible = !home;

      h.dust.position.set(p.x + p.tx * 1.5, 0.55, p.z + p.tz * 1.5);
      const puff = 1.6 + Math.abs(Math.sin(stride * 0.5)) * 1.1;
      h.dust.scale.set(puff * 1.5, puff, 1);
      h.dust.material.opacity += ((h.moving ? 0.55 : 0) - h.dust.material.opacity) * Math.min(1, dt * 6);

      h.ring.visible = won;
      if (won) { h.ring.position.set(p.x, 0.07, p.z); h.ring.rotation.z = now * 0.8; }
    });

    // card boards turn to the camera, with a spin when they flip
    boards.forEach((b) => {
      if (b.spin > 0) b.spin = Math.max(0, b.spin - dt * 1.7);
      b.mesh.rotation.y = Math.atan2(camPos.x - b.mesh.position.x, camPos.z - b.mesh.position.z) + ease(b.spin) * Math.PI * 2;
      b.mesh.visible = !home;
    });
    boardPoles.forEach((m) => { m.visible = !home; });
    laneMarks.forEach((m) => { m.visible = !home; });

    // ---------- choose the shot ----------
    const dolly = (p, din, up, lookY) => {
      wantPos.set(p.x - p.nx * din, up, p.z - p.nz * din);
      wantLook.set(p.x, lookY, p.z);
    };
    let rate = 2.4;
    if (home) {
      // ride alongside the field; on a tall page keep the horses in the lower third
      const band = host.clientHeight < 340;
      const p = pt(homeD + 1.6, 0);
      if (band) dolly(p, 15, 3.0, 1.5);
      else dolly(p, narrow ? 27 : 24, 3.0, narrow ? 7.2 : 6.8);
      rate = 5;
    } else if (round.winner) {
      // the winner's close-up: a slow arc on the infield side
      const h = horses[round.winner];
      // (kept ahead of the horse, so the finish arch sits behind it, not in the way)
      const a = 0.5 + Math.sin(now * 0.3) * 0.35;
      wantPos.set(h.pos.x - Math.sin(a) * 12, 4.0, h.pos.z - Math.cos(a) * 12);
      wantLook.set(h.pos.x, 1.8, h.pos.z);
      rate = 1.6;
    } else {
      // the broadcast shot: side-on from the infield, slightly above, pulled
      // back just far enough to keep the whole straight in frame
      const elev = 0.5;
      const half = 21.2;                                     // half the width to keep in view
      // on very wide screens fitting the width alone would crop the near rail, so
      // never come closer than the distance that keeps the track's full depth in view
      const dist = Math.max(half / (Math.tan((camera.fov * Math.PI) / 360) * camera.aspect), 26.5);
      const cx = 0.3 + Math.sin(now * 0.13) * 0.5;           // a slow, small drift
      // "lift" aims the camera higher, which drops the track lower in the frame and
      // leaves the top for scenery (and for anything floating over the picture)
      const ly = 4.4 + (live.current.lift || 0);
      wantLook.set(cx, ly, R + 2.4);
      wantPos.set(cx, ly + Math.sin(elev) * dist, R + 2.4 - Math.cos(elev) * dist);
      rate = 1.7;
    }
    const k = snap ? 1 : 1 - Math.exp(-dt * rate);
    snap = false;
    camPos.lerp(wantPos, k); camLook.lerp(wantLook, k);
    camera.position.copy(camPos); camera.lookAt(camLook);

    renderer.render(scene, camera);
    if (!shown) { shown = true; canvas.style.opacity = "1"; }
  }
  let shown = false;
  raf = requestAnimationFrame(frame);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      boards.forEach((b) => b.tex && b.tex.dispose());
      disposables.forEach((x) => x.dispose && x.dispose());
      if (scene.background && scene.background.dispose) scene.background.dispose();
      renderer.dispose();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    },
  };
}

/** Fills its parent, which must be positioned and have a size.
 *  onFail is called if this device cannot draw 3D, so the caller can fall back. */
export default function RaceScene({ mode = "race", imgs, round, racing, lift = 0, onFail }) {
  const hostRef = useRef(null);
  const live = useRef({ mode, round, racing, lift });
  live.current = { mode, round, racing, lift };
  useEffect(() => {
    let api = null;
    try {
      api = createScene(hostRef.current, imgs, live);
    } catch (e) {
      console.warn("3D track unavailable, using the flat track:", e && e.message);
      if (onFail) onFail();
    }
    return () => { if (api) api.dispose(); };
    // the scene reads the latest props from `live` every frame
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }} aria-hidden="true" />;
}
