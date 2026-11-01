// 3D sign viewer: plays one exported skeleton (scripts/export_web_signs.py)
// with three.js. Loaded only when a sign is opened.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const TORSO = [[11, 12], [11, 13], [12, 14], [11, 23], [12, 24], [23, 24]];
const COLORS = { pose: 0x5b6e86, left: 0x0f8f8a, right: 0x2b59c3, face: 0x9aa9b8, joint: 0x13243a };

function decode(sign, manifest, payload) {
  const raw = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0));
  const ints = new Int16Array(raw.buffer);
  const points = manifest.groups.face[1];
  const frames = [];
  for (let f = 0; f < payload.frames; f++) {
    const frame = new Float32Array(points * 3);
    for (let i = 0; i < points * 3; i++) {
      const v = ints[f * points * 3 + i];
      frame[i] = v === manifest.missing ? NaN : v / manifest.scale;
    }
    frames.push(frame);
  }
  return frames;
}

export class SignViewer {
  constructor(container, manifest) {
    this.container = container;
    this.manifest = manifest;
    this.speed = 1;
    this.playing = true;
    this.mirror = false;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.append(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 14;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c4d0, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(2, 4, 6);
    this.scene.add(sun);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.buildMeshes();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  buildMeshes() {
    const { edges } = this.manifest;
    this.bones = [
      // Pose points 0-10 are face landmarks; the face contour already draws the face.
      // Upper body only; pose wrists/fingers (15-22) are replaced by the more
      // precise hand model, so forearms end at the detected hand's wrist.
      ...TORSO.map(([a, b]) => ({ a, b, color: COLORS.pose, r: 0.05 })),
      { a: 13, b: 25, alt: 15, color: COLORS.pose, r: 0.05 },
      { a: 14, b: 46, alt: 16, color: COLORS.pose, r: 0.05 },
      ...edges.hand.map(([a, b]) => ({ a: 25 + a, b: 25 + b, color: COLORS.left, r: 0.03 })),
      ...edges.hand.map(([a, b]) => ({ a: 46 + a, b: 46 + b, color: COLORS.right, r: 0.03 })),
    ];
    const cylinder = new THREE.CylinderGeometry(1, 1, 1, 10);
    this.boneMesh = new THREE.InstancedMesh(cylinder, new THREE.MeshStandardMaterial({ roughness: 0.55 }), this.bones.length);
    this.bones.forEach((bone, i) => this.boneMesh.setColorAt(i, new THREE.Color(bone.color)));
    this.root.add(this.boneMesh);
    const jointIds = [11, 12, 13, 14, 23, 24].concat([...Array(42).keys()].map((i) => 25 + i));
    this.joints = jointIds;
    this.jointMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 10), new THREE.MeshStandardMaterial({ roughness: 0.4 }), jointIds.length);
    jointIds.forEach((id, i) => this.jointMesh.setColorAt(i, new THREE.Color(id < 25 ? COLORS.joint : id < 46 ? COLORS.left : COLORS.right)));
    this.root.add(this.jointMesh);
    const faceCount = edges.face.length;
    this.faceGeometry = new THREE.BufferGeometry();
    this.faceGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(faceCount * 6), 3));
    this.face = new THREE.LineSegments(this.faceGeometry, new THREE.LineBasicMaterial({ color: COLORS.face }));
    this.root.add(this.face);
    this.tmp = { a: new THREE.Vector3(), b: new THREE.Vector3(), mid: new THREE.Vector3(), dir: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), q: new THREE.Quaternion(), m: new THREE.Matrix4(), s: new THREE.Vector3() };
  }

  async show(sign) {
    const response = await fetch(`signs/${sign.id}.json`);
    if (!response.ok) throw new Error("missing");
    this.frames = decode(sign, this.manifest, await response.json());
    this.fps = sign.fps_hint || 15;
    this.time = 0;
    this.frameView();
    this.draw(0);
    this.clock.getDelta();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  /** Stop rendering while the viewer is hidden. */
  sleep() {
    this.renderer.setAnimationLoop(null);
  }

  frameView() {
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const frame of this.frames) {
      // Frame the signing space: head, shoulders, arms and hands (not the hips).
      for (let p = 0; p < 67; p++) {
        if (p === 23 || p === 24) continue;
        if (Number.isFinite(frame[p * 3])) box.expandByPoint(v.set(frame[p * 3], frame[p * 3 + 1], frame[p * 3 + 2]));
      }
    }
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    this.home = { target: centre.clone(), position: centre.clone().add(new THREE.Vector3(0, 0.05, Math.max(size.y, size.x) * 1.3 + 0.5)) };
    this.resetView();
  }

  resetView() {
    if (!this.home) return;
    this.controls.target.copy(this.home.target);
    this.camera.position.copy(this.home.position);
    this.controls.update();
  }

  setMirror(on) {
    this.mirror = on;
    this.root.scale.x = on ? -1 : 1;
  }

  point(frames, f0, f1, t, p, out) {
    const a = frames[f0], b = frames[f1];
    const x0 = a[p * 3], x1 = b[p * 3];
    if (!Number.isFinite(x0)) return false;
    if (!Number.isFinite(x1)) { out.set(x0, a[p * 3 + 1], a[p * 3 + 2]); return true; }
    out.set(x0 + (x1 - x0) * t, a[p * 3 + 1] + (b[p * 3 + 1] - a[p * 3 + 1]) * t, a[p * 3 + 2] + (b[p * 3 + 2] - a[p * 3 + 2]) * t);
    return true;
  }

  draw(position) {
    if (!this.frames?.length) return;
    const n = this.frames.length;
    const f0 = Math.floor(position) % n;
    const f1 = Math.min(f0 + 1, n - 1);
    const t = position - Math.floor(position);
    const { a, b, mid, dir, up, q, m, s } = this.tmp;
    this.bones.forEach((bone, i) => {
      const ok = this.point(this.frames, f0, f1, t, bone.a, a)
        && (this.point(this.frames, f0, f1, t, bone.b, b) || (bone.alt !== undefined && this.point(this.frames, f0, f1, t, bone.alt, b)));
      if (!ok) { m.makeScale(0, 0, 0); this.boneMesh.setMatrixAt(i, m); return; }
      mid.addVectors(a, b).multiplyScalar(0.5);
      dir.subVectors(b, a);
      const length = dir.length();
      q.setFromUnitVectors(up, dir.normalize());
      m.compose(mid, q, s.set(bone.r, length, bone.r));
      this.boneMesh.setMatrixAt(i, m);
    });
    this.boneMesh.instanceMatrix.needsUpdate = true;
    this.joints.forEach((id, i) => {
      const radius = id < 25 ? 0.07 : 0.04;
      if (this.point(this.frames, f0, f1, t, id, a)) m.compose(a, q.identity(), s.setScalar(radius));
      else m.makeScale(0, 0, 0);
      this.jointMesh.setMatrixAt(i, m);
    });
    this.jointMesh.instanceMatrix.needsUpdate = true;
    const positions = this.faceGeometry.attributes.position.array;
    this.manifest.edges.face.forEach(([pa, pb], i) => {
      const okA = this.point(this.frames, f0, f1, t, 67 + pa, a);
      const okB = this.point(this.frames, f0, f1, t, 67 + pb, b);
      const target = okA && okB ? [a.x, a.y, a.z, b.x, b.y, b.z] : [0, 0, 0, 0, 0, 0];
      positions.set(target, i * 6);
    });
    this.faceGeometry.attributes.position.needsUpdate = true;
    this.faceGeometry.computeBoundingSphere();
  }

  tick() {
    const delta = this.clock.getDelta();
    if (this.playing && this.frames?.length) {
      // Hold the last frame briefly before looping so the end of the sign is readable.
      this.time = (this.time + delta * this.fps * this.speed) % (this.frames.length + this.fps * 0.6);
      this.draw(Math.min(this.time, this.frames.length - 1));
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
