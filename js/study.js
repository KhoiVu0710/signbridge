// User study mode: measures recognition with real signers, one target sign
// per trial. Stores only results (and, with separate consent, landmark
// coordinates of each attempt); never images or video.
import { LiveSession, baseLabel } from "./recognizer.js";
import { SignCamera } from "./camera.js";
import { REGION_NAMES, parseLabel } from "./lookup.js";

const $ = (id) => document.getElementById(id);
const STORE = "signbridge-study-v1";
const TIMEOUT_MS = 12000;

function loadAll() {
  try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; }
}
function saveAll(rows) {
  try { localStorage.setItem(STORE, JSON.stringify(rows)); } catch { /* storage full or private mode */ }
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

export function initStudy({ getModel, getSigns, openSign }) {
  const study = { trials: [], index: 0, results: [], landmarks: [], camera: null, session: null, started: 0, active: false, timer: null };

  function show(part) {
    $("study-intro").hidden = part !== "intro";
    $("study-run").hidden = part !== "run";
    $("study-summary").hidden = part !== "summary";
  }

  $("study-intro").addEventListener("submit", async (event) => {
    event.preventDefault();
    const model = getModel();
    const signs = getSigns();
    if (!model || !signs.length) return;
    study.meta = {
      participant: $("study-code").value.trim(),
      profile: $("study-profile").value,
      region: $("study-region").value,
      donate: $("study-donate").checked,
      model: model.json.model_version,
      started: new Date().toISOString(),
    };
    study.trials = shuffle(signs).slice(0, Number($("study-count").value));
    study.index = 0;
    study.results = [];
    study.landmarks = [];
    show("run");
    study.camera ??= new SignCamera({ video: $("study-video"), canvas: $("study-overlay"), onFrame });
    try {
      await study.camera.start();
    } catch {
      $("study-status").textContent = "Chưa bật được camera. Cho phép camera trong trình duyệt rồi thử lại.";
      return;
    }
    nextTrial();
  });

  function nextTrial() {
    clearTimeout(study.timer);
    study.active = false;
    $("study-feedback").hidden = true;
    $("study-next").hidden = true;
    $("study-go").hidden = false;
    $("study-meter").hidden = true;
    if (study.index >= study.trials.length) { finish(); return; }
    const sign = study.trials[study.index];
    const { base, region } = parseLabel(sign.label);
    $("study-progress").textContent = `Ký hiệu ${study.index + 1} / ${study.trials.length}`;
    $("study-word").textContent = base;
    $("study-region-note").textContent = region ? `Biến thể ${REGION_NAMES[region]}` : "";
    $("study-status").textContent = "Hạ tay xuống, bấm Bắt đầu ký, rồi ký từ này một lần.";
  }

  $("study-go").addEventListener("click", () => {
    study.session = new LiveSession(getModel());
    study.started = performance.now();
    study.active = true;
    $("study-go").hidden = true;
    $("study-status").textContent = "Đang chờ ký hiệu…";
    study.timer = setTimeout(() => record(null, []), TIMEOUT_MS);
  });
  $("study-next").addEventListener("click", () => { study.index += 1; nextTrial(); });
  $("study-skip").addEventListener("click", () => { record("skipped", []); });
  $("study-stop").addEventListener("click", finish);
  $("study-demo").addEventListener("click", () => {
    const sign = study.trials[study.index];
    if (sign) openSign(sign);
  });

  function onFrame(frame, hand, pose) {
    if (!study.active) return;
    const state = study.session.push(frame, hand, pose);
    const elapsed = performance.now() - study.started;
    $("study-meter").hidden = false;
    $("study-meter-fill").style.width = `${Math.min(100, (elapsed / TIMEOUT_MS) * 100)}%`;
    if (state.status === "sampling") $("study-status").textContent = `Đang ghi động tác: ${Math.min(state.handFrames, state.handFramesNeeded)}/${state.handFramesNeeded} khung có tay`;
    else if (state.status === "no_body") $("study-status").textContent = "Lùi ra để camera thấy đầu, vai và hai tay";
    if (state.status === "recognized") record(state.label, state.top || []);
  }

  function record(label, top) {
    if (!study.active && label !== "skipped") return;
    if (study.results.some((r) => r.trial === study.index + 1)) return;
    study.active = false;
    clearTimeout(study.timer);
    const target = study.trials[study.index];
    const seconds = (performance.now() - study.started) / 1000;
    let outcome;
    if (label === "skipped") outcome = "bỏ qua";
    else if (label === null) outcome = "không nhận ra";
    else if (label === target.label) outcome = "đúng";
    else if (baseLabel(label) === baseLabel(target.label)) outcome = "đúng từ, khác vùng";
    else outcome = "sai";
    const row = {
      ...study.meta,
      trial: study.index + 1,
      target: target.label,
      recognized: label === "skipped" ? "" : label ?? "",
      outcome,
      seconds: label === "skipped" ? "" : seconds.toFixed(1),
      fps: study.camera?.fps ? study.camera.fps.toFixed(1) : "",
      nearest: (top || []).map((t) => t.label).join(" | "),
      time: new Date().toISOString(),
    };
    study.results.push(row);
    saveAll([...loadAll(), row]);
    if (study.meta.donate && study.session?.frames?.length === 60 && label !== "skipped") {
      // Coordinates only, quantized; no image data.
      const frames = study.session.frames.map((f) => Array.from(f, (v) => Math.round(v * 10000)));
      study.landmarks.push({ participant: study.meta.participant, target: target.label, recognized: row.recognized, outcome, scale: 10000, frames });
    }
    const feedback = $("study-feedback");
    feedback.hidden = false;
    feedback.className = `study-feedback ${outcome.startsWith("đúng") ? "ok" : outcome === "sai" ? "bad" : "none"}`;
    feedback.textContent = outcome === "đúng" ? "Đúng" : outcome === "sai" ? `Sai: ứng dụng nhận thành “${parseLabel(label).base}”` : outcome === "đúng từ, khác vùng" ? "Đúng từ, khác biến thể vùng miền" : outcome === "bỏ qua" ? "Đã bỏ qua" : "Ứng dụng không nhận ra trong 12 giây";
    $("study-meter").hidden = true;
    $("study-go").hidden = true;
    $("study-next").hidden = false;
    $("study-next").focus();
  }

  function finish() {
    clearTimeout(study.timer);
    study.active = false;
    study.camera?.stop();
    show("summary");
    const done = study.results.filter((r) => r.outcome !== "bỏ qua");
    const right = done.filter((r) => r.outcome.startsWith("đúng")).length;
    const wrong = done.filter((r) => r.outcome === "sai").length;
    const none = done.filter((r) => r.outcome === "không nhận ra").length;
    const times = done.filter((r) => r.outcome.startsWith("đúng")).map((r) => Number(r.seconds));
    const avg = times.length ? (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) : "–";
    $("study-score").textContent = done.length
      ? `Đúng ${right}/${done.length}, sai ${wrong}, không nhận ra ${none}. Thời gian trung bình khi đúng: ${avg} giây.`
      : "Chưa có lượt thử nào.";
    const list = $("study-results");
    list.replaceChildren(...study.results.map((r) => {
      const item = document.createElement("li");
      const left = document.createElement("span");
      left.textContent = `${r.trial}. ${r.target}`;
      const right = document.createElement("span");
      right.textContent = r.outcome === "sai" ? `sai (${r.recognized})` : r.outcome;
      item.append(left, right);
      return item;
    }));
    $("study-json").hidden = !study.landmarks.length;
  }

  $("study-csv").addEventListener("click", () => {
    const rows = loadAll();
    const columns = ["participant", "profile", "region", "model", "trial", "target", "recognized", "outcome", "seconds", "fps", "nearest", "donate", "time"];
    const text = [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n");
    download(`signbridge-thu-nghiem-${new Date().toISOString().slice(0, 10)}.csv`, "﻿" + text, "text/csv;charset=utf-8");
  });
  $("study-json").addEventListener("click", () => {
    download(`signbridge-toa-do-${study.meta.participant || "P"}.json`, JSON.stringify({ format: "signbridge-landmarks-v1", layout: "VOYA 1605 (pose 25, left hand 21, right hand 21, face 468; xyz)", consent: "participant agreed to donate coordinates only", attempts: study.landmarks }), "application/json");
  });
  $("study-again").addEventListener("click", () => {
    $("study-intro").reset();
    show("intro");
  });

  return {
    leave() { if (study.camera?.running) finish(); },
  };
}
