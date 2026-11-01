// Vietnamese speech-to-text (Web Speech API) and read-aloud (speechSynthesis).
// Chrome and Edge send microphone audio to their own speech service; the app
// tells the user before the first use.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const speechInputSupported = Boolean(Recognition);
export const speechOutputSupported = "speechSynthesis" in window;

export function listen({ onInterim, onFinal, onEnd, onError }) {
  if (!Recognition) throw new Error("unsupported");
  const recognizer = new Recognition();
  recognizer.lang = "vi-VN";
  recognizer.interimResults = true;
  recognizer.continuous = false;
  recognizer.maxAlternatives = 1;
  recognizer.onresult = (event) => {
    let interim = "", final = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const text = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += text; else interim += text;
    }
    if (interim) onInterim?.(interim.trim());
    if (final) onFinal?.(final.trim());
  };
  recognizer.onerror = (event) => onError?.(event.error);
  recognizer.onend = () => onEnd?.();
  recognizer.start();
  return () => recognizer.stop();
}

export function speak(text) {
  if (!speechOutputSupported || !text) return false;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "vi-VN";
  const voice = speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith("vi"));
  if (voice) utterance.voice = voice;
  utterance.rate = 0.95;
  speechSynthesis.speak(utterance);
  return true;
}
