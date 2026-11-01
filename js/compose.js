// Turn a list of recognized sign words into a readable Vietnamese sentence.
// Deliberately small, transparent rules (no AI): the raw words stay visible
// next to the suggestion, and the signer chooses what is sent.

const QUESTION_WORDS = ["ai", "gì", "đâu", "nào", "bao nhiêu", "bao giờ", "khi nào", "mấy", "sao", "tại sao", "thế nào", "có thể"];
const PRONOUNS = ["tôi", "bạn", "chúng ta", "họ", "anh", "chị", "em", "mình"];
// Symptoms read naturally with "bị" after a person: "tôi sốt" -> "tôi bị sốt".
const SYMPTOMS = ["sốt", "ho", "đau", "nôn ói", "mệt", "lây bệnh", "dị ứng", "chóng mặt"];
const URGENT = ["cứu", "giúp", "cứu tôi"];

function capitalize(text) {
  return text ? text.charAt(0).toLocaleUpperCase("vi") + text.slice(1) : text;
}

/** words: array of base words (lower case) in signing order. */
export function composeSentence(words) {
  const clean = [];
  for (const word of words.map((w) => String(w).trim()).filter(Boolean)) {
    if (clean.at(-1) !== word) clean.push(word); // a sign confirmed twice in a row
  }
  if (!clean.length) return "";
  const out = [];
  clean.forEach((word, i) => {
    const previous = clean[i - 1];
    if (SYMPTOMS.includes(word) && previous && PRONOUNS.includes(previous)) out.push("bị");
    out.push(word);
  });
  const text = out.join(" ");
  const isQuestion = QUESTION_WORDS.some((q) => ` ${text} `.includes(` ${q} `)) || clean.at(-1) === "không";
  const isUrgent = clean.length <= 2 && clean.some((w) => URGENT.includes(w));
  const mark = isQuestion ? "?" : isUrgent ? "!" : ".";
  return capitalize(text) + mark;
}

export const COMMON_WORDS = ["tôi", "bạn", "cần", "muốn", "không", "có", "ở đâu", "bao nhiêu", "giúp", "cảm ơn"];
