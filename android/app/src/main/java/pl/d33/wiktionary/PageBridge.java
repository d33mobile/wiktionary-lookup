package pl.d33.wiktionary;

import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.provider.Settings;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONException;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * window.WiktionaryNative in the page: reports JavaScript errors and download
 * steps to CrashReporting, and says when the app has no network. Only the
 * app's own asset origin is ever loaded.
 */
final class PageBridge {
    static final String NAME = "WiktionaryNative";

    private final Context context;
    private final Speech speech;
    private final AudioProxy audio;
    private final Consumer<String> onCached;

    /** onCached(name) runs (on a background thread) when a prefetched file is stored. */
    PageBridge(Context context, Speech speech, AudioProxy audio, Consumer<String> onCached) {
        this.context = context;
        this.speech = speech;
        this.audio = audio;
        this.onCached = onCached;
    }

    /** The installed version, so the page can show what is new since the last start. */
    @JavascriptInterface
    public int appVersionCode() {
        return BuildConfig.VERSION_CODE;
    }

    /** True on a metered (mobile) network: "Wi-Fi only" prefetch stays off. */
    @JavascriptInterface
    public boolean networkMetered() {
        ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
        return cm == null || cm.isActiveNetworkMetered();
    }

    /** Starts downloading the recordings in `namesJson` (a JSON array) that are not cached. */
    @JavascriptInterface
    public void prefetchAudio(String namesJson) {
        audio.prefetch(names(namesJson), onCached);
    }

    /** The subset of `namesJson` already in the cache, as a JSON array. */
    @JavascriptInterface
    public String cachedAudio(String namesJson) {
        JSONArray out = new JSONArray();
        for (String name : names(namesJson)) if (audio.cached(name)) out.put(name);
        return out.toString();
    }

    private static List<String> names(String json) {
        List<String> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(json);
            for (int i = 0; i < a.length(); i++) out.add(a.getString(i));
        } catch (JSONException e) {
            // Not a list of names: nothing to do.
        }
        return out;
    }

    /** Speaks a headword; see Speech.speak for the returned status. */
    @JavascriptInterface
    public String speak(String text, String languageCode) {
        return speech.speak(text, languageCode);
    }

    /** System text-to-speech settings, where voices are installed. */
    @JavascriptInterface
    public void openTtsSettings() {
        Intent intent = new Intent("com.android.settings.TTS_SETTINGS");
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
        } catch (android.content.ActivityNotFoundException e) {
            Intent install = new Intent(android.speech.tts.TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
            install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(install);
        }
    }

    /**
     * "" when the app has a network, else NetworkHints.NO_NETWORK. With a
     * per-app network toggle off, getActiveNetwork() is null for this app.
     */
    @JavascriptInterface
    public String networkProblem() {
        ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
        return cm != null && cm.getActiveNetwork() == null ? NetworkHints.NO_NETWORK : "";
    }

    /** True when data saver restricts this app on the current (metered) network. */
    @JavascriptInterface
    public boolean dataSaverRestricted() {
        ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
        return cm != null && cm.isActiveNetworkMetered()
                && cm.getRestrictBackgroundStatus() == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED;
    }

    /** App info of this app, where LineageOS has its per-app network access switches. */
    @JavascriptInterface
    public void openAppSettings() {
        open(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
    }

    /** The data saver exception switch for this app. */
    @JavascriptInterface
    public void openDataSaverSettings() {
        open(Settings.ACTION_IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS);
    }

    private void open(String action) {
        Intent intent = new Intent(action, Uri.fromParts("package", context.getPackageName(), null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }

    @JavascriptInterface
    public void reportError(String message, String source, int line) {
        CrashReporting.jsError(message, source, line);
    }

    @JavascriptInterface
    public void breadcrumb(String category, String message) {
        CrashReporting.breadcrumb(category, message);
    }
}
