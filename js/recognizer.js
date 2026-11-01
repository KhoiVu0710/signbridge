// In-browser port of the Python recognition pipeline.
// Mirrors models/voya_augment.normalize_body, models/train_voya.summarize_sequences,
// services/recognition.VoyaSequenceRecognizer and services/realtime.RealtimeSignProcessor.
// test_browser_recognizer_matches_python (tests/test_core.py) runs this file under Node
// and compares it with Python.

export const SEQUENCE_LENGTH = 60;
export const POINTS = 535; // pose 25, left hand 21, right hand 21, face 468
export const FEATURES = POINTS * 3; // 1,605
export const MIN_HAND_FRAMES = 24;
export const MIN_POSE_FRAMES = 48;
export const NO_HAND_STATUS_AFTER = 8;
export const PREDICT_EVERY = 4;
export const VOTES_TO_CONFIRM = 2;
// Mirrors services/realtime.FAST_CONFIRM_SCORE (0 = off; measured not worth it).
export const FAST_CONFIRM_SCORE = 0;
const HAND_START = 25 * 3;
const HAND_END = 67 * 3;
const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;
const EPS = 1e-6;
const REGION_SUFFIX = /\s*\((bắc|trung|nam)\)\s*$/u;
export const baseLabel = (label) => String(label).replace(REGION_SUFFIX, "").trim();

function median(values) {
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Assemble one 1,605-value frame from a MediaPipe Holistic result. */
export function assembleFrame(results) {
  const frame = new Float32Array(FEATURES);
  const put = (list, offset, count) => {
    if (!list) return false;
    for (let i = 0; i < count && i < list.length; i++) {
      frame[(offset + i) * 3] = list[i].x;
      frame[(offset + i) * 3 + 1] = list[i].y;
      frame[(offset + i) * 3 + 2] = list[i].z;
    }
    return true;
  };
  const pose = put(results.poseLandmarks, 0, 25);
  const left = put(results.leftHandLandmarks, 25, 21);
  const right = put(results.rightHandLandmarks, 46, 21);
  put(results.faceLandmarks, 67, 468);
  return { frame, hand: left || right, pose };
}

export function hasHand(frame) {
  for (let i = HAND_START; i < HAND_END; i++) if (Math.abs(frame[i]) > EPS) return true;
  return false;
}

export function hasPose(frame) {
  for (let i = 0; i < 75; i++) if (Math.abs(frame[i]) > EPS) return true;
  return false;
}

function pointPresent(frame, p) {
  return Math.abs(frame[p * 3]) > EPS || Math.abs(frame[p * 3 + 1]) > EPS || Math.abs(frame[p * 3 + 2]) > EPS;
}

/** Shoulder-centred, shoulder-width-scaled copy of a 60-frame sequence. */
export function normalizeBody(sequence) {
  const cx = [], cy = [], widths = [];
  for (const frame of sequence) {
    if (!pointPresent(frame, LEFT_SHOULDER) || !pointPresent(frame, RIGHT_SHOULDER)) continue;
    const lx = frame[LEFT_SHOULDER * 3], ly = frame[LEFT_SHOULDER * 3 + 1];
    const rx = frame[RIGHT_SHOULDER * 3], ry = frame[RIGHT_SHOULDER * 3 + 1];
    cx.push((lx + rx) / 2);
    cy.push((ly + ry) / 2);
    widths.push(Math.hypot(lx - rx, ly - ry));
  }
  if (!widths.length) return sequence;
  const centreX = Math.fround(median(cx.map(Math.fround)));
  const centreY = Math.fround(median(cy.map(Math.fround)));
  const width = median(widths);
  if (width <= 1e-4) return sequence;
  return sequence.map((frame) => {
    const out = new Float32Array(FEATURES);
    for (let p = 0; p < POINTS; p++) {
      if (!pointPresent(frame, p)) continue;
      out[p * 3] = (frame[p * 3] - centreX) / width;
      out[p * 3 + 1] = (frame[p * 3 + 1] - centreY) / width;
      out[p * 3 + 2] = frame[p * 3 + 2] / width;
    }
    return out;
  });
}

/** Temporal mean, population standard deviation and mean absolute frame delta. */
export function summarize(sequence, bodyNormalized) {
  if (sequence.length !== SEQUENCE_LENGTH) throw new Error(`Expected 60 frames, got ${sequence.length}`);
  const frames = bodyNormalized ? normalizeBody(sequence) : sequence;
  const out = new Float64Array(FEATURES * 3);
  for (let f = 0; f < FEATURES; f++) {
    let sum = 0;
    for (let t = 0; t < SEQUENCE_LENGTH; t++) sum += frames[t][f];
    const mean = sum / SEQUENCE_LENGTH;
    let sq = 0, motion = 0;
    for (let t = 0; t < SEQUENCE_LENGTH; t++) {
      const d = frames[t][f] - mean;
      sq += d * d;
      if (t) motion += Math.abs(frames[t][f] - frames[t - 1][f]);
    }
    out[f] = mean;
    out[FEATURES + f] = Math.sqrt(sq / SEQUENCE_LENGTH);
    out[2 * FEATURES + f] = motion / (SEQUENCE_LENGTH - 1);
  }
  return out;
}

export class TemporalModel {
  constructor(json) {
    if (json.format !== "signbridge-voya-temporal-v1") throw new Error("Unsupported model format");
    this.json = json;
    this.classes = json.classes;
    this.indices = json.selected_indices;
    this.k = this.indices.length;
    this.mean = Float64Array.from(json.scaler_mean);
    this.scale = Float64Array.from(json.scaler_scale);
    this.coef = Float64Array.from(json.coef);
    this.intercept = Float64Array.from(json.intercept);
    this.threshold = json.threshold;
    this.margin = json.margin_threshold;
    this.limits = json.global_profile_limits || { mean_abs_z: 4, max_abs_z: 20 };
    this.profiles = {};
    for (const [label, profile] of Object.entries(json.profiles || {})) {
      this.profiles[label] = { center: Float64Array.from(profile.center), radius: profile.radius };
    }
  }

  standardized(summary) {
    const row = new Float64Array(this.k);
    for (let i = 0; i < this.k; i++) row[i] = (summary[this.indices[i]] - this.mean[i]) / this.scale[i];
    return row;
  }

  probabilities(row) {
    const n = this.classes.length;
    const logits = new Float64Array(n);
    let max = -Infinity;
    for (let c = 0; c < n; c++) {
      let z = this.intercept[c];
      const base = c * this.k;
      for (let i = 0; i < this.k; i++) z += this.coef[base + i] * row[i];
      logits[c] = z;
      if (z > max) max = z;
    }
    let total = 0;
    for (let c = 0; c < n; c++) { logits[c] = Math.exp(logits[c] - max); total += logits[c]; }
    for (let c = 0; c < n; c++) logits[c] /= total;
    return logits;
  }

  domainStatus(row, label) {
    let sumAbs = 0, maxAbs = 0;
    for (const v of row) { const a = Math.abs(v); sumAbs += a; if (a > maxAbs) maxAbs = a; }
    if (sumAbs / row.length > this.limits.mean_abs_z || maxAbs > this.limits.max_abs_z) return "feature_range";
    const profile = this.profiles[label];
    if (profile) {
      if (profile.center.length !== row.length) return "profile_mismatch";
      let sq = 0;
      for (let i = 0; i < row.length; i++) { const d = row[i] - profile.center[i]; sq += d * d; }
      if (Math.sqrt(sq / row.length) > profile.radius) return "class_distance";
    }
    return null;
  }

  rowFor(sequence) {
    return this.standardized(summarize(sequence, this.json.body_normalized));
  }

  /** Port of VoyaSequenceRecognizer._regional_group_label. */
  regionalGroupLabel(probs, predicted) {
    const groups = new Map(), sizes = new Map();
    this.classes.forEach((label, i) => {
      const base = baseLabel(label);
      groups.set(base, (groups.get(base) || 0) + probs[i]);
      sizes.set(base, (sizes.get(base) || 0) + 1);
    });
    const best = baseLabel(predicted);
    if (sizes.get(best) < 2) return "Unknown";
    let other = 0;
    for (const [base, value] of groups) if (base !== best && value > other) other = value;
    const score = groups.get(best);
    return score >= this.threshold && score - other >= this.margin ? best : "Unknown";
  }

  /** Same decision rule as VoyaSequenceRecognizer.predict_sequence. */
  predictSequence(sequence) {
    const row = this.rowFor(sequence);
    const probs = this.probabilities(row);
    const order = Array.from(probs.keys()).sort((a, b) => probs[b] - probs[a]);
    const best = order[0];
    const score = probs[best];
    const second = order.length > 1 ? probs[order[1]] : 0;
    const top = order.slice(0, 3).map((i) => ({ label: this.classes[i], score: probs[i] }));
    let label = score >= this.threshold && score - second >= this.margin ? this.classes[best] : "Unknown";
    if (label === "Unknown") label = this.regionalGroupLabel(probs, this.classes[best]);
    let rejection = null;
    if (label !== "Unknown") {
      rejection = this.domainStatus(row, this.classes[best]);
      if (rejection) label = "Unknown";
    }
    return { label, score, top, rejection, row };
  }
}

/** Sliding-window live session; mirrors RealtimeSignProcessor._predict_voya. */
export class LiveSession {
  constructor(model, { personal = null } = {}) {
    this.model = model;
    // Optional matcher from personal.js: the signer's own recorded signs.
    this.personal = personal;
    // Models trained with short clips carry their own live rule.
    this.minHandFrames = model.json?.live?.min_hand_frames ?? MIN_HAND_FRAMES;
    this.reset();
  }

  reset() {
    this.frames = [];
    this.hands = [];
    this.poses = [];
    this.mirror = [];
    this.recent = [];
    this.sincePrediction = 0;
    this.missingHand = 0;
    this.lastLabel = null;
    this.state = { status: "idle", handFrames: 0, windowFrames: 0, lastLabel: null };
  }

  push(frame, hand, pose) {
    this.frames.push(frame); this.hands.push(hand); this.poses.push(pose);
    if (this.frames.length > SEQUENCE_LENGTH) { this.frames.shift(); this.hands.shift(); this.poses.shift(); }
    if (pose) {
      this.mirror.push(frame[LEFT_SHOULDER * 3] < frame[RIGHT_SHOULDER * 3]);
      if (this.mirror.length > SEQUENCE_LENGTH) this.mirror.shift();
    }
    this.missingHand = hand ? 0 : this.missingHand + 1;
    const handFrames = this.hands.filter(Boolean).length;
    const poseFrames = this.poses.filter(Boolean).length;
    const base = {
      handFrames,
      handFramesNeeded: this.minHandFrames,
      windowFrames: this.frames.length,
      lastLabel: this.lastLabel,
      mirrored: this.mirror.length >= 15 && this.mirror.filter(Boolean).length > this.mirror.length * 0.8,
    };
    const set = (status, extra = {}) => (this.state = { ...base, status, ...extra, lastLabel: this.lastLabel });
    const halt = () => { this.recent = []; this.sincePrediction = 0; };

    if (!pose && !hand) { halt(); return set("no_body"); }
    if (handFrames < this.minHandFrames) {
      halt();
      return set(this.missingHand >= NO_HAND_STATUS_AFTER ? "no_hand" : "sampling");
    }
    if (this.frames.length < SEQUENCE_LENGTH) return set("sampling");
    if (poseFrames < MIN_POSE_FRAMES) { halt(); return set("no_body"); }

    this.sincePrediction += 1;
    if (!(this.sincePrediction === 1 || this.sincePrediction % PREDICT_EVERY === 0)) {
      const keep = ["recognized", "unknown"].includes(this.state.status) ? this.state.status : "comparing";
      return set(keep, { label: this.state.label, top: this.state.top, rejection: this.state.rejection });
    }
    let result = this.model.predictSequence(this.frames);
    const own = this.personal?.(result.row);
    if (own) {
      // The signer's own sample wins; still needs two agreeing votes (score kept below fast-confirm).
      result = { ...result, label: own.word, score: Math.min(result.score, 0.9), rejection: null, personal: true, top: [{ label: own.word, score: 1 }, ...result.top.filter((t) => t.label !== own.word)].slice(0, 3) };
    }
    if (result.label === "Unknown") {
      this.recent = [];
      return set("unknown", { top: result.top, rejection: result.rejection });
    }
    this.recent.push(result.label);
    if (this.recent.length > 3) this.recent.shift();
    const votes = this.recent.filter((l) => l === result.label).length;
    if (votes >= VOTES_TO_CONFIRM || (FAST_CONFIRM_SCORE && result.score >= FAST_CONFIRM_SCORE)) {
      const isNew = this.lastLabel !== result.label || this.state.status !== "recognized";
      this.lastLabel = result.label;
      return set("recognized", { label: result.label, top: result.top, isNew });
    }
    return set("comparing", { top: result.top });
  }
}

/* ---------- v6: hand shape + temporal segments + MLP ---------- */
// Port of models/sequence_features.py and models/sequence_model.py.
const FRAME_FEATURES = 146;
const SEGMENTS = 4;
const POSE_POINTS = [0, 11, 12, 13, 14, 15, 16];

export function segmentFrameFeatures(sequence) {
  const n = sequence.length;
  const cx = [], cy = [], widths = [];
  for (const f of sequence) {
    if (!pointPresent(f, 11) || !pointPresent(f, 12)) continue;
    cx.push(Math.fround((f[33] + f[36]) / 2));
    cy.push(Math.fround((f[34] + f[37]) / 2));
    widths.push(Math.hypot(f[33] - f[36], f[34] - f[37]));
  }
  const out = sequence.map(() => new Float64Array(FRAME_FEATURES));
  if (!widths.length) return out;
  const centreX = median(cx), centreY = median(cy), width = median(widths);
  if (width <= 1e-4) return out;
  sequence.forEach((f, t) => {
    const row = out[t];
    POSE_POINTS.forEach((p, i) => {
      if (!pointPresent(f, p)) return;
      row[i * 2] = (f[p * 3] - centreX) / width;
      row[i * 2 + 1] = (f[p * 3 + 1] - centreY) / width;
    });
    [25, 46].forEach((start, slot) => {
      if (!pointPresent(f, start)) return;
      const base = 14 + slot * 66;
      const wx = f[start * 3], wy = f[start * 3 + 1], wz = f[start * 3 + 2];
      let size = 0;
      for (let k = 0; k < 21; k++) size = Math.max(size, Math.hypot(f[(start + k) * 3] - wx, f[(start + k) * 3 + 1] - wy));
      if (size <= 1e-4) return;
      row[base] = 1;
      row[base + 1] = (wx - centreX) / width;
      row[base + 2] = (wy - centreY) / width;
      for (let k = 0; k < 21; k++) {
        row[base + 3 + k * 3] = (f[(start + k) * 3] - wx) / size;
        row[base + 4 + k * 3] = (f[(start + k) * 3 + 1] - wy) / size;
        row[base + 5 + k * 3] = (f[(start + k) * 3 + 2] - wz) / size;
      }
    });
  });
  return out;
}

export function segmentSummary(sequence) {
  if (sequence.length !== SEQUENCE_LENGTH) throw new Error(`Expected 60 frames, got ${sequence.length}`);
  const frames = segmentFrameFeatures(sequence);
  const per = SEQUENCE_LENGTH / SEGMENTS;
  const out = new Float64Array(FRAME_FEATURES * (SEGMENTS + 2));
  for (let j = 0; j < FRAME_FEATURES; j++) {
    for (let s = 0; s < SEGMENTS; s++) {
      let sum = 0;
      for (let t = s * per; t < (s + 1) * per; t++) sum += frames[t][j];
      out[s * FRAME_FEATURES + j] = sum / per;
    }
    let sum = 0;
    for (let t = 0; t < SEQUENCE_LENGTH; t++) sum += frames[t][j];
    const mean = sum / SEQUENCE_LENGTH;
    let sq = 0, motion = 0;
    for (let t = 0; t < SEQUENCE_LENGTH; t++) {
      sq += (frames[t][j] - mean) ** 2;
      if (t) motion += Math.abs(frames[t][j] - frames[t - 1][j]);
    }
    out[SEGMENTS * FRAME_FEATURES + j] = Math.sqrt(sq / SEQUENCE_LENGTH);
    out[(SEGMENTS + 1) * FRAME_FEATURES + j] = motion / (SEQUENCE_LENGTH - 1);
  }
  return out;
}

export class SegmentModel extends TemporalModel {
  constructor(json) {
    super({ ...json, format: "signbridge-voya-temporal-v1", selected_indices: [...Array(json.scaler_mean.length).keys()], coef: [], intercept: [] });
    this.json = json;
    this.hidden = json.hidden;
    this.w1 = Float64Array.from(json.w1);
    this.b1 = Float64Array.from(json.b1);
    this.w2 = Float64Array.from(json.w2);
    this.b2 = Float64Array.from(json.b2);
  }

  rowFor(sequence) {
    return this.standardized(segmentSummary(sequence));
  }

  probabilities(row) {
    const h = new Float64Array(this.hidden);
    for (let j = 0; j < this.hidden; j++) {
      let z = this.b1[j];
      for (let i = 0; i < row.length; i++) z += row[i] * this.w1[i * this.hidden + j];
      h[j] = z > 0 ? z : 0;
    }
    const n = this.classes.length;
    const logits = new Float64Array(n);
    let max = -Infinity;
    for (let c = 0; c < n; c++) {
      let z = this.b2[c];
      for (let j = 0; j < this.hidden; j++) z += h[j] * this.w2[j * n + c];
      logits[c] = z;
      if (z > max) max = z;
    }
    let total = 0;
    for (let c = 0; c < n; c++) { logits[c] = Math.exp(logits[c] - max); total += logits[c]; }
    for (let c = 0; c < n; c++) logits[c] /= total;
    return logits;
  }
}

/** Pick the right model class for an exported JSON file. */
export function createModel(json) {
  return json.format === "signbridge-seq-v6" ? new SegmentModel(json) : new TemporalModel(json);
}
