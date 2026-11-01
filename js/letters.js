// Fingerspelling: recognise one static VSL manual-alphabet sign per held hand
// pose. letterFeatures is a 1:1 port of models/letter_features.py.

const Z_WEIGHT = 0.5;
const TIPS = [4, 8, 12, 16, 20];
const THUMB_TARGETS = [5, 6, 9, 10, 13, 17];
const FINGERS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]];
const TIP_PAIRS = [];
TIPS.forEach((a, i) => TIPS.slice(i + 1).forEach((b) => TIP_PAIRS.push([a, b])));
THUMB_TARGETS.forEach((t) => TIP_PAIRS.push([4, t]));
export const LETTER_FEATURES = 60 + TIP_PAIRS.length + 15 + 3; // 94

// Hold-to-commit rules (frames at ~20-25 fps).
export const HOLD_FRAMES = 9;
export const MIN_SCORE = 0.7;
export const MAX_MOTION = 0.09; // mean point movement per frame, in hand sizes
export const RELEASE_FRAMES = 3;      // another letter (or no hand) this long releases the lock
export const RELEASE_UNSURE_FRAMES = 12; // an unsure hand must stay unsure this long (~0.5 s)
export const END_SYLLABLE_FRAMES = 18;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v) => Math.hypot(v[0], v[1], v[2]);

/** points: 21 x [x, y, z] in pixels -> Float64Array(94). */
export function letterFeatures(points) {
  const out = new Float64Array(LETTER_FEATURES);
  const w = points[0];
  const p = points.map((pt) => [pt[0] - w[0], pt[1] - w[1], pt[2] - w[2]]);
  const size = Math.hypot(p[9][0], p[9][1]);
  if (size <= 1e-6) return out;
  const q = p.map((pt) => [pt[0] / size, pt[1] / size, (pt[2] / size) * Z_WEIGHT]);
  for (let i = 1; i < 21; i++) for (let j = 0; j < 3; j++) out[(i - 1) * 3 + j] = q[i][j];
  let k = 60;
  for (const [a, b] of TIP_PAIRS) out[k++] = norm(sub(q[a], q[b]));
  for (const chain of FINGERS) {
    for (let j = 1; j < 4; j++) {
      const u = sub(q[chain[j]], q[chain[j - 1]]);
      const v = sub(q[chain[j + 1]], q[chain[j]]);
      const denom = norm(u) * norm(v);
      out[k++] = denom > 1e-9 ? (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / denom : 0;
    }
  }
  const a = q[5], b = q[17];
  const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const length = norm(n);
  if (length > 1e-9) for (let j = 0; j < 3; j++) out[k + j] = n[j] / length;
  return out;
}

/** The raised hand of a Holistic result, in pixels; the bigger one if both are up. */
export function pickHand(results, width, height) {
  const hands = [results.leftHandLandmarks, results.rightHandLandmarks].filter((h) => h && h.length === 21);
  if (!hands.length) return null;
  const toPixels = (h) => h.map((p) => [p.x * width, p.y * height, p.z * width]);
  const span = (h) => Math.hypot(h[9][0] - h[0][0], h[9][1] - h[0][1]);
  return hands.map(toPixels).sort((a, b) => span(b) - span(a))[0];
}

export class LetterModel {
  constructor(json) {
    this.json = json;
    this.classes = json.classes;
    this.none = json.none_label;
    this.mean = Float64Array.from(json.scaler_mean);
    this.scale = Float64Array.from(json.scaler_scale);
    this.hidden = json.hidden;
    this.w1 = Float64Array.from(json.w1);
    this.b1 = Float64Array.from(json.b1);
    this.w2 = Float64Array.from(json.w2);
    this.b2 = Float64Array.from(json.b2);
    this.templates = json.templates || {};
  }

  get letters() { return this.classes.filter((c) => c !== this.none); }

  standardized(features) {
    return features.map((v, i) => (v - this.mean[i]) / (this.scale[i] || 1));
  }

  probabilities(row) {
    const h = new Float64Array(this.hidden);
    for (let j = 0; j < this.hidden; j++) {
      let z = this.b1[j];
      for (let i = 0; i < row.length; i++) z += row[i] * this.w1[i * this.hidden + j];
      h[j] = z > 0 ? z : 0;
    }
    const n = this.classes.length;
    const out = new Float64Array(n);
    let max = -Infinity;
    for (let c = 0; c < n; c++) {
      let z = this.b2[c];
      for (let j = 0; j < this.hidden; j++) z += h[j] * this.w2[j * n + c];
      out[c] = z;
      if (z > max) max = z;
    }
    let total = 0;
    for (let c = 0; c < n; c++) { out[c] = Math.exp(out[c] - max); total += out[c]; }
    for (let c = 0; c < n; c++) out[c] /= total;
    return out;
  }

  /** Best letter for a hand (pixels): { label, score, row }. label is null for "not a letter". */
  classify(points) {
    const row = this.standardized(letterFeatures(points));
    const proba = this.probabilities(row);
    let best = 0;
    for (let c = 1; c < proba.length; c++) if (proba[c] > proba[best]) best = c;
    const label = this.classes[best];
    return { label: label === this.none ? null : label, score: proba[best], row };
  }
}

function rms(a, b) {
  let sq = 0;
  for (let i = 0; i < a.length; i++) sq += (a[i] - b[i]) ** 2;
  return Math.sqrt(sq / a.length);
}

/** Letters the signer taught with their own hand (standardized rows, this browser only). */
export class PersonalLetters {
  constructor(storageKey = "signbridge-letters-personal-v1") {
    this.key = storageKey;
    try { this.data = JSON.parse(localStorage.getItem(this.key)) || {}; } catch { this.data = {}; }
  }

  save() { try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch { /* storage full */ } }

  forModel(version) { return this.data[version] || {}; }

  set(version, letter, rows) {
    this.data[version] ??= {};
    this.data[version][letter] = rows.map((r) => Array.from(r, (v) => Math.round(v * 1000) / 1000));
    this.save();
  }

  remove(version, letter) { if (this.data[version]) { delete this.data[version][letter]; this.save(); } }

  /** Nearest taught letter if it is clearly closer than other taught letters' spread. */
  match(version, row) {
    const taught = this.forModel(version);
    let best = null;
    for (const [letter, rows] of Object.entries(taught)) {
      for (const sample of rows) {
        const d = rms(row, sample);
        if (!best || d < best.distance) best = { letter, distance: d };
      }
    }
    return best && best.distance <= PERSONAL_RADIUS ? best.letter : null;
  }
}
export const PERSONAL_RADIUS = 0.35; // RMS in standardized units; ~94% own-letter hits, ~2% other letters on held-out frames

/**
 * Turns per-frame hands into committed letters. One held pose = one letter:
 * after a commit the letter is locked until the hand changes shape or drops,
 * so holding a sign never types it twice.
 */
export class LetterSpeller {
  constructor(model, { personal = null, version = "" } = {}) {
    this.model = model;
    this.personal = personal;
    this.version = version;
    this.reset();
  }

  reset() {
    this.candidate = null;
    this.streak = 0;
    this.locked = null;
    this.away = 0;
    this.unsure = 0;
    this.missing = 0;
    this.previous = null;
    this.syllableOpen = false;
  }

  /** Call when the text was edited by hand, so a lowered hand does not add a space. */
  closeSyllable() { this.syllableOpen = false; }

  /**
   * points: 21 x [x, y, z] pixels or null. Returns
   * { label, progress, commit, endSyllable, hand } — commit is the letter to add now.
   */
  push(points) {
    const out = { label: null, progress: 0, commit: null, endSyllable: false, hand: !!points };
    if (!points) {
      this.missing++;
      this.previous = null;
      this.candidate = null;
      this.streak = 0;
      if (this.missing >= RELEASE_FRAMES) this.locked = null;
      if (this.missing === END_SYLLABLE_FRAMES && this.syllableOpen) { out.endSyllable = true; this.syllableOpen = false; }
      return out;
    }
    this.missing = 0;
    const size = Math.max(1e-6, Math.hypot(points[9][0] - points[0][0], points[9][1] - points[0][1]));
    let motion = 0;
    if (this.previous) {
      for (let i = 0; i < 21; i++) motion += Math.hypot(points[i][0] - this.previous[i][0], points[i][1] - this.previous[i][1]);
      motion /= 21 * size;
    }
    this.previous = points;
    const result = this.model.classify(points);
    let label = result.score >= MIN_SCORE ? result.label : null;
    const own = this.personal?.match(this.version, result.row);
    if (own) label = own;
    out.label = label;

    // A brief dip in certainty while holding a letter must not type it again.
    this.away = label && label !== this.locked ? this.away + 1 : 0;
    this.unsure = label ? 0 : this.unsure + 1;
    if (this.locked && (this.away >= RELEASE_FRAMES || this.unsure >= RELEASE_UNSURE_FRAMES)) this.locked = null;

    const steady = motion <= MAX_MOTION;
    if (label && steady && label !== this.locked) {
      this.streak = label === this.candidate ? this.streak + 1 : 1;
      this.candidate = label;
    } else if (!label || label !== this.candidate) {
      this.candidate = label && label !== this.locked ? label : null;
      this.streak = 0;
    }
    out.progress = this.candidate ? Math.min(1, this.streak / HOLD_FRAMES) : 0;
    if (this.candidate && this.streak >= HOLD_FRAMES) {
      out.commit = this.candidate;
      this.locked = this.candidate;
      this.away = 0;
      this.unsure = 0;
      this.candidate = null;
      this.streak = 0;
      this.syllableOpen = true;
    }
    return out;
  }
}
