// "Đánh vần" view: spell names and words letter by letter with the VSL manual
// alphabet. Hold a letter still to type it; mũ/râu signs change the vowel
// before them; a tone is drawn with the little finger (buttons as fallback);
// ă is a button; word suggestions add the accents.
import { SignCamera } from "./camera.js";
import { LetterModel, LetterSpeller, PersonalLetters } from "./letters.js";
import { Lexicon, applyMark, applyTone, spellSequence } from "./vnspell.js";
import { initLetterTest } from "./lettertest.js";

const $ = (id) => document.getElementById(id);
const MARK_SIGNS = { "mũ": "mu", "râu": "rau" };
const LETTER_HOW = "Hình là khung bàn tay mẫu, nhìn từ phía camera. Nếu ứng dụng hay nhầm chữ này với tay bạn, hãy dạy lại: làm chữ và giữ yên khoảng 2 giây.";
const FINGER_LINKS = [[0,1],[1,2],[2,3],[3,4],[5,6],[6,7],[7,8],[9,10],[10,11],[11,12],[13,14],[14,15],[15,16],[17,18],[18,19],[19,20]];
const PALM = [0, 1, 5, 9, 13, 17];
const TEACH_FRAMES = 30;

/*
 * Tone marks and the breve, as taught in VSL courses (Trần Thị Thiệp, hufocw.org,
 * following Thông tư 17/2020): tones are drawn in the air with only the little
 * finger out; the breve is the mũ hand with the palm turned up.
 * Paths are in hand sizes around the little-finger tip, image y down.
 */
export const MARKS = [
  { key: "sac", short: "Sắc", tone: true, name: "Dấu sắc", glyph: "á", how: "Duỗi ngón út, đưa một nét xiên từ dưới lên trên, như viết dấu sắc.", path: "M -0.22 0.32 L 0.26 -0.42" },
  { key: "huyen", short: "Huyền", tone: true, name: "Dấu huyền", glyph: "à", how: "Duỗi ngón út, đưa một nét xiên từ trên xuống, như viết dấu huyền.", path: "M -0.22 -0.42 L 0.26 0.32" },
  { key: "hoi", short: "Hỏi", tone: true, name: "Dấu hỏi", glyph: "ả", how: "Duỗi ngón út, vẽ móc câu hỏi: vòng lên rồi kéo xuống.", path: "M -0.24 -0.22 C -0.2 -0.6 0.34 -0.6 0.3 -0.2 C 0.27 0.04 0.02 0.02 0.02 0.36" },
  { key: "nga", short: "Ngã", tone: true, name: "Dấu ngã", glyph: "ã", how: "Duỗi ngón út, vẽ nét lượn sóng ngang, như viết dấu ngã.", path: "M -0.44 0.06 C -0.3 -0.3 -0.12 -0.3 0 0 S 0.3 0.3 0.44 -0.06" },
  { key: "nang", short: "Nặng", tone: true, name: "Dấu nặng", glyph: "ạ", how: "Duỗi ngón út, chấm ngắn xuống dưới, như viết dấu chấm.", path: "M 0 -0.34 L 0 0.12", dot: [0, 0.36] },
  { key: "trang", short: "Trăng", tone: false, name: "Dấu trăng", glyph: "ă", how: "Giống dấu mũ (ngón trỏ và ngón giữa xòe, gập ở đốt thứ hai) nhưng ngửa lòng bàn tay. Ứng dụng chưa nhận dấu này qua camera: bấm nút Trăng.", path: "M -0.3 -0.12 Q 0 0.36 0.3 -0.12" },
];
// the arrowhead shows the direction even when animation is off (reduced motion)
const ARROW = '<defs><marker id="mark-arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="2.3" markerHeight="2.3" orient="auto"><path class="mark-arrowhead" d="M0,0 L10,5 L0,10 z"/></marker></defs>';
const MARK_BY_KEY = Object.fromEntries(MARKS.map((m) => [m.key, m]));

/** A mark card: the little-finger hand (or the mũ hand for ă) with the drawn path. */
export function markSvg(mark, templates) {
  const hand = templates[mark.tone ? "i" : "mũ"];
  if (!hand) return "";
  const xs = hand.map((p) => p[0]), ys = hand.map((p) => p[1]);
  const tip = hand[20], wrist = hand[0];
  const side = tip[0] >= wrist[0] ? 1 : -1;
  const cx = mark.tone ? tip[0] + side * 0.9 : (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = mark.tone ? tip[1] : Math.max(...ys) + 0.7;
  const dot = mark.dot ? `<circle cx="${mark.dot[0]}" cy="${mark.dot[1]}" r="0.07"/>` : "";
  const body = `<g class="mark-path" transform="translate(${cx.toFixed(3)} ${cy.toFixed(3)}) scale(1.3)"><path d="${mark.path}" pathLength="1"${mark.tone ? ' marker-end="url(#mark-arrow)"' : ""}/>${dot}</g>${ARROW}`;
  return handSvg(hand, { body, box: [cx - 0.75, cy - 0.95, cx + 0.75, cy + 0.75] });
}

/** Letter name as shown on screen: "a" -> "A", "mũ" -> "Mũ (^)". */
export function letterName(label) {
  if (label === "mũ") return "Mũ ^";
  if (label === "râu") return "Râu ơ ư";
  return label.toLocaleUpperCase("vi");
}

/**
 * A drawn hand from 21 template points (x, y, z; hand size 1): filled palm,
 * thick fingers painted far-to-near, nearer parts darker, so curled fingers
 * still read as curled in a flat picture.
 */
export function handSvg(points, overlay = null) {
  const r = (v) => Math.round(v * 1000) / 1000;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  if (overlay) { xs.push(overlay.box[0], overlay.box[2]); ys.push(overlay.box[1], overlay.box[3]); }
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const pad = span * 0.14;
  const view = [(minX + maxX) / 2 - span / 2 - pad, (minY + maxY) / 2 - span / 2 - pad, span + pad * 2, span + pad * 2].map(r).join(" ");
  const z = (i) => points[i][2] ?? 0;
  const zs = points.map((_, i) => z(i));
  const near = Math.min(...zs), far = Math.max(...zs);
  const depth = (v) => (far - near > 1e-6 ? (v - near) / (far - near) : 0.5); // 0 near, 1 far
  const width = span * 0.085;
  const palm = PALM.map((i) => `${r(points[i][0])},${r(points[i][1])}`).join(" ");
  const bones = FINGER_LINKS
    .map(([a, b]) => ({ a, b, d: depth((z(a) + z(b)) / 2) }))
    .sort((p, q) => q.d - p.d)
    .map(({ a, b, d }) => `<line x1="${r(points[a][0])}" y1="${r(points[a][1])}" x2="${r(points[b][0])}" y2="${r(points[b][1])}" stroke-opacity="${r(1 - d * 0.55)}" stroke-width="${r(width * (1.15 - d * 0.35))}"/>`)
    .join("");
  return `<svg viewBox="${view}" aria-hidden="true"><polygon class="palm" points="${palm}" stroke-width="${r(width * 0.5)}" stroke-linejoin="round"/><g class="bones" stroke-linecap="round">${bones}</g>${overlay ? overlay.body.replace("<path ", `<path stroke-width="${r(width * 0.7)}" `) : ""}</svg>`;
}

/** 21 hand points in pixels from a 1,605-value frame (the bigger visible hand). */
function handFromFrame(frame, width, height) {
  let best = null, bestSpan = 0;
  for (const start of [25, 46]) {
    const o = start * 3;
    if (Math.abs(frame[o]) < 1e-6 && Math.abs(frame[o + 1]) < 1e-6) continue;
    const pts = [];
    for (let k = 0; k < 21; k++) pts.push([frame[o + k * 3] * width, frame[o + k * 3 + 1] * height, frame[o + k * 3 + 2] * width]);
    const span = Math.hypot(pts[9][0] - pts[0][0], pts[9][1] - pts[0][1]);
    if (span > bestSpan) { best = pts; bestSpan = span; }
  }
  return best;
}

export function initSpell({ onSend, onShow, speak }) {
  const state = { model: null, lexicon: null, speller: null, camera: null, text: "", teach: null, personal: new PersonalLetters(), hint: null };
  // Taught rows are standardized with this model's scaler, so they belong to this exact model.
  const version = () => (state.model ? `letters:${state.model.json.scaler_mean.slice(0, 4).join(",")}` : "letters");

  async function load() {
    if (state.model) return true;
    try {
      const [m, l] = await Promise.all([fetch("model/letters.json"), fetch("model/vi_lexicon.json")]);
      if (!m.ok) throw new Error("letters");
      state.model = new LetterModel(await m.json());
      if (l.ok) state.lexicon = new Lexicon(await l.json());
      renderChart();
      return true;
    } catch {
      setStatus("Chưa nạp được bộ nhận chữ cái.", "Hãy tải lại trang. Vẫn có thể gõ chữ và dùng các nút dấu.");
      return false;
    }
  }

  function setStatus(line, help = "") {
    $("spell-status").textContent = line;
    $("spell-help").textContent = help;
  }

  /* ---------- Text editing ---------- */
  function setText(text, { syllableDone = false } = {}) {
    state.text = text;
    if (syllableDone) state.speller?.closeSyllable();
    render();
  }

  /** Edit the last syllable even after a space (a mark added late), keeping the space. */
  function onLastSyllable(edit) {
    const spaced = state.text.endsWith(" ");
    const { word, changed } = edit(state.text.trimEnd());
    return { word: spaced ? `${word} ` : word, changed };
  }

  function addLetter(label) {
    if (MARK_SIGNS[label]) {
      const { word, changed } = onLastSyllable((t) => applyMark(t, MARK_SIGNS[label]));
      if (!changed) { flash(label === "mũ" ? "Dấu mũ đi sau a, e hoặc o." : "Dấu râu đi sau o hoặc u."); return; }
      setText(word);
      return;
    }
    setText(state.text + label);
  }

  function addTone(tone) {
    const { word, changed } = onLastSyllable((t) => applyTone(t, tone));
    if (!changed) { flash("Chưa có nguyên âm để thêm dấu."); return; }
    setText(word);
  }

  function flash(message) {
    clearTimeout(state.hint);
    $("spell-hint").textContent = message;
    $("spell-hint").hidden = false;
    state.hint = setTimeout(() => { $("spell-hint").hidden = true; }, 2600);
  }

  function render() {
    const text = state.text;
    const shown = $("spell-text");
    shown.textContent = text || "";
    shown.classList.toggle("is-empty", !text);
    $("spell-mirror").textContent = text; // on phones the board is below the camera
    $("spell-empty").hidden = !!text;
    const suggestions = state.lexicon && text.trim() ? state.lexicon.suggest(text.trim(), 5) : [];
    const list = $("spell-suggestions");
    list.replaceChildren(...suggestions.map((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "suggestion";
      b.textContent = s;
      b.addEventListener("click", () => setText(`${s} `, { syllableDone: true }));
      return b;
    }));
    list.hidden = !suggestions.length;
    for (const id of ["spell-send", "spell-show", "spell-speak", "spell-back", "spell-clear"]) $(id).disabled = !text.trim();
  }

  /* ---------- Camera ---------- */
  function onFrame(frame, hand) {
    if (!state.speller) return;
    const video = $("spell-video");
    const points = hand ? handFromFrame(frame, video.videoWidth || 640, video.videoHeight || 480) : null;
    if (state.teach) { teachFrame(points); return; }
    const result = state.speller.push(points);
    const ring = $("spell-ring");
    const live = $("spell-live");
    if (result.commit) {
      if (quiz.running) quiz.onLetter(result.commit);
      else addLetter(result.commit);
      live.textContent = letterName(result.commit);
      live.classList.remove("pop");
      void live.offsetWidth;
      live.classList.add("pop");
      ring.style.setProperty("--p", "1");
      return;
    }
    if (result.tone) {
      if (!quiz.running) addTone(result.tone);
      live.textContent = MARK_BY_KEY[result.tone].name;
      live.classList.remove("pop");
      void live.offsetWidth;
      live.classList.add("pop");
      return;
    }
    if (result.stroking) {
      live.textContent = "";
      ring.style.setProperty("--p", "0");
      setStatus("Đang vẽ dấu…", "Vẽ xong thì giữ yên ngón út một chút.");
      return;
    }
    if (result.endSyllable && state.text && !state.text.endsWith(" ")) setText(`${state.text} `);
    if (!points) {
      live.textContent = "";
      ring.style.setProperty("--p", "0");
      setStatus("Giơ một tay lên trước camera", "Làm chữ cái rồi giữ yên đến khi vòng tròn đầy. Hạ tay khi xong một tiếng.");
      return;
    }
    live.textContent = result.label ? letterName(result.label) : "";
    ring.style.setProperty("--p", String(result.progress));
    state.unmatched = result.label ? 0 : (state.unmatched || 0) + 1;
    const stuck = state.unmatched > 60; // about 3 s with a hand but no letter
    setStatus(result.label ? "Giữ yên tay…" : "Đang nhìn bàn tay",
      result.label ? "" : stuck ? "Vẫn chưa khớp chữ nào. Chạm chữ đó ở bảng chữ cái bên dưới rồi bấm “Dạy chữ này theo tay tôi”."
        : "Chưa thấy chữ cái nào khớp. Thử xoay lòng bàn tay về phía camera.");
  }

  async function toggleCamera() {
    const button = $("spell-camera");
    if (state.camera?.running) { stopCamera(); return; }
    button.disabled = true;
    if (!(await load())) { button.disabled = false; return; }
    state.speller = new LetterSpeller(state.model, { personal: state.personal, version: version() });
    state.camera ??= new SignCamera({ video: $("spell-video"), canvas: $("spell-overlay"), onFrame });
    setStatus("Đang mở camera…");
    try {
      await state.camera.start();
      $("spell-stage-empty").hidden = true;
      button.textContent = "Tắt camera";
      setStatus("Giơ một tay lên trước camera", "Làm chữ cái rồi giữ yên đến khi vòng tròn đầy.");
    } catch (error) {
      const name = error?.name || error?.message;
      setStatus("Chưa bật được camera", name === "NotAllowedError" ? "Cho phép camera ở biểu tượng cạnh thanh địa chỉ rồi thử lại." : "Hãy đóng ứng dụng khác đang dùng camera rồi thử lại.");
      state.camera.stop();
    } finally {
      button.disabled = false;
    }
  }

  function stopCamera() {
    quiz?.stop();
    state.camera?.stop();
    state.teach = null;
    $("spell-camera").textContent = "Bật camera";
    $("spell-stage-empty").hidden = false;
    $("spell-live").textContent = "";
    $("spell-ring").style.setProperty("--p", "0");
    setStatus("Camera đang tắt", "Bật camera để đánh vần bằng chữ cái ngón tay.");
  }

  /* ---------- Alphabet chart + teaching ---------- */
  function renderChart() {
    if (!state.model) return;
    const taught = state.personal.forModel(version());
    const grid = $("spell-chart");
    grid.replaceChildren(...state.model.letters.sort((a, b) => a.localeCompare(b, "vi")).map((label) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "letter-card";
      const tpl = state.model.templates[label];
      b.innerHTML = `${tpl ? handSvg(tpl) : ""}<span class="letter-name"></span>${taught[label] ? '<span class="letter-taught">đã dạy</span>' : ""}`;
      b.querySelector(".letter-name").textContent = letterName(label);
      b.setAttribute("aria-label", `Chữ ${letterName(label)}${taught[label] ? ", đã dạy theo tay bạn" : ""}. Chạm để dạy lại`);
      b.addEventListener("click", () => openLetter(label));
      li.append(b);
      return li;
    }));
    $("spell-marks").replaceChildren(...MARKS.map((mark) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "letter-card mark-card";
      b.innerHTML = `${markSvg(mark, state.model.templates)}<span class="letter-name"></span>`;
      b.querySelector(".letter-name").textContent = `${mark.short} ${mark.glyph}`;
      b.setAttribute("aria-label", `${mark.name}. ${mark.how}`);
      b.addEventListener("click", () => openMark(mark));
      li.append(b);
      return li;
    }));
    const count = Object.keys(taught).length;
    $("spell-taught").textContent = count ? `Đã dạy ${count} chữ theo tay bạn.` : "";
  }

  function openLetter(label) {
    const panel = $("spell-letter");
    panel.hidden = false;
    $("spell-letter-title").textContent = `Chữ ${letterName(label)}`;
    $("spell-letter-how").textContent = LETTER_HOW;
    const tpl = state.model.templates[label];
    $("spell-letter-hand").innerHTML = tpl ? handSvg(tpl) : "";
    const taught = !!state.personal.forModel(version())[label];
    $("spell-letter-teach").hidden = false;
    $("spell-letter-type").textContent = "Nhập chữ này";
    $("spell-letter-forget").hidden = !taught;
    $("spell-letter-teach").onclick = () => startTeach(label);
    $("spell-letter-forget").onclick = () => { state.personal.remove(version(), label); renderChart(); openLetter(label); flash(`Đã xóa mẫu chữ ${letterName(label)} của bạn.`); };
    $("spell-letter-type").onclick = () => { addLetter(label); panel.hidden = true; };
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function openMark(mark) {
    const panel = $("spell-letter");
    panel.hidden = false;
    $("spell-letter-title").textContent = `${mark.name} (${mark.glyph})`;
    $("spell-letter-how").textContent = mark.how;
    $("spell-letter-hand").innerHTML = markSvg(mark, state.model.templates);
    $("spell-letter-teach").hidden = true;
    $("spell-letter-forget").hidden = true;
    $("spell-letter-type").textContent = "Thêm dấu này";
    $("spell-letter-type").onclick = () => {
      if (mark.tone) addTone(mark.key);
      else {
        const { word, changed } = onLastSyllable((t) => applyMark(t, mark.key));
        if (changed) setText(word); else flash("Dấu trăng đi sau a.");
      }
      panel.hidden = true;
    };
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  async function startTeach(label) {
    if (!state.camera?.running) await toggleCamera();
    if (!state.camera?.running) return;
    state.teach = { label, rows: [], wait: 0 };
    $("spell-letter").hidden = true;
    setStatus(`Làm chữ ${letterName(label)} và giữ yên`, "Ứng dụng ghi khoảng 1,5 giây tay của bạn. Chỉ lưu các con số mô tả bàn tay trên máy này.");
    document.getElementById("spell-stage").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function teachFrame(points) {
    const t = state.teach;
    const ring = $("spell-ring");
    $("spell-live").textContent = letterName(t.label);
    if (!points) { ring.style.setProperty("--p", String(t.rows.length / TEACH_FRAMES)); return; }
    if (t.wait < 12) { t.wait++; return; } // time to form the hand shape
    t.rows.push(state.model.classify(points).row);
    ring.style.setProperty("--p", String(t.rows.length / TEACH_FRAMES));
    if (t.rows.length >= TEACH_FRAMES) {
      state.personal.set(version(), t.label, t.rows.filter((_, i) => i % 2 === 0));
      state.teach = null;
      state.speller?.reset();
      renderChart();
      setStatus(`Đã lưu chữ ${letterName(t.label)} theo tay bạn`, "Từ giờ ứng dụng ưu tiên cách làm này.");
      flash(`Đã lưu chữ ${letterName(t.label)}.`);
    }
  }

  /* ---------- Buttons ---------- */
  $("spell-camera").addEventListener("click", toggleCamera);
  for (const button of document.querySelectorAll("[data-tone]")) {
    button.addEventListener("click", () => {
      addTone(button.dataset.tone);
    });
  }
  for (const button of document.querySelectorAll("[data-mark]")) {
    button.addEventListener("click", () => {
      const { word, changed } = onLastSyllable((t) => applyMark(t, button.dataset.mark));
      if (!changed) { flash({ trang: "Dấu trăng đi sau a.", mu: "Dấu mũ đi sau a, e hoặc o.", rau: "Dấu râu đi sau o hoặc u." }[button.dataset.mark]); return; }
      setText(word);
    });
  }
  $("spell-space").addEventListener("click", () => { if (state.text && !state.text.endsWith(" ")) setText(`${state.text} `, { syllableDone: true }); });
  $("spell-back").addEventListener("click", () => setText([...state.text].slice(0, -1).join(""), { syllableDone: true }));
  $("spell-clear").addEventListener("click", () => setText("", { syllableDone: true }));
  const capital = (w) => w.charAt(0).toLocaleUpperCase("vi") + w.slice(1);
  const finalText = () => {
    const t = state.text.trim();
    if (!t) return "";
    return $("spell-names").checked ? t.split(" ").map(capital).join(" ") : capital(t);
  };
  $("spell-names").addEventListener("change", (event) => $("spell-text").classList.toggle("names", event.target.checked));
  $("spell-send").addEventListener("click", () => { const t = finalText(); if (t) { onSend(t); setText("", { syllableDone: true }); flash("Đã đưa vào hội thoại."); } });
  $("spell-show").addEventListener("click", () => { const t = finalText(); if (t) onShow(t); });
  $("spell-speak").addEventListener("click", () => { const t = finalText(); if (t) speak(t); });
  $("spell-letter-close").addEventListener("click", () => { $("spell-letter").hidden = true; });
  $("spell-type").addEventListener("input", (event) => {
    // Typing on a keyboard works too (helpers, testing); marks still apply.
    const value = event.target.value;
    event.target.value = "";
    for (const ch of value.toLocaleLowerCase("vi")) {
      if (ch === " ") { if (state.text && !state.text.endsWith(" ")) setText(`${state.text} `, { syllableDone: true }); }
      else if (/[a-zđàáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]/.test(ch)) setText(state.text + ch);
    }
  });

  /* ---------- Spell a word out for the Deaf reader (hearing -> Deaf) ---------- */
  async function spellOut(text) {
    await load();
    const body = $("spellout-body");
    const sequence = spellSequence(text);
    body.replaceChildren(...sequence.map(({ syllable, steps }) => {
      const row = document.createElement("section");
      row.className = "spellout-syllable";
      const title = document.createElement("h3");
      title.textContent = syllable;
      const list = document.createElement("ol");
      for (const step of steps) {
        const li = document.createElement("li");
        const mark = MARK_BY_KEY[step.tone || step.mark];
        if (mark && state.model) {
          li.className = "spellout-letter spellout-mark";
          li.innerHTML = markSvg(mark, state.model.templates);
          const name = document.createElement("span");
          name.textContent = mark.name;
          li.title = mark.how;
          li.append(name);
        } else if (step.motion) {
          li.className = "spellout-motion";
          li.textContent = step.motion;
        } else {
          const tpl = state.model?.templates[step.letter];
          li.className = tpl ? "spellout-letter" : "spellout-motion";
          li.innerHTML = tpl ? handSvg(tpl) : "";
          const name = document.createElement("span");
          name.textContent = tpl ? letterName(step.letter) : `${letterName(step.letter)} (không có trong bảng VSL)`;
          li.append(name);
        }
        list.append(li);
      }
      row.append(title, list);
      return row;
    }));
    $("spellout-title").textContent = `Đánh vần: ${text}`;
    $("spellout-sheet").showModal();
  }
  $("spellout-close").addEventListener("click", () => $("spellout-sheet").close());

  const quiz = initLetterTest({
    getLetters: () => state.model?.letters ?? [],
    letterName,
    handCard: (label) => (state.model?.templates[label] ? handSvg(state.model.templates[label]) : ""),
    isTaught: (label) => !!state.personal.forModel(version())[label],
    onNext: () => state.speller?.reset(),
    ensureCamera: async () => {
      if (!state.camera?.running) await toggleCamera();
      const ok = !!state.camera?.running;
      $("spell-board").toggleAttribute("data-quiz", ok);
      if (ok) $("spell-stage").scrollIntoView({ block: "start", behavior: "smooth" });
      return ok;
    },
  });
  new MutationObserver(() => $("spell-board").toggleAttribute("data-quiz", !$("quiz-run").hidden)).observe($("quiz-run"), { attributes: true, attributeFilter: ["hidden"] });

  render();
  return {
    spellOut,
    async show() { await load(); render(); },
    leave() { if (state.camera?.running) stopCamera(); },
    get text() { return state.text; },
  };
}
