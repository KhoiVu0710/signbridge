// "Kiểm tra bảng chữ cái": measure fingerspelling with real people. The app
// shows a random letter, the participant signs it, the first letter the app
// types (or a timeout) is recorded. Results stay in this browser until
// exported as CSV; no images are kept.

const $ = (id) => document.getElementById(id);
const STORE = "signbridge-letter-test-v1";
const TIMEOUT_MS = 10000;

function loadResults() {
  try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; }
}

export function lettersCsv(rows) {
  const head = ["participant", "time", "target", "result", "typed", "ms", "taught"];
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [head.join(","), ...rows.map((r) => head.map((k) => cell(r[k])).join(","))].join("\r\n");
}

export function initLetterTest({ getLetters, letterName, handCard, ensureCamera, isTaught, onNext }) {
  const state = { run: null, timer: null, results: loadResults() };

  function save() { try { localStorage.setItem(STORE, JSON.stringify(state.results.slice(-5000))); } catch { /* full */ } }

  function start(event) {
    event.preventDefault();
    const letters = getLetters();
    if (!letters.length) return;
    const count = Number($("quiz-count").value);
    const code = $("quiz-code").value.trim() || "P?";
    const pool = [];
    while (pool.length < count) pool.push(...[...letters].sort(() => Math.random() - 0.5));
    state.run = { code, targets: pool.slice(0, count), index: 0, rows: [], shownAt: 0, waiting: false };
    $("quiz-intro").hidden = true;
    $("quiz-summary").hidden = true;
    $("quiz-run").hidden = false;
    ensureCamera().then((ok) => { if (ok) next(); else stop(); });
  }

  function next() {
    const run = state.run;
    clearTimeout(state.timer);
    if (run.index >= run.targets.length) { finish(); return; }
    const target = run.targets[run.index];
    $("quiz-progress").textContent = `Chữ ${run.index + 1}/${run.targets.length}`;
    $("quiz-target").textContent = letterName(target);
    $("quiz-hand").innerHTML = handCard(target);
    $("quiz-feedback").textContent = "Làm chữ này và giữ yên.";
    $("quiz-feedback").className = "quiz-feedback";
    onNext?.(); // a fresh start: the same letter twice in a row must be signed again
    run.shownAt = performance.now();
    run.waiting = true;
    state.timer = setTimeout(() => record(""), TIMEOUT_MS);
  }

  function record(typed) {
    const run = state.run;
    if (!run?.waiting) return;
    run.waiting = false;
    clearTimeout(state.timer);
    const target = run.targets[run.index];
    const result = !typed ? "none" : typed === target ? "correct" : "wrong";
    const row = { participant: run.code, time: new Date().toISOString(), target, result, typed, ms: Math.round(performance.now() - run.shownAt), taught: isTaught(target) ? "yes" : "no" };
    run.rows.push(row);
    state.results.push(row);
    save();
    const fb = $("quiz-feedback");
    fb.textContent = result === "correct" ? "Đúng" : result === "wrong" ? `App nhận thành ${letterName(typed)}` : "Hết giờ, app chưa nhận được chữ";
    fb.className = `quiz-feedback is-${result}`;
    run.index++;
    state.timer = setTimeout(next, 1400);
  }

  function finish() {
    const rows = state.run.rows;
    const ok = rows.filter((r) => r.result === "correct").length;
    const wrong = rows.filter((r) => r.result === "wrong").length;
    $("quiz-run").hidden = true;
    $("quiz-summary").hidden = false;
    $("quiz-score").textContent = `${ok}/${rows.length} chữ đúng, ${wrong} nhầm, ${rows.length - ok - wrong} hết giờ.`;
    const missed = rows.filter((r) => r.result !== "correct").map((r) => letterName(r.target));
    $("quiz-missed").textContent = missed.length ? `Nên dạy lại: ${[...new Set(missed)].join(", ")}.` : "Không có chữ nào cần dạy lại.";
    state.run = null;
  }

  function stop() {
    clearTimeout(state.timer);
    if (state.run?.rows.length) finish();
    else { state.run = null; $("quiz-run").hidden = true; $("quiz-intro").hidden = false; }
  }

  $("quiz-intro").addEventListener("submit", start);
  $("quiz-stop").addEventListener("click", stop);
  $("quiz-again").addEventListener("click", () => { $("quiz-summary").hidden = true; $("quiz-intro").hidden = false; });
  $("quiz-csv").addEventListener("click", () => {
    const blob = new Blob(["﻿" + lettersCsv(state.results)], { type: "text/csv;charset=utf-8" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `signbridge-chu-cai-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  return {
    get running() { return !!state.run; },
    /** Called with each letter the speller types while a test runs. */
    onLetter(letter) { record(letter); },
    stop,
  };
}
