/** Feature/browser detection for the voice I/O module. Client-side only. */

export function isSpeechRecognitionSupported(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function getSpeechRecognitionCtor(): (new () => SpeechRecognition) | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/**
 * SpeechRecognition is a de facto Chromium-only feature (Chrome, Edge, Opera,
 * Brave, ...). Firefox and Safari either lack it or ship a broken/limited
 * implementation, so we advise Chrome specifically even where feature
 * detection alone might pass.
 */
export function isChromiumBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // Chrome, Edge, Opera, Brave, and Chrome-on-iOS all identify as Chromium-family.
  return /Chrome|Chromium|CriOS|Edg\/|OPR\//.test(ua);
}
