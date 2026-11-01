// Vietnamese text -> supported VOYA signs. Port of dictionary/sign_dictionary.py
// plus matching on the base name, so "địa chỉ" finds the bắc/trung/nam variants.

const PHRASE_ALIASES = [
  ["xin chào bạn", "chào"], ["xin chào", "chào"], ["chào bạn", "chào"],
  ["xin cảm ơn bạn", "cảm ơn"], ["xin cảm ơn", "cảm ơn"], ["cảm ơn bạn", "cảm ơn"], ["cám ơn", "cảm ơn"],
];
const REGION = /\s*\((bắc|trung|nam)\)\s*$/u;
export const REGION_NAMES = { "bắc": "Miền Bắc", trung: "Miền Trung", nam: "Miền Nam" };

export function normalize(text) {
  return text.normalize("NFC").toLocaleLowerCase("vi")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).join(" ");
}

export function matchKey(text) {
  return normalize(text).normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d");
}

/**
 * A word without diacritics on either side matches loosely ("bun" finds "bún"),
 * but two words that both carry diacritics must be equal, so "biệt" never shows "biết".
 */
export function phraseMatches(tokens, phrase) {
  const target = normalize(phrase).split(" ");
  return target.length === tokens.length && target.every((word, i) =>
    word === tokens[i] || (matchKey(word) === matchKey(tokens[i]) && (tokens[i] === matchKey(tokens[i]) || word === matchKey(word))));
}

/** Split "địa chỉ (bắc)" into its base phrase and region. */
export function parseLabel(label) {
  const match = label.match(REGION);
  return { base: match ? label.replace(REGION, "").trim() : label.trim(), region: match ? match[1] : null };
}

export class SignIndex {
  /** signs: [{label, classId}], names: {class_0001: "..."} (all 4,363 VOYA names) */
  constructor(signs, names = {}) {
    this.signs = signs.map((s) => ({ ...s, ...parseLabel(s.label) }));
    this.byKey = new Map();
    for (const sign of this.signs) {
      for (const phrase of new Set([sign.label, sign.base])) {
        const key = matchKey(phrase);
        if (!this.byKey.has(key)) this.byKey.set(key, []);
        if (!this.byKey.get(key).includes(sign)) this.byKey.get(key).push(sign);
      }
    }
    this.keys = [...this.byKey.keys()].sort((a, b) => b.split(" ").length - a.split(" ").length);
    const supportedIds = new Set(this.signs.map((s) => s.classId).filter((id) => id != null));
    const supportedNames = new Set(this.signs.flatMap((s) => [normalize(s.label), normalize(s.base)]));
    this.unbacked = new Map();
    for (const [key, name] of Object.entries(names)) {
      const id = Number(String(key).replace("class_", ""));
      // Exact (diacritic-sensitive) names: "ở" must not match an unrelated "o".
      // A name trained from another source (e.g. PTIT "chào") is supported.
      const exact = normalize(String(name));
      if (!supportedIds.has(id) && !supportedNames.has(exact)) this.unbacked.set(exact, String(name));
    }
  }

  /** Signs under key k that match tokens[i..] (see phraseMatches). */
  signsAt(tokens, keys, i, k) {
    const p = k.split(" ");
    if (keys.slice(i, i + p.length).join(" ") !== k) return [];
    const slice = tokens.slice(i, i + p.length);
    return this.byKey.get(k).filter((s) => phraseMatches(slice, s.label) || phraseMatches(slice, s.base));
  }

  applyAliases(tokens) {
    const keys = tokens.map(matchKey);
    const aliases = PHRASE_ALIASES.map(([s, t]) => [matchKey(s).split(" "), t]).sort((a, b) => b[0].length - a[0].length);
    const out = [], notes = [];
    for (let i = 0; i < tokens.length;) {
      const direct = this.keys.find((k) => this.signsAt(tokens, keys, i, k).length);
      if (direct) { const n = direct.split(" ").length; out.push(...tokens.slice(i, i + n)); i += n; continue; }
      const alias = aliases.find(([src]) => keys.slice(i, i + src.length).join(" ") === src.join(" "));
      if (alias) {
        notes.push({ source: tokens.slice(i, i + alias[0].length).join(" "), target: alias[1] });
        out.push(...normalize(alias[1]).split(" "));
        i += alias[0].length;
      } else { out.push(tokens[i]); i += 1; }
    }
    return { tokens: out, notes };
  }

  /** Longest-match lookup; unmatched runs are checked against all VOYA names. */
  lookup(text) {
    const { tokens, notes } = this.applyAliases(normalize(text).split(" ").filter(Boolean));
    const keys = tokens.map(matchKey);
    const parts = [];
    let gap = [];
    const flush = () => { if (gap.length) { parts.push({ type: "missing", text: gap.join(" "), known: this.knownNames(gap) }); gap = []; } };
    for (let i = 0; i < tokens.length;) {
      const found = this.keys.find((k) => this.signsAt(tokens, keys, i, k).length);
      if (found) {
        flush();
        const n = found.split(" ").length;
        parts.push({ type: "sign", text: tokens.slice(i, i + n).join(" "), signs: this.signsAt(tokens, keys, i, found) });
        i += n;
      } else { gap.push(tokens[i]); i += 1; }
    }
    flush();
    return { parts, notes };
  }

  knownNames(words) {
    const found = [];
    for (let size = Math.min(words.length, 8); size > 0; size--) {
      for (let start = 0; start + size <= words.length; start++) {
        const name = this.unbacked.get(normalize(words.slice(start, start + size).join(" ")));
        if (name && !found.includes(name)) found.push(name);
      }
    }
    return found;
  }

  search(query, region = "all") {
    const key = matchKey(query);
    return this.signs.filter((s) => (!key || matchKey(s.label).includes(key)) && (region === "all" || (region === "none" ? !s.region : s.region === region)));
  }
}
