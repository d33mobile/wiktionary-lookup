// Pronunciation of a result: the entry's Wiktionary recording (Wikimedia
// Commons) when it has one and the setting allows, otherwise text-to-speech
// of the headword. In the Android app speech is the system TextToSpeech
// through window.WiktionaryNative and recordings come through the app's
// /audio/ path (cached on the device); in a browser, speechSynthesis and the
// Commons URL directly (media elements need no CORS).

import { AUDIO_URL_PREFIX } from '../lib/engine.js';

const ANDROID_HOST = 'appassets.androidplatform.net';
// Speech voices for index languages whose bare code picks the wrong one;
// the Android app has the same table in Pronunciation.java.
const SPEECH_TAGS = { zh: 'zh-CN', cmn: 'zh-CN', yue: 'zh-HK', ja: 'ja-JP', ko: 'ko-KR', nb: 'nb-NO', no: 'nb-NO' };
const START_RETRY_MS = 300;
const START_RETRIES = 20;

export function commonsUrl(name) {
  return AUDIO_URL_PREFIX + encodeURIComponent(name);
}

export function audioUrl(name, location) {
  if (location.hostname === ANDROID_HOST) return new URL(`/audio/${encodeURIComponent(name)}`, location.href).href;
  return commonsUrl(name);
}

const PREFETCH_KEY = 'wiktionary-lookup.prefetch';
export const PREFETCH = { always: 'always', wifi: 'wifi', off: 'off' };

// Background download of recordings (Android app only): default Wi-Fi only.
export function getPrefetchMode() {
  try {
    const v = localStorage.getItem(PREFETCH_KEY);
    return v === PREFETCH.always || v === PREFETCH.off ? v : PREFETCH.wifi;
  } catch (err) {
    return PREFETCH.wifi;
  }
}

export function setPrefetchMode(mode) {
  try {
    localStorage.setItem(PREFETCH_KEY, mode);
  } catch (err) {
    // Not remembered; applies until the page reloads.
  }
}

function hasAudio(entry) {
  return Array.isArray(entry.audio) && entry.audio.length > 0;
}

let player = null;

// kind 'audio' plays the entry's first recording (falling back to speech
// when it cannot be played), 'tts' speaks the headword.
// -> Promise of {kind: 'audio'|'speech', status, detail}; status is 'ok',
// 'no-voice', 'no-engine', 'unsupported' or 'error'.
export function pronounce(entry, languageCode, { kind = 'audio' } = {}) {
  if (kind === 'audio' && hasAudio(entry)) {
    return playRecording(entry.audio[0]).catch(() => speak(entry.simp, languageCode));
  }
  return speak(entry.simp, languageCode);
}

function playRecording(name) {
  if (player) player.pause();
  player = new Audio(audioUrl(name, location));
  const audio = player;
  return new Promise((resolve, reject) => {
    audio.addEventListener('playing', () => resolve({ kind: 'audio', status: 'ok', detail: name }), { once: true });
    audio.addEventListener('error', () => reject(new Error(`cannot play ${name}`)), { once: true });
    audio.play().catch(reject);
  });
}

function speak(text, languageCode) {
  const native = window.WiktionaryNative;
  const code = String(languageCode || '').toLowerCase();
  if (native && native.speak) {
    // The engine binds asynchronously after start; retry while it says so.
    return new Promise((resolve) => {
      let tries = 0;
      const attempt = () => {
        const status = native.speak(text, code);
        if (status === 'starting' && tries++ < START_RETRIES) setTimeout(attempt, START_RETRY_MS);
        else resolve({ kind: 'speech', status: status === 'starting' ? 'no-engine' : status, detail: code });
      };
      attempt();
    });
  }
  if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') {
    return Promise.resolve({ kind: 'speech', status: 'unsupported', detail: code });
  }
  const tag = SPEECH_TAGS[code] || code;
  const voices = speechSynthesis.getVoices();
  if (voices.length && !voices.some((v) => v.lang.toLowerCase().startsWith(tag.split('-')[0]))) {
    return Promise.resolve({ kind: 'speech', status: 'no-voice', detail: code });
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = tag;
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
  return Promise.resolve({ kind: 'speech', status: 'ok', detail: code });
}

export function openSpeechSettings() {
  const native = window.WiktionaryNative;
  if (native && native.openTtsSettings) native.openTtsSettings();
}
