package pl.d33.wiktionary;

import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
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
    private final IndexStore indexes;
    private final ReleaseFetcher releases;
    private final Consumer<String> runJs;
    private final Runnable pickFile;
    private final PagePanel pages;
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();
    private final Map<String, AtomicBoolean> running = new ConcurrentHashMap<>();

    /** runJs(script) evaluates a script in the page (from any thread). */
    /** pickFile opens the system file picker; MainActivity hands the text to window.onPickedText. */
    PageBridge(Context context, Speech speech, AudioProxy audio, IndexStore indexes, ReleaseFetcher releases,
               Consumer<String> runJs, Runnable pickFile, PagePanel pages) {
        this.pickFile = pickFile;
        this.pages = pages;
        this.context = context;
        this.speech = speech;
        this.audio = audio;
        this.indexes = indexes;
        this.releases = releases;
        this.runJs = runJs;
    }

    // The entry's Wiktionary or Wikipedia page in the in-app panel (PagePanel).
    private static boolean wikiUrl(String url) {
        Uri u = Uri.parse(url);
        String host = u.getHost();
        return "https".equals(u.getScheme()) && host != null
                && (host.endsWith(".wiktionary.org") || host.endsWith(".wikipedia.org"));
    }

    /** Loads the page in the hidden panel (one at a time). */
    @JavascriptInterface
    public void prefetchPage(String url) {
        if (wikiUrl(url)) pages.prefetchLater(url);
    }

    @JavascriptInterface
    public void showPage(String url) {
        if (wikiUrl(url)) pages.showLater(url);
    }

    @JavascriptInterface
    public String pageState() {
        return pages.state();
    }

    /** Panel mode and the timings of its last show (Diagnostics). */
    @JavascriptInterface
    public String panelDiagnostics() {
        return pages.diagnostics();
    }

    /** "drawn" or "gone"; applies from the next start of the app. */
    @JavascriptInterface
    public void setPanelMode(String mode) {
        PagePanel.setMode(context, mode);
    }

    /** Shares text (a favourites export) through the system share sheet. */
    @JavascriptInterface
    public void shareText(String title, String text) {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_SUBJECT, title);
        send.putExtra(Intent.EXTRA_TITLE, title);
        send.putExtra(Intent.EXTRA_TEXT, text);
        Intent chooser = Intent.createChooser(send, title);
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(chooser);
    }

    /** Lets the user pick a text file (a favourites export); see window.onPickedText. */
    @JavascriptInterface
    public void pickTextFile() {
        pickFile.run();
    }

    // Index files in app storage (IndexStore), served at /local/<name>.

    /** Size of a stored index file, -1 when missing. */
    @JavascriptInterface
    public double indexFileSize(String name) {
        return IndexStore.validName(name) ? indexes.size(name) : -1;
    }

    @JavascriptInterface
    public boolean deleteIndexFile(String name) {
        return IndexStore.validName(name) && indexes.delete(name);
    }

    /** Bytes [offset, offset + length) of a stored index file, base64; "" on error. */
    @JavascriptInterface
    public String readIndexRange(String name, double offset, int length) {
        try {
            return Base64.encodeToString(indexes.read(name, (long) offset, length), Base64.NO_WRAP);
        } catch (IOException | IllegalArgumentException e) {
            return "";
        }
    }

    /**
     * Downloads a release asset into app storage: json {id, name, path (the part
     * after /remote/), bytes, sha256, gzip}. Reports through
     * window.onNativeDownload(id, state, done, total, error), state one of
     * progress, done, error.
     */
    @JavascriptInterface
    public void startIndexDownload(String json) {
        final JSONObject req;
        try {
            req = new JSONObject(json);
        } catch (JSONException e) {
            return;
        }
        final String id = req.optString("id");
        final AtomicBoolean cancelled = new AtomicBoolean();
        running.put(id, cancelled);
        downloads.execute(() -> {
            final long[] lastReport = {0};
            try {
                ReleaseFetcher.Result r = releases.fetch(req.getString("path"));
                if (!r.ok()) throw new IOException("HTTP " + r.status + " (" + r.error + ")");
                indexes.store(req.getString("name"), r.body, req.optBoolean("gzip"), req.optLong("bytes"),
                        req.optString("sha256", null), (done, total) -> {
                            long now = System.currentTimeMillis();
                            if (now - lastReport[0] >= 150) {
                                lastReport[0] = now;
                                report(id, "progress", done, total, null);
                            }
                        }, cancelled);
                report(id, "done", req.optLong("bytes"), req.optLong("bytes"), null);
            } catch (IOException | JSONException | RuntimeException e) {
                report(id, "error", 0, 0, cancelled.get() ? "cancelled" : e.getMessage());
            } finally {
                running.remove(id);
            }
        });
    }

    @JavascriptInterface
    public void cancelIndexDownload(String id) {
        AtomicBoolean c = running.get(id);
        if (c != null) c.set(true);
    }

    private void report(String id, String state, long done, long total, String error) {
        runJs.accept("window.onNativeDownload && window.onNativeDownload(" + JSONObject.quote(id) + ","
                + JSONObject.quote(state) + "," + done + "," + total + "," + (error == null ? "null" : JSONObject.quote(error)) + ")");
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
        audio.prefetch(names(namesJson),
                name -> runJs.accept("window.onAudioCached && window.onAudioCached(" + JSONObject.quote(name) + ")"));
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
