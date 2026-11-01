// "Ký hiệu của tôi": a signer records a word 3 times; recognition then prefers
// the signer's own way of signing it. Also teaches words the model does not
// know. Stores only the model's standardized feature rows (numbers), never
// images, in this browser.
import { LiveSession } from "./recognizer.js";
import { SignCamera } from "./camera.js";

const $ = (id) => document.getElementById(id);
const STORE = "signbridge-personal-v1";
const SAMPLES = 3;
const MIN_RADIUS = 0.5;
const WINDOWS_PER_ATTEMPT = 6;

function distance(a, b) {
  let sq = 0;
  for (let i = 0; i < a.length; i++) sq += (a[i] - b[i]) ** 2;
  return Math.sqrt(sq / a.length);
}

export class PersonalSigns {
  constructor() {
    try { this.data = JSON.parse(localStorage.getItem(STORE)) || { items: [] }; } catch { this.data = { items: [] }; }
  }

  save() {
    try { localStorage.setItem(STORE, JSON.stringify(this.data)); } catch { /* storage full */ }
  }

  /** Templates only apply to the model version they were recorded with. */
  forModel(version) {
    return this.data.items.filter((item) => item.model === version);
  }

  /** attempts: array of attempts, each an array of feature rows (windows). */
  add(word, model, attempts) {
    attempts = attempts.map((a) => (Array.isArray(a[0]) || ArrayBuffer.isView(a[0]) ? a : [a]));
    // Accept radius: how far one attempt is from the signer's other attempts
    // (nearest window), times 1.5, with a floor for very consistent signers.
    const gaps = [];
    attempts.forEach((attempt, i) => attempt.forEach((row) => {
      let nearest = Infinity;
      attempts.forEach((other, j) => { if (j !== i) other.forEach((r) => { nearest = Math.min(nearest, distance(row, r)); }); });
      if (Number.isFinite(nearest)) gaps.push(nearest);
    }));
    gaps.sort((a, b) => a - b);
    const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    const rows = attempts.flat();
    const item = { word, model, rows: rows.map((r) => Array.from(r, (v) => Math.round(v * 1000) / 1000)), radius: Math.max(MIN_RADIUS, typical * 1.5), created: new Date().toISOString() };
    this.data.items = this.data.items.filter((i) => !(i.word === word && i.model === model));
    this.data.items.push(item);
    this.save();
  }

  remove(word, model) {
    this.data.items = this.data.items.filter((i) => !(i.word === word && i.model === model));
    this.save();
  }

  /** Nearest personal word for a standardized feature row, if close enough. */
  matcher(version) {
    const items = this.forModel(version);
    if (!items.length) return null;
    return (row) => {
      let best = null;
      for (const item of items) {
        for (const sample of item.rows) {
          const d = distance(row, sample);
          if (d <= item.radius && (!best || d < best.distance)) best = { word: item.word, distance: d };
        }
      }
      return best;
    };
  }
}

export function initPersonal({ personal, getModel, getSigns, onChange }) {
  const state = { camera: null, session: null, attempts: [], current: [], eligible: 0, waitingForRest: false, word: "" };

  function renderList() {
    const model = getModel();
    const list = $("personal-list");
    const items = model ? personal.forModel(model.json.model_version) : [];
    $("personal-empty").hidden = items.length > 0;
    list.replaceChildren(...items.map((item) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = item.word;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-quiet";
      remove.textContent = "Xóa";
      remove.addEventListener("click", () => { personal.remove(item.word, item.model); renderList(); onChange(); });
      li.append(name, remove);
      return li;
    }));
    const stale = personal.data.items.length - items.length;
    $("personal-stale").hidden = stale <= 0;
    $("personal-stale").textContent = `${stale} ký hiệu đã ghi với model cũ, cần ghi lại để dùng với model hiện tại.`;
  }

  function fillSuggestions() {
    const options = $("personal-suggestions");
    options.replaceChildren(...[...new Set(getSigns().map((s) => s.base))].sort((a, b) => a.localeCompare(b, "vi")).map((word) => Object.assign(document.createElement("option"), { value: word })));
  }

  async function startRecording(event) {
    event.preventDefault();
    const model = getModel();
    const word = $("personal-word").value.trim().toLocaleLowerCase("vi");
    if (!model || !word) return;
    state.word = word;
    state.attempts = [];
    state.current = [];
    state.eligible = 0;
    state.waitingForRest = true; // start from lowered hands
    state.session = new LiveSession(model);
    $("personal-recorder").hidden = false;
    $("personal-status").textContent = "Đang mở camera…";
    state.camera ??= new SignCamera({ video: $("personal-video"), canvas: $("personal-overlay"), onFrame });
    try {
      await state.camera.start();
      prompt();
    } catch {
      $("personal-status").textContent = "Chưa bật được camera. Cho phép camera trong trình duyệt rồi thử lại.";
    }
  }

  function prompt() {
    $("personal-status").textContent = `Lần ${state.attempts.length + 1}/${SAMPLES}: ký “${state.word}” một lần, rồi hạ tay xuống.`;
    $("personal-fill").style.width = `${(state.attempts.length / SAMPLES) * 100}%`;
  }

  function onFrame(frame, hand, pose) {
    if (!state.session) return;
    const s = state.session.push(frame, hand, pose);
    if (state.waitingForRest) {
      if (!hand) { state.waitingForRest = false; state.session.reset(); prompt(); }
      return;
    }
    // While the sign is being made, keep the windows the live camera would
    // classify (every 4th eligible frame, like the recognizer).
    if (hand && state.session.frames.length === 60 && s.handFrames >= s.handFramesNeeded) {
      if (state.eligible++ % 4 === 0 && state.current.length < WINDOWS_PER_ATTEMPT) {
        state.current.push(getModel().rowFor(state.session.frames));
        $("personal-status").textContent = `Lần ${state.attempts.length + 1}/${SAMPLES}: đang ghi… hạ tay khi ký xong.`;
      }
    }
    // Hands lowered: the attempt is over.
    if (!hand && state.current.length && state.session.missingHand >= 4) {
      state.attempts.push(state.current);
      state.current = [];
      state.eligible = 0;
      state.session.reset();
      if (state.attempts.length >= SAMPLES) finish();
      else prompt();
    }
  }

  function finish() {
    personal.add(state.word, getModel().json.model_version, state.attempts);
    state.session = null;
    state.camera?.stop();
    $("personal-fill").style.width = "100%";
    $("personal-status").textContent = `Đã lưu “${state.word}”. Từ giờ, khi bạn ký từ này ở màn hình Hội thoại, ứng dụng sẽ ưu tiên cách ký của bạn.`;
    $("personal-word").value = "";
    renderList();
    onChange();
  }

  $("personal-form").addEventListener("submit", startRecording);
  $("personal-cancel").addEventListener("click", () => {
    state.session = null;
    state.camera?.stop();
    $("personal-recorder").hidden = true;
  });

  return {
    show() { fillSuggestions(); renderList(); },
    leave() { if (state.camera?.running) { state.session = null; state.camera.stop(); } },
  };
}
