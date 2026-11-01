import { LiveSession, createModel } from "./recognizer.js";
import { SignIndex, REGION_NAMES, parseLabel } from "./lookup.js";
import { PHRASE_GROUPS } from "./phrases.js";
import { SignCamera } from "./camera.js";
import { listen, speak, speechInputSupported, speechOutputSupported } from "./speech.js";
import { initStudy } from "./study.js";
import { COMMON_WORDS, composeSentence } from "./compose.js";
import { PersonalSigns, initPersonal } from "./personal.js";
import { initSpell } from "./spell.js";

const $ = (id) => document.getElementById(id);
const STORE = "signbridge-web-v1";
const store = (() => {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
})();
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(store)); } catch { /* private mode */ } };
store.settings ??= { size: "large", contrast: false, mirror: true, autoSpeak: false, speechConsent: false };
// v2: continuous signing starts off; words are only taken after "Bắt đầu câu".
if (store.settings.version !== 2) { store.settings.continuous = false; store.settings.version = 2; }
store.settings.pauseMs ??= 2500;
store.messages ??= [];
store.customPhrases ??= [];

const app = { model: null, index: null, session: null, camera: null, stopListening: null, candidate: null, sentence: [], pauseStart: null, armed: false, awaitRest: false, restFrames: 0 };
// One sign = one word: after a word, hands must be down this many frames before the next.
const REST_FRAMES = 8;
// Words are only taken automatically when the model (or the signer's own sample) is this sure.
const AUTO_SCORE = 0.85;

/* ---------- Views ---------- */
function showView(name) {
  for (const section of document.querySelectorAll(".view")) section.hidden = section.id !== `view-${name}`;
  for (const button of document.querySelectorAll(".tabbar button")) {
    if (button.dataset.view === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (name !== "talk" && app.camera?.running) toggleCamera();
  if (name !== "study") app.study?.leave();
  if (name !== "personal") app.personalView?.leave();
  if (name === "personal") app.personalView?.show();
  if (name !== "spell") app.spellView?.leave();
  if (name === "spell") app.spellView?.show();
  $("main").focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}
document.querySelector(".tabbar").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (button) showView(button.dataset.view);
});

/* ---------- Settings ---------- */
function applySettings() {
  const s = store.settings;
  document.documentElement.dataset.size = s.size;
  document.documentElement.dataset.contrast = s.contrast ? "high" : "normal";
  $("stage").dataset.mirror = String(s.mirror);
  for (const radio of document.querySelectorAll('input[name="text-size"]')) radio.checked = radio.value === s.size;
  $("set-contrast").checked = s.contrast;
  $("set-mirror").checked = s.mirror;
  $("set-speak").checked = s.autoSpeak;
  $("continuous-mode").checked = s.continuous;
  for (const radio of document.querySelectorAll('input[name="pause"]')) radio.checked = Number(radio.value) === Number(s.pauseMs);
}
document.querySelectorAll('input[name="text-size"]').forEach((radio) => radio.addEventListener("change", () => { store.settings.size = radio.value; save(); applySettings(); }));
$("set-contrast").addEventListener("change", (e) => { store.settings.contrast = e.target.checked; save(); applySettings(); });
$("set-mirror").addEventListener("change", (e) => { store.settings.mirror = e.target.checked; save(); applySettings(); });
$("set-speak").addEventListener("change", (e) => { store.settings.autoSpeak = e.target.checked; save(); });
$("clear-thread").addEventListener("click", () => {
  if (!store.messages.length || confirm("Xóa toàn bộ cuộc trò chuyện trên thiết bị này?")) {
    store.messages = []; save(); renderMessages();
  }
});

/* ---------- Conversation ---------- */
const SOURCE_TEXT = { sign: "ký hiệu", speech: "giọng nói", typed: "gõ chữ", phrase: "câu nhanh", spell: "đánh vần" };
const WHO_TEXT = { deaf: "Người Điếc", hearing: "Người nghe" };

function addMessage(who, text, source) {
  const clean = text.trim();
  if (!clean) return;
  store.messages.push({ who, text: clean, source, time: Date.now() });
  if (store.messages.length > 200) store.messages.shift();
  save();
  renderMessages();
  if (who === "deaf" && store.settings.autoSpeak) speak(clean);
}

function signChips(text) {
  if (!app.index) return null;
  const { parts } = app.index.lookup(text);
  const signs = parts.filter((p) => p.type === "sign").flatMap((p) => p.signs);
  const missingKnown = parts.filter((p) => p.type === "missing").flatMap((p) => p.known);
  // Words without a sign (names, places…) can be fingerspelled for the Deaf reader.
  const unsigned = parts.filter((p) => p.type === "missing").map((p) => p.text).join(" ");
  if (!signs.length && !missingKnown.length && !unsigned) return null;
  const wrap = document.createElement("div");
  wrap.className = "msg-signs";
  for (const sign of signs) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "sign-chip";
    chip.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
    chip.append(sign.region ? `${sign.base} (${REGION_NAMES[sign.region]})` : sign.label);
    chip.setAttribute("aria-label", `Xem ký hiệu ${sign.label}`);
    chip.addEventListener("click", () => openSign(sign));
    wrap.append(chip);
  }
  if (unsigned) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "sign-chip spell-chip";
    chip.textContent = signs.length ? "Đánh vần các từ còn lại" : "Đánh vần bằng chữ cái";
    chip.setAttribute("aria-label", `Xem cách đánh vần “${unsigned}” bằng chữ cái ngón tay`);
    chip.addEventListener("click", () => app.spellView.spellOut(unsigned));
    wrap.append(chip);
  }
  if (missingKnown.length) {
    const note = document.createElement("p");
    note.className = "msg-missing";
    note.textContent = `Chưa có dữ liệu ký hiệu cho: ${missingKnown.join(", ")}`;
    wrap.append(note);
  }
  return wrap;
}

function renderMessages() {
  const list = $("messages");
  list.replaceChildren();
  $("thread-empty").hidden = store.messages.length > 0;
  for (const message of store.messages) {
    const item = document.createElement("li");
    item.className = `msg msg-${message.who}`;
    const meta = document.createElement("p");
    meta.className = "msg-meta";
    const dot = document.createElement("span");
    dot.className = "who-dot";
    meta.append(dot, `${WHO_TEXT[message.who]}, ${SOURCE_TEXT[message.source] || ""}`);
    const bubble = document.createElement("button");
    bubble.type = "button";
    bubble.className = "bubble";
    bubble.textContent = message.text;
    bubble.title = "Chạm để hiện thật to";
    bubble.addEventListener("click", () => openShow(message.text, message.who));
    item.append(meta, bubble);
    if (message.who === "hearing") {
      const chips = signChips(message.text);
      if (chips) item.append(chips);
    }
    list.append(item);
  }
  list.scrollTop = list.scrollHeight;
}

const composer = $("composer");
const composerText = $("composer-text");
const whoNow = () => composer.querySelector('input[name="who"]:checked').value;
composer.addEventListener("submit", (event) => {
  event.preventDefault();
  addMessage(whoNow(), composerText.value, "typed");
  composerText.value = "";
  autoGrow();
});
composerText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); composer.requestSubmit(); }
});
function autoGrow() {
  composerText.style.height = "auto";
  composerText.style.height = `${Math.min(composerText.scrollHeight, 160)}px`;
  composerText.style.overflowY = composerText.scrollHeight > 160 ? "auto" : "hidden";
}
composerText.addEventListener("input", autoGrow);
composer.addEventListener("change", () => updateComposerMode());
function updateComposerMode() {
  const hearing = whoNow() === "hearing";
  $("mic").hidden = !hearing || !speechInputSupported;
  composerText.placeholder = hearing ? "Gõ, hoặc bấm micro để nói" : "Gõ chữ";
  $("composer-hint").textContent = hearing && !speechInputSupported ? "Trình duyệt này chưa hỗ trợ nhận giọng nói. Hãy dùng Chrome hoặc Edge, hoặc gõ chữ." : "";
  $("composer-hint").classList.remove("live");
}

/* ---------- Speech to text ---------- */
$("mic").addEventListener("click", () => {
  if (app.stopListening) { app.stopListening(); return; }
  if (!store.settings.speechConsent) { $("speech-consent").showModal(); return; }
  startListening();
});
$("consent-yes").addEventListener("click", () => { store.settings.speechConsent = true; save(); $("speech-consent").close(); startListening(); });
$("consent-no").addEventListener("click", () => $("speech-consent").close());
function startListening() {
  const hint = $("composer-hint");
  const mic = $("mic");
  try {
    app.stopListening = listen({
      onInterim: (text) => { hint.textContent = text; hint.classList.add("live"); },
      onFinal: (text) => { addMessage("hearing", text, "speech"); hint.textContent = ""; },
      onError: (code) => {
        hint.classList.remove("live");
        hint.textContent = code === "not-allowed" || code === "service-not-allowed"
          ? "Chưa được phép dùng micro. Bấm biểu tượng ổ khóa cạnh thanh địa chỉ và cho phép micro."
          : code === "no-speech" ? "Chưa nghe thấy gì. Bấm micro và nói gần máy hơn."
          : code === "network" ? "Nhận giọng nói cần Internet. Hãy kiểm tra kết nối hoặc gõ chữ."
          : "Không nhận được giọng nói. Hãy thử lại hoặc gõ chữ.";
      },
      onEnd: () => { app.stopListening = null; mic.classList.remove("listening"); mic.setAttribute("aria-label", "Nói để chuyển thành chữ"); },
    });
    mic.classList.add("listening");
    mic.setAttribute("aria-label", "Dừng nghe");
    hint.textContent = "Đang nghe… hãy nói tiếng Việt";
    hint.classList.add("live");
  } catch {
    hint.textContent = "Trình duyệt này chưa hỗ trợ nhận giọng nói. Hãy dùng Chrome hoặc Edge.";
  }
}

/* ---------- Camera and sign recognition ---------- */
const STATUS = {
  off: ["Camera đang tắt", "Ngồi cách camera khoảng 1–1,5 m để thấy đầu, vai và hai tay."],
  loading: ["Đang mở camera…", "Lần đầu cần nạp bộ nhận diện, khoảng 10–20 giây."],
  idle: ["Sẵn sàng", "Đưa tay lên và làm trọn một ký hiệu, rồi hạ tay xuống."],
  no_body: ["Chưa thấy rõ người ký", "Lùi ra để camera thấy đầu, vai và hai tay. Tránh ngồi ngược sáng."],
  no_hand: ["Sẵn sàng, chưa thấy bàn tay", "Đưa tay lên và làm trọn một ký hiệu, rồi hạ tay xuống."],
  sampling: ["Đang ghi động tác", "Tiếp tục ký cho đến hết, rồi hạ tay."],
  comparing: ["Đã đủ mẫu, đang đối chiếu", "Ứng dụng cần hai lần đối chiếu ra cùng một ký hiệu."],
  unknown: ["Chưa nhận ra ký hiệu này", "Thử ký chậm và rõ hơn, hoặc ký hiệu này chưa có trong danh sách hỗ trợ."],
  recognized: ["Đã nhận được ký hiệu", "Kiểm tra kết quả bên dưới rồi gửi vào hội thoại."],
};

function setStatus(key, extra = {}) {
  const [line, help] = STATUS[key] || STATUS.idle;
  $("status-line").textContent = extra.line || line;
  let helpText = extra.help || help;
  if (extra.fps) helpText += ` Tốc độ xử lý khoảng ${Math.round(extra.fps)} khung/giây.`;
  $("status-help").textContent = helpText;
  const meter = $("meter");
  meter.hidden = extra.progress == null;
  if (extra.progress != null) $("meter-fill").style.width = `${Math.round(Math.min(1, extra.progress) * 100)}%`;
}

function onFrame(frame, hand, pose) {
  const state = app.session.push(frame, hand, pose);
  const fps = app.camera.fps;
  if (state.mirrored) {
    setStatus(state.status, { line: "Hình camera đang bị lật như gương", help: "Dữ liệu huấn luyện không lật ảnh. Hãy tắt chế độ gương trong phần mềm camera (nếu có)." });
  } else if (state.status === "sampling") {
    const progress = Math.min(state.windowFrames / 60, state.handFrames / state.handFramesNeeded);
    setStatus("sampling", { line: `Đang ghi động tác: ${Math.min(state.handFrames, state.handFramesNeeded)}/${state.handFramesNeeded} khung có tay`, progress, fps });
  } else if (state.status === "comparing") {
    setStatus("comparing", { progress: 1, fps });
  } else {
    setStatus(state.status, { fps: state.status === "unknown" ? null : fps });
  }
  app.restFrames = hand ? 0 : app.restFrames + 1;
  if (app.awaitRest && app.restFrames >= REST_FRAMES) app.awaitRest = false;
  if (state.status === "recognized" && state.isNew && !app.awaitRest && confident(state)) {
    if (!store.settings.continuous) { showCandidate(state); app.awaitRest = true; }
    else if (app.armed) { appendWord(state); app.awaitRest = true; }
  }
  if (store.settings.continuous && app.armed) trackPause(hand);
  if (state.status === "unknown" && state.top?.length) {
    $("status-help").textContent = `Gần giống nhất (chưa phải kết quả): ${[...new Set(state.top.map((t) => parseLabel(t.label).base))].join(", ")}.`;
  }
}

function confident(state) {
  const base = parseLabel(state.label).base;
  const score = (state.top || []).filter((t) => parseLabel(t.label).base === base).reduce((sum, t) => sum + t.score, 0);
  return score >= AUTO_SCORE;
}

function showCandidate(state) {
  const { base, region } = parseLabel(state.label);
  app.candidate = base;
  $("candidate-text").textContent = base;
  const others = [...new Set((state.top || []).map((t) => parseLabel(t.label).base))].filter((l) => l !== base);
  const parts = [];
  if (region) parts.push(`Biến thể ${REGION_NAMES[region]}`);
  if (others.length) parts.push(`Cũng có thể là: ${others.join(", ")}`);
  $("candidate-alt").textContent = parts.join(". ");
  $("candidate").hidden = false;
  $("candidate-send").focus({ preventScroll: true });
}
function hideCandidate() { $("candidate").hidden = true; app.candidate = null; }

/* Continuous signing: recognized words build a sentence; a pause sends it.
   Each word keeps the model's nearest alternatives so a wrong word is fixed
   with one tap instead of signing it again. */
let openWord = null;
function sentenceWords() { return app.sentence.map((w) => w.word); }
function renderSentence() {
  const box = $("sentence");
  box.hidden = !store.settings.continuous || !app.camera?.running;
  const chips = $("sentence-words");
  chips.replaceChildren(...app.sentence.map((item, i) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `word-chip${item.typed ? " typed" : ""}`;
    chip.textContent = item.word;
    chip.setAttribute("aria-expanded", String(openWord === i));
    chip.setAttribute("aria-label", `${item.word}: chạm để đổi hoặc xóa`);
    chip.addEventListener("click", () => { openWord = openWord === i ? null : i; renderSentence(); });
    return chip;
  }));
  const menu = $("word-menu");
  menu.hidden = openWord === null || !app.sentence[openWord];
  if (!menu.hidden) {
    const item = app.sentence[openWord];
    const note = document.createElement("p");
    note.textContent = item.alts.length ? `Đổi “${item.word}” thành:` : `Không có lựa chọn gần giống cho “${item.word}”.`;
    const buttons = item.alts.map((alt) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.textContent = alt;
      b.addEventListener("click", () => { item.alts = [item.word, ...item.alts.filter((x) => x !== alt)]; item.word = alt; openWord = null; renderSentence(); });
      return b;
    });
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "chip"; remove.textContent = "Xóa từ này";
    remove.addEventListener("click", () => { app.sentence.splice(openWord, 1); openWord = null; renderSentence(); });
    const teach = document.createElement("button");
    teach.type = "button"; teach.className = "chip"; teach.textContent = "Sai mãi? Dạy app từ đúng";
    teach.addEventListener("click", () => openTeach(""));
    menu.replaceChildren(note, ...buttons, remove, teach);
  }
  $("sentence-text").textContent = app.sentence.length ? composeSentence(sentenceWords()) : "";
  $("sentence-start").hidden = app.armed;
  $("sentence-body").hidden = !app.armed && !app.sentence.length;
  $("sentence-label").textContent = !app.armed
    ? "Bấm Bắt đầu câu, rồi ký từng từ. Hạ tay xuống giữa các từ."
    : app.sentence.length ? "Từ đã ký (chạm để sửa) và câu sẽ gửi" : "Đang nghe: hãy ký từ đầu tiên";
  $("sentence-send").disabled = !app.sentence.length;
  $("sentence-undo").disabled = !app.sentence.length;
}
function addWord(word, alts = [], typed = false) {
  app.sentence.push({ word, alts, typed });
  app.pauseStart = null;
  openWord = null;
  renderSentence();
}
function appendWord(state) {
  const word = parseLabel(state.label).base;
  const alts = [...new Set((state.top || []).map((t) => parseLabel(t.label).base))].filter((w) => w !== word);
  addWord(word, alts);
}
function trackPause(hand) {
  const meter = $("sentence-meter");
  const limit = Number(store.settings.pauseMs);
  if (hand || !app.sentence.length || !limit || openWord !== null) { app.pauseStart = null; meter.hidden = true; return; }
  app.pauseStart ??= performance.now();
  const elapsed = performance.now() - app.pauseStart;
  meter.hidden = false;
  $("sentence-meter-fill").style.width = `${Math.min(100, (elapsed / limit) * 100)}%`;
  if (elapsed >= limit) sendSentence();
}
function sendSentence() {
  if (app.sentence.length) addMessage("deaf", composeSentence(sentenceWords()), "sign");
  app.sentence = [];
  app.armed = false;
  app.pauseStart = null;
  openWord = null;
  $("sentence-meter").hidden = true;
  renderSentence();
}
$("sentence-send").addEventListener("click", sendSentence);
$("sentence-start").addEventListener("click", () => {
  app.armed = true;
  app.awaitRest = true; // start from lowered hands so the first word is a fresh sign
  app.session?.reset();
  renderSentence();
});
function openTeach(word) {
  showView("personal");
  const input = $("personal-word");
  input.value = word;
  input.focus();
}
$("candidate-teach").addEventListener("click", () => { hideCandidate(); app.session?.reset(); openTeach(""); });
$("sentence-undo").addEventListener("click", () => { app.sentence.pop(); openWord = null; renderSentence(); });
$("sentence-clear").addEventListener("click", () => { app.sentence = []; app.armed = false; openWord = null; renderSentence(); });
$("quick-words").replaceChildren(...COMMON_WORDS.map((word) => {
  const chip = document.createElement("button");
  chip.type = "button"; chip.className = "chip"; chip.textContent = word;
  chip.addEventListener("click", () => addWord(word, [], true));
  return chip;
}));
$("add-word").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("add-word-text");
  const word = input.value.trim();
  if (word) addWord(word, [], true);
  input.value = "";
});
$("continuous-mode").addEventListener("change", (event) => {
  store.settings.continuous = event.target.checked;
  save();
  app.armed = false;
  hideCandidate();
  renderSentence();
});
document.querySelectorAll('input[name="pause"]').forEach((radio) => radio.addEventListener("change", () => { store.settings.pauseMs = Number(radio.value); save(); }));
$("candidate-send").addEventListener("click", () => {
  if (app.candidate) addMessage("deaf", app.candidate, "sign");
  hideCandidate();
  app.session?.reset();
});
$("candidate-reject").addEventListener("click", () => { hideCandidate(); app.session?.reset(); });

async function toggleCamera() {
  const button = $("camera-toggle");
  if (app.camera?.running) {
    app.camera.stop();
    button.textContent = "Bật camera";
    $("stage-empty").hidden = false;
    setStatus("off");
    hideCandidate();
    if (app.sentence.length) sendSentence();
    renderSentence();
    return;
  }
  if (!app.model) { setStatus("off", { line: "Chưa nạp được model nhận diện", help: "Hãy tải lại trang. Nếu vẫn lỗi, chạy lại ứng dụng." }); return; }
  button.disabled = true;
  setStatus("loading");
  app.session = new LiveSession(app.model, { personal: app.personal.matcher(app.model.json.model_version) });
  app.armed = false;
  app.awaitRest = false;
  app.camera ??= new SignCamera({ video: $("video"), canvas: $("overlay"), onFrame, onStatus: () => {} });
  try {
    await app.camera.start();
    $("stage-empty").hidden = true;
    button.textContent = "Tắt camera";
    setStatus("idle");
    renderSentence();
  } catch (error) {
    const name = error?.name || error?.message;
    const help = name === "NotAllowedError" ? "Bấm biểu tượng camera hoặc ổ khóa cạnh thanh địa chỉ, chọn Cho phép, rồi bấm Bật camera lại."
      : name === "NotFoundError" ? "Không tìm thấy webcam. Hãy cắm webcam hoặc dùng máy có camera."
      : name === "NotReadableError" ? "Webcam đang được ứng dụng khác dùng (Zoom, Teams…). Hãy đóng ứng dụng đó rồi thử lại."
      : name === "no-camera-api" ? "Trình duyệt chặn camera vì trang không mở qua địa chỉ an toàn. Hãy mở bằng localhost hoặc https."
      : "Không mở được camera hoặc bộ nhận diện. Hãy tải lại trang và thử lại.";
    setStatus("off", { line: "Chưa bật được camera", help });
    app.camera.stop();
  } finally {
    button.disabled = false;
  }
}
$("camera-toggle").addEventListener("click", toggleCamera);

/* ---------- Show mode ---------- */
function openShow(text, who) {
  const dialog = $("show");
  dialog.dataset.who = who;
  $("show-who").textContent = who === "deaf" ? "Người Điếc nói" : who === "hearing" ? "Người nghe nói" : "";
  $("show-text").textContent = text;
  $("show-body").classList.remove("flipped");
  $("show-speak").hidden = !speechOutputSupported;
  dialog.showModal();
}
$("show-rotate").addEventListener("click", () => $("show-body").classList.toggle("flipped"));
$("show-close").addEventListener("click", () => $("show").close());
$("show-speak").addEventListener("click", () => speak($("show-text").textContent));

/* ---------- Quick phrases ---------- */
let activeGroup = PHRASE_GROUPS[0].id;
function renderPhrases() {
  const groups = $("phrase-groups");
  groups.replaceChildren();
  const all = [...PHRASE_GROUPS, { id: "mine", title: "Câu của bạn", phrases: store.customPhrases }];
  for (const group of all) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.setAttribute("role", "tab");
    chip.setAttribute("aria-selected", String(group.id === activeGroup));
    chip.textContent = group.title;
    chip.addEventListener("click", () => { activeGroup = group.id; renderPhrases(); });
    groups.append(chip);
  }
  const list = $("phrase-list");
  list.replaceChildren();
  const group = all.find((g) => g.id === activeGroup);
  if (!group.phrases.length) {
    const empty = document.createElement("li");
    empty.className = "search-note";
    empty.textContent = "Chưa có câu nào. Thêm câu hay dùng ở ô bên dưới.";
    list.append(empty);
  }
  group.phrases.forEach((phrase, index) => {
    const item = document.createElement("li");
    item.className = "phrase-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "phrase";
    button.textContent = phrase;
    button.addEventListener("click", () => { addMessage("deaf", phrase, "phrase"); openShow(phrase, "deaf"); });
    item.append(button);
    if (group.id === "mine") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-btn phrase-remove";
      remove.setAttribute("aria-label", `Xóa câu: ${phrase}`);
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      remove.addEventListener("click", () => { store.customPhrases.splice(index, 1); save(); renderPhrases(); });
      item.append(remove);
    }
    list.append(item);
  });
}
$("custom-phrase").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("custom-phrase-text");
  const text = input.value.trim();
  if (!text) return;
  store.customPhrases.push(text);
  save();
  input.value = "";
  activeGroup = "mine";
  renderPhrases();
});

/* ---------- Sign library ---------- */
let region = "all";
function renderRegions() {
  const wrap = $("region-filter");
  wrap.replaceChildren();
  for (const [value, title] of [["all", "Tất cả"], ["bắc", "Miền Bắc"], ["trung", "Miền Trung"], ["nam", "Miền Nam"], ["none", "Không chia vùng"]]) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.setAttribute("aria-pressed", String(region === value));
    chip.textContent = title;
    chip.addEventListener("click", () => { region = value; renderRegions(); renderSigns(); });
    wrap.append(chip);
  }
}
function renderSigns() {
  if (!app.index) return;
  const query = $("sign-search").value;
  const signs = app.index.search(query, region).sort((a, b) => a.label.localeCompare(b.label, "vi"));
  const grid = $("sign-grid");
  grid.replaceChildren();
  for (const sign of signs) {
    const item = document.createElement("li");
    const card = document.createElement("button");
    card.type = "button";
    card.className = "sign-card";
    const name = document.createElement("span");
    name.className = "sign-card-name";
    name.textContent = sign.base;
    card.append(name);
    if (sign.region) {
      const tag = document.createElement("span");
      tag.className = "region-tag";
      tag.textContent = REGION_NAMES[sign.region];
      card.append(tag);
    }
    card.addEventListener("click", () => openSign(sign));
    item.append(card);
    grid.append(item);
  }
  const note = $("search-note");
  note.hidden = signs.length > 0 || !query.trim();
  if (!signs.length && query.trim()) {
    const known = app.index.knownNames(query.trim().split(/\s+/));
    note.textContent = known.length
      ? `“${known.join("”, “")}” có trong danh sách tên của VOYA nhưng chưa có dữ liệu ký hiệu, nên ứng dụng chưa nhận diện hay minh họa được.`
      : `Không có ký hiệu nào khớp trong ${app.index.signs.length} ký hiệu hỗ trợ.`;
  }
}
$("sign-search").addEventListener("input", renderSigns);

const SOURCE_NAMES = {
  voya: "Nguồn: bộ dữ liệu VOYA_VSL (MIT).",
  ptit: "Nguồn: bộ dữ liệu ViSignLanguage-Video, cuộc thi AI PTIT (CC-BY-4.0).",
};

async function openSign(sign) {
  $("sheet-title").textContent = sign.base;
  $("sheet-region").textContent = sign.region ? `Biến thể ${REGION_NAMES[sign.region]}` : "Không chia vùng miền";
  const skeleton = app.skeletons?.get(sign.label);
  $("sheet-source").textContent = SOURCE_NAMES[skeleton?.source || sign.source] || "";
  const img = $("sheet-gif");
  const stage = $("sheet-3d");
  $("sheet-missing").hidden = true;
  img.hidden = true;
  stage.hidden = false;
  $("viewer-controls").hidden = true;
  $("sign-sheet").showModal();
  const showGif = () => {
    stage.hidden = true;
    if (!sign.classId) { $("sheet-missing").hidden = false; return; }
    img.hidden = false;
    img.alt = `Hoạt họa khung xương ký hiệu ${sign.label}`;
    img.onerror = () => { img.hidden = true; $("sheet-missing").hidden = false; };
    img.src = `media/animations/class_${String(sign.classId).padStart(4, "0")}.gif`;
  };
  if (!skeleton) { showGif(); return; }
  try {
    if (!app.viewer) {
      const { SignViewer } = await import("./viewer3d.js");
      app.viewer = new SignViewer(stage, app.skeletonManifest);
    }
    await app.viewer.show(skeleton);
    app.viewer.playing = true;
    app.viewer.speed = Number(document.querySelector('input[name="viewer-speed"]:checked').value);
    app.viewer.setMirror($("viewer-mirror").checked);
    $("viewer-play").textContent = "Tạm dừng";
    $("viewer-controls").hidden = false;
  } catch {
    showGif();
  }
}
$("viewer-play").addEventListener("click", () => {
  if (!app.viewer) return;
  app.viewer.playing = !app.viewer.playing;
  $("viewer-play").textContent = app.viewer.playing ? "Tạm dừng" : "Phát";
});
document.querySelectorAll('input[name="viewer-speed"]').forEach((radio) => radio.addEventListener("change", () => { if (app.viewer) app.viewer.speed = Number(radio.value); }));
$("viewer-mirror").addEventListener("change", (event) => app.viewer?.setMirror(event.target.checked));
$("viewer-reset").addEventListener("click", () => app.viewer?.resetView());
$("sign-sheet").addEventListener("close", () => app.viewer?.sleep());
$("sheet-close").addEventListener("click", () => $("sign-sheet").close());
for (const dialog of document.querySelectorAll("dialog.sheet")) {
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
}

/* ---------- User study ---------- */
app.study = initStudy({
  getModel: () => app.model,
  getSigns: () => app.index?.signs ?? [],
  openSign: (sign) => openSign(sign),
});
$("open-study").addEventListener("click", () => showView("study"));

/* ---------- Personal signs ---------- */
app.personal = new PersonalSigns();
app.personalView = initPersonal({
  personal: app.personal,
  getModel: () => app.model,
  getSigns: () => app.index?.signs ?? [],
  onChange: () => { if (app.session && app.model) app.session.personal = app.personal.matcher(app.model.json.model_version); },
});
$("open-personal").addEventListener("click", () => showView("personal"));
$("go-spell").addEventListener("click", () => showView("spell"));

/* ---------- Fingerspelling ---------- */
app.spellView = initSpell({
  onSend: (text) => addMessage("deaf", text, "spell"),
  onShow: (text) => openShow(text, "deaf"),
  speak: (text) => speak(text),
});

/* ---------- Start ---------- */
async function init() {
  applySettings();
  updateComposerMode();
  renderMessages();
  renderPhrases();
  renderRegions();
  setStatus("off");
  try {
    const response = await fetch("model/voya_temporal.json");
    if (!response.ok) throw new Error(String(response.status));
    app.model = createModel(await response.json());
    let names = {};
    try { const r = await fetch("media/labels.json"); if (r.ok) names = await r.json(); } catch { /* optional */ }
    const signs = app.model.classes.map((label) => ({ label, classId: app.model.json.class_ids[label], source: app.model.json.sources?.[label] || "voya" }));
    try {
      const r = await fetch("signs/manifest.json");
      if (r.ok) {
        app.skeletonManifest = await r.json();
        app.skeletons = new Map(app.skeletonManifest.signs.map((s) => [s.label, s]));
      }
    } catch { /* the GIF fallback still works */ }
    app.index = new SignIndex(signs, names);
    $("about-count").textContent = String(signs.length);
    const common = ["chào", "cảm ơn", "xin lỗi", "tạm biệt", "tôi", "bạn", "vâng", "không", "có", "giúp"];
    const missing = common.filter((word) => !app.index.lookup(word).parts.some((part) => part.type === "sign"));
    $("about-missing").textContent = missing.length
      ? `Một số từ thông dụng chưa có dữ liệu nên chưa nhận diện được, ví dụ: ${missing.map((w) => `“${w}”`).join(", ")}.`
      : "Ký hiệu không có trong danh sách hỗ trợ thì chưa nhận diện được.";
    $("signs-summary").textContent = `${signs.length} ký hiệu ứng dụng nhận diện được, kèm mô hình 3D minh họa. Nhiều ký hiệu có biến thể theo vùng miền.`;
    $("model-version").textContent = `Model: ${app.model.json.model_version}`;
    renderSigns();
    renderMessages();
  } catch {
    setStatus("off", { line: "Chưa nạp được model nhận diện", help: "Camera chưa dùng được. Hội thoại bằng chữ, giọng nói và câu nhanh vẫn hoạt động." });
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
init();
