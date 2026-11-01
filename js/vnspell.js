// Vietnamese spelling for fingerspelling: letters come in one by one, then
// VSL marks (mũ ^, râu, trăng) and tones change the current syllable, the
// same order as Telex typing. Also ranks accented word suggestions for a
// plain-letter spelling ("cam on" -> "cảm ơn").

const TONES = ["", "huyen", "sac", "hoi", "nga", "nang"];
// Each row: one vowel in tone order (none, huyền, sắc, hỏi, ngã, nặng).
const VOWEL_ROWS = {
  a: "aàáảãạ", ă: "ăằắẳẵặ", â: "âầấẩẫậ", e: "eèéẻẽẹ", ê: "êềếểễệ", i: "iìíỉĩị",
  o: "oòóỏõọ", ô: "ôồốổỗộ", ơ: "ơờớởỡợ", u: "uùúủũụ", ư: "ưừứửữự", y: "yỳýỷỹỵ",
};
const CHAR_INFO = new Map(); // "ấ" -> { vowel: "â", tone: 2 }
for (const [vowel, row] of Object.entries(VOWEL_ROWS)) [...row].forEach((ch, tone) => CHAR_INFO.set(ch, { vowel, tone }));
const PLAIN = { ă: "a", â: "a", ê: "e", ô: "o", ơ: "o", ư: "u", đ: "d" };
const MARKED = new Set(["ă", "â", "ê", "ô", "ơ", "ư"]);

const info = (ch) => CHAR_INFO.get(ch);
const withTone = (vowel, tone) => VOWEL_ROWS[vowel][tone];

/** "Cảm ơn" -> "cam on": no tones, no marks, đ -> d. */
export function plainKey(text) {
  return [...String(text).toLocaleLowerCase("vi").normalize("NFC")].map((ch) => {
    const v = info(ch);
    const base = v ? v.vowel : ch;
    return PLAIN[base] ?? base;
  }).join("");
}

function splitSyllable(word) {
  const cut = word.lastIndexOf(" ") + 1;
  return [word.slice(0, cut), word.slice(cut)];
}

/** Indexes of the vowel nucleus, skipping the u of "qu" and the i of "gi". */
function nucleus(chars) {
  const vowels = [];
  chars.forEach((ch, i) => { if (info(ch)) vowels.push(i); });
  if (vowels.length > 1) {
    const first = vowels[0];
    const lead = chars.slice(0, first).join("");
    const base = info(chars[first]).vowel;
    if ((lead === "q" && base === "u") || (lead === "g" && base === "i")) vowels.shift();
  }
  return vowels;
}

function currentTone(chars) {
  for (const ch of chars) { const v = info(ch); if (v && v.tone) return v.tone; }
  return 0;
}

/** Where the tone goes (traditional placement: hòa, thúy, quỳnh, người). */
function tonePosition(chars) {
  const vowels = nucleus(chars);
  if (!vowels.length) return -1;
  const marked = vowels.filter((i) => MARKED.has(info(chars[i]).vowel));
  if (marked.length) return marked.at(-1); // ươ -> on ơ
  if (vowels.length === 1) return vowels[0];
  const last = vowels.at(-1);
  if (last < chars.length - 1) return last; // final consonant: hoàn, tiến, quyết
  if (vowels.length >= 3) return vowels[1];
  return vowels[0];
}

function placeTone(chars, tone) {
  const stripped = chars.map((ch) => { const v = info(ch); return v ? v.vowel : ch; });
  const at = tonePosition(stripped);
  if (at >= 0 && tone) stripped[at] = withTone(stripped[at], tone);
  return stripped;
}

/** Apply a mark (^ "mu", horn "rau", breve "trang") to the last syllable. */
export function applyMark(word, mark) {
  const [head, syllable] = splitSyllable(word);
  const tone = currentTone([...syllable]);
  const chars = [...syllable].map((ch) => { const v = info(ch); return v ? v.vowel : ch; });
  let changed = false;
  const lastIndex = (bases) => {
    for (let i = chars.length - 1; i >= 0; i--) if (bases.includes(chars[i])) return i;
    return -1;
  };
  if (mark === "mu") {
    const i = lastIndex(["a", "e", "o"]);
    if (i >= 0) { chars[i] = { a: "â", e: "ê", o: "ô" }[chars[i]]; changed = true; }
  } else if (mark === "rau") {
    const uo = chars.findIndex((ch, i) => ch === "u" && chars[i + 1] === "o");
    if (uo >= 0 && !(uo > 0 && chars[uo - 1] === "q")) { chars[uo] = "ư"; chars[uo + 1] = "ơ"; changed = true; }
    else if (chars.join("").includes("uu")) { chars[chars.join("").indexOf("uu")] = "ư"; changed = true; } // hưu
    else {
      const i = lastIndex(["o", "u", "ô"]);
      if (i >= 0 && !(chars[i] === "u" && chars[i - 1] === "q")) { chars[i] = chars[i] === "u" ? "ư" : "ơ"; changed = true; }
    }
  } else if (mark === "trang") {
    const i = lastIndex(["a", "â"]);
    if (i >= 0) { chars[i] = "ă"; changed = true; }
  }
  if (!changed) return { word, changed };
  return { word: head + placeTone(chars, tone).join(""), changed };
}

/** Set the tone of the last syllable ("" / "huyen" / "sac" / "hoi" / "nga" / "nang"). */
export function applyTone(word, toneName) {
  const tone = Math.max(0, TONES.indexOf(toneName));
  const [head, syllable] = splitSyllable(word);
  const chars = [...syllable];
  if (!nucleus(chars.map((ch) => { const v = info(ch); return v ? v.vowel : ch; })).length) return { word, changed: false };
  const next = head + placeTone(chars, tone).join("");
  return { word: next, changed: next !== word };
}

export const TONE_NAMES = { sac: "sắc", huyen: "huyền", hoi: "hỏi", nga: "ngã", nang: "nặng", "": "không dấu" };

/** Is `candidate` consistent with what the signer already spelled (marks/tones they gave)? */
function respectsSpelling(candidate, typed) {
  const a = [...candidate], b = [...typed];
  if (a.length < b.length) return false;
  for (let i = 0; i < b.length; i++) {
    const t = info(b[i]), c = info(a[i]);
    if (!t) { if ((PLAIN[a[i]] ?? a[i]) !== b[i] && a[i] !== b[i]) return false; continue; }
    if (!c) return false;
    if (MARKED.has(t.vowel) && c.vowel !== t.vowel) return false;
    if (t.tone && c.tone !== t.tone) return false;
  }
  return true;
}

/**
 * Lexicon: { words: [[text, weight], ...] } with single syllables and phrases.
 * suggest("cam on") -> ["cảm ơn", "cám ơn", ...]; suggest("ng") -> prefix completions.
 */
export class Lexicon {
  constructor(json) {
    this.byKey = new Map();
    this.entries = (json.words || []).map(([text, weight]) => ({ text, weight, key: plainKey(text) }));
    for (const e of this.entries) {
      if (!this.byKey.has(e.key)) this.byKey.set(e.key, []);
      this.byKey.get(e.key).push(e);
    }
    for (const list of this.byKey.values()) list.sort((a, b) => b.weight - a.weight);
    this.sortedKeys = [...this.byKey.keys()].sort();
  }

  /** Entries for one plain-letter key, plus prefix completions (single words first). */
  lookup(typed, limit) {
    const key = plainKey(typed);
    const out = [];
    const seen = new Set();
    const push = (e) => {
      if (seen.has(e.text) || !respectsSpelling(e.text, typed)) return;
      seen.add(e.text);
      out.push(e.text);
    };
    (this.byKey.get(key) || []).forEach(push);
    if (out.length < limit && key.replace(/ /g, "").length >= 2) {
      const more = [];
      let lo = 0, hi = this.sortedKeys.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (this.sortedKeys[mid] < key) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < this.sortedKeys.length && this.sortedKeys[i].startsWith(key) && more.length < 400; i++) {
        if (this.sortedKeys[i] !== key) more.push(...this.byKey.get(this.sortedKeys[i]));
      }
      const words = (e) => e.text.split(" ").length;
      more.sort((a, b) => words(a) - words(b) || b.weight - a.weight).forEach(push);
    }
    return out;
  }

  /**
   * Whole-text replacements for what was spelled so far: a known phrase for
   * the last syllables first ("cam on" -> "cảm ơn"), then choices for the last
   * syllable with the earlier syllables kept as they are ("xin chao" -> "xin chào").
   */
  suggest(spelled, limit = 5) {
    const typed = String(spelled).toLocaleLowerCase("vi").trim().replace(/\s+/g, " ");
    if (!typed) return [];
    const syllables = typed.split(" ");
    const out = [];
    const add = (text) => { if (!out.includes(text) && text !== typed) out.push(text); };
    for (let n = Math.min(4, syllables.length); n >= 2; n--) {
      const head = syllables.slice(0, -n).join(" ");
      for (const phrase of this.lookup(syllables.slice(-n).join(" "), limit)) {
        if (phrase.split(" ").length >= n) add(head ? `${head} ${phrase}` : phrase);
      }
    }
    // Only the syllable being spelled changes; earlier ones stay as the signer left them.
    const head = syllables.slice(0, -1).join(" ");
    for (const word of this.lookup(syllables.at(-1), limit * 2)) add(head ? `${head} ${word}` : word);
    return out.slice(0, limit);
  }
}

const MARK_SIGN = { "â": "mũ", "ê": "mũ", "ô": "mũ", "ơ": "râu", "ư": "râu" };
const TONE_MOTION = ["", "dấu huyền", "dấu sắc", "dấu hỏi", "dấu ngã", "dấu nặng"];

/**
 * How to fingerspell a text in VSL order: per syllable the letters, a mũ/râu
 * sign or the breve motion right after its vowel, the tone motion at the end.
 * spellSequence("tạm biệt") -> [[{letter:"t"},{letter:"a"},{letter:"m"},{motion:"dấu nặng"}], ...]
 */
export function spellSequence(text) {
  const out = [];
  for (const syllable of String(text).toLocaleLowerCase("vi").normalize("NFC").split(/\s+/).filter(Boolean)) {
    const steps = [];
    let tone = 0;
    for (const ch of syllable) {
      const v = info(ch);
      const base = v ? v.vowel : ch;
      if (v?.tone) tone = v.tone;
      const plain = PLAIN[base] ?? base;
      if (base === "đ") steps.push({ letter: "đ" });
      else if (/[a-z]/.test(plain)) steps.push({ letter: plain });
      else continue;
      if (MARK_SIGN[base]) steps.push({ letter: MARK_SIGN[base] });
      if (base === "ă") steps.push({ motion: "dấu trăng", mark: "trang" });
    }
    if (tone) steps.push({ motion: TONE_MOTION[tone], tone: TONES[tone] });
    if (steps.length) out.push({ syllable, steps });
  }
  return out;
}
