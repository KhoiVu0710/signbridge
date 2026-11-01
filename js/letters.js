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

/*
 * Tones: VSL signs them with only the little finger out, drawing the mark in
 * the air (sắc up, huyền down to the side, hỏi a hook, ngã a wave, nặng a
 * short drop). No recorded data exists, so these are geometric rules on the
 * little-finger path; directions use image up/down only, so either hand and a
 * mirrored camera give the same result.
 */
export const STROKE_WINDOW = 6;       // frames looked back to start a stroke
export const STROKE_START = 0.18;     // little-finger tip travel (hand sizes) within the window that starts one
export const STROKE_STOP = 0.08;      // travel over the last 3 frames below this ends it
export const STROKE_SHAPE_GRACE = 5; // frames the hand may lose the shape mid-stroke (motion blur)
export const STROKE_MAX_FRAMES = 45;
export const STROKE_MIN_LENGTH = 0.4; // hand sizes
export const PINKY_HOLD_FRAMES = 14;  // I and Y share the tone hand shape, so they need a longer hold

/** Only the little finger out (I, Y and the tone hand): from 21 points in any units. */
export function pinkyOnly(points) {
  const d = (a, b) => Math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1], points[a][2] - points[b][2]);
  const size = d(0, 9);
  if (size <= 1e-6) return false;
  return d(20, 0) / size >= 1.7 && [8, 12, 16].every((tip) => d(tip, 0) / size <= 1.2);
}

/**
 * Tone for a little-finger path ([[x, y]] in hand sizes, image y down), or
 * null when it is not a clear mark.
 */
export function classifyStroke(path) {
  if (path.length < 3) return null;
  // light smoothing so camera jitter does not read as a curve or a wave
  path = path.map((p, i) => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    return [(a[0] + p[0] + b[0]) / 3, (a[1] + p[1] + b[1]) / 3];
  });
  let length = 0;
  for (let i = 1; i < path.length; i++) length += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  if (length < STROKE_MIN_LENGTH) return null;
  const [x0, y0] = path[0], [x1, y1] = path[path.length - 1];
  const dx = x1 - x0, dy = y1 - y0;
  const straight = Math.hypot(dx, dy) / length;
  const xs = path.map((p) => p[0]), ys = path.map((p) => p[1]);
  const width = Math.max(...xs) - Math.min(...xs), height = Math.max(...ys) - Math.min(...ys);
  const turns = (values) => {
    // direction changes larger than a small hysteresis, so jitter is not a turn
    let count = 0, dir = 0, anchor = values[0];
    for (const v of values) {
      const step = v - anchor;
      if (Math.abs(step) < 0.12) continue;
      const now = Math.sign(step);
      if (dir && now !== dir) count++;
      dir = now;
      anchor = v;
    }
    return count;
  };
  const yTurns = turns(ys);
  if (yTurns >= 2 || (yTurns >= 1 && width > height * 1.1 && straight < 0.85)) return "nga";
  if (straight < 0.7) return "hoi";
  if (dy < 0 && -dy >= 0.35 * Math.hypot(dx, dy)) return "sac";
  if (dy > 0 && dy >= 0.35 * Math.hypot(dx, dy)) return Math.abs(dx) >= 0.4 * dy ? "huyen" : "nang";
  return null;
}

/**
 * Turns per-frame hands into committed letters. One held pose = one letter:
 * after a commit the letter is locked until the hand changes shape or drops,
 * so holding a sign never types it twice. A moving little finger draws a tone.
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
    this.stroke = null;
    this.tips = [];
    this.size = 0;
  }

  /** Call when the text was edited by hand, so a lowered hand does not add a space. */
  closeSyllable() { this.syllableOpen = false; }

  /**
   * points: 21 x [x, y, z] pixels or null. Returns
   * { label, progress, commit, tone, stroking, endSyllable, hand } — commit is the
   * letter to add now, tone a drawn tone mark ("sac", "huyen", "hoi", "nga", "nang").
   */
  push(points) {
    const out = { label: null, progress: 0, commit: null, tone: null, stroking: false, endSyllable: false, hand: !!points };
    if (!points) {
      if (this.stroke) this.finishStroke({ keep: false }); // lowering the hand is not a mark
      this.tips = [];
      this.size = 0;
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
    if (this.trackStroke(points, out)) return out;
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
    const hold = this.candidate === "i" || this.candidate === "y" ? PINKY_HOLD_FRAMES : HOLD_FRAMES;
    out.progress = this.candidate ? Math.min(1, this.streak / hold) : 0;
    if (this.candidate && this.streak >= hold) {
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

  /** Follows a little-finger stroke; true while one is being drawn (no letters meanwhile). */
  trackStroke(points, out) {
    // a smoothed hand size: per-frame size jitter would otherwise move the scaled tip
    const size = Math.max(1e-6, Math.hypot(points[9][0] - points[0][0], points[9][1] - points[0][1]));
    this.size = this.size ? this.size * 0.8 + size * 0.2 : size;
    const tip = [points[20][0] / this.size, points[20][1] / this.size];
    const shape = pinkyOnly(points);
    const travel = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (!this.stroke) {
      this.tips = shape ? [...this.tips.slice(1 - STROKE_WINDOW), tip] : [];
      if (this.tips.length < 2 || travel(tip, this.tips[0]) < STROKE_START) return false;
      // the path starts where the finger was before it moved, so short marks keep their length
      this.stroke = { path: [...this.tips], off: 0 };
      this.candidate = null;
      this.streak = 0;
    } else {
      this.stroke.path.push(tip);
    }
    const st = this.stroke;
    st.off = shape ? 0 : st.off + 1;
    out.stroking = true;
    const n = st.path.length;
    const stopped = n >= STROKE_WINDOW && travel(st.path[n - 1], st.path[n - 4]) < STROKE_STOP;
    // Only a stroke that ends with the hand still in view and in shape counts; a hand
    // relaxing or dropping out of the picture is not a mark.
    if (stopped || n >= STROKE_MAX_FRAMES) out.tone = this.finishStroke({ keep: true, held: shape ? "i" : null });
    else if (st.off >= STROKE_SHAPE_GRACE) this.finishStroke({ keep: false });
    return true;
  }

  finishStroke({ keep, held = null }) {
    const st = this.stroke;
    this.stroke = null;
    this.tips = [];
    // The hand usually stays in the little-finger shape: do not type an I after the mark.
    if (held) this.locked = held;
    const tone = keep ? classifyStroke(st.path) : null;
    if (tone) this.syllableOpen = true;
    return tone;
  }
}
