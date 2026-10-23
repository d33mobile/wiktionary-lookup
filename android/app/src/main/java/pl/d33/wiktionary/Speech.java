package pl.d33.wiktionary;

import android.content.Context;
import android.speech.tts.TextToSpeech;
import android.util.Log;

import java.util.Locale;

/**
 * Android TextToSpeech for headwords. speak() answers at once with a status
 * the page shows: "ok", "starting" (the engine is still binding; the page
 * retries), "no-engine", "no-voice" (no voice for that language; the page
 * offers the TTS settings) or "error".
 */
final class Speech {
    private static final String TAG = "Speech";

    private final TextToSpeech tts;
    private volatile int state; // 0 starting, 1 ready, -1 failed

    Speech(Context context) {
        tts = new TextToSpeech(context, status -> {
            state = status == TextToSpeech.SUCCESS ? 1 : -1;
            Log.i(TAG, "engine " + (state == 1 ? "ready" : "failed") + " (" + status + ")");
        });
    }

    String speak(String text, String languageCode) {
        if (state == 0) return "starting";
        if (state < 0) return "no-engine";
        String tag = Pronunciation.ttsTag(languageCode);
        Locale locale = Locale.forLanguageTag(tag);
        int available = tts.isLanguageAvailable(locale);
        if (available < TextToSpeech.LANG_AVAILABLE) {
            Log.i(TAG, "no voice for " + tag + " (" + available + ")");
            return "no-voice";
        }
        tts.setLanguage(locale);
        int result = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "headword");
        Log.i(TAG, "speak " + tag + " \"" + text + "\": " + result);
        return result == TextToSpeech.SUCCESS ? "ok" : "error";
    }

    void shutdown() {
        tts.shutdown();
    }
}
