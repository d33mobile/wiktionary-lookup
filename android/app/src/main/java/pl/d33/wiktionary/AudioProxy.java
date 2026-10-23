package pl.d33.wiktionary;

import android.content.Context;
import android.util.Log;
import android.webkit.WebResourceResponse;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * Serves Wiktionary pronunciation files from Wikimedia Commons under the
 * page's origin: /audio/<file name> fetches Special:FilePath/<file name>
 * (which redirects to upload.wikimedia.org) into an AudioCache in
 * cacheDir/audio (50 MB, least recently used first out), so a word heard
 * once plays again offline. prefetch() fills the cache in the background
 * for the results on screen; a newer prefetch call cancels the files of
 * older ones that have not started.
 */
final class AudioProxy implements WebViewAssetLoader.PathHandler {
    static final String PREFIX = "/audio/";
    private static final String TAG = "AudioProxy";
    private static final int TIMEOUT_MS = 20_000;
    private static final long[] RETRY_DELAYS_MS = {1_000};
    private static final long[] NO_RETRY = {};
    private static final long MAX_FILE_BYTES = 5L * 1024 * 1024;
    static final long MAX_CACHE_BYTES = 50L * 1024 * 1024;
    private static final int PREFETCH_THREADS = 4;

    private final AudioCache cache;
    private final ReleaseFetcher fetcher = new ReleaseFetcher("", TIMEOUT_MS, RETRY_DELAYS_MS, null);
    // Prefetch gives up at once on failure: it is quiet and retried by the next tap.
    private final ReleaseFetcher prefetcher = new ReleaseFetcher("", TIMEOUT_MS, NO_RETRY, null);
    private final ExecutorService pool = Executors.newFixedThreadPool(PREFETCH_THREADS);
    private final AtomicInteger generation = new AtomicInteger();

    AudioProxy(Context context) {
        cache = new AudioCache(new File(context.getCacheDir(), "audio"), MAX_CACHE_BYTES, System::currentTimeMillis);
    }

    boolean cached(String name) {
        return Pronunciation.validFileName(name) && cache.contains(name);
    }

    @Override
    public WebResourceResponse handle(String path) {
        String name;
        try {
            name = URLDecoder.decode(path, "UTF-8");
        } catch (IllegalArgumentException | IOException e) {
            return error(404, "bad file name");
        }
        if (!Pronunciation.validFileName(name)) return error(404, "bad file name");
        try {
            File f = cache.hit(name);
            String how = "from cache";
            if (f == null) {
                f = download(name, fetcher);
                how = "downloaded";
            }
            Log.i(TAG, name + ": " + f.length() + " bytes " + how);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            return new WebResourceResponse(mimeType(name), null, 200, "OK", headers, new FileInputStream(f));
        } catch (IOException e) {
            Log.w(TAG, name + ": " + e.getMessage());
            return error(502, e.getMessage());
        }
    }

    /** Downloads the names not cached yet; done(name) runs for each one stored. */
    void prefetch(List<String> names, Consumer<String> done) {
        int mine = generation.incrementAndGet();
        for (String name : names) {
            if (!Pronunciation.validFileName(name) || cache.contains(name)) continue;
            pool.execute(() -> {
                if (generation.get() != mine || cache.contains(name)) return;
                try {
                    File f = download(name, prefetcher);
                    Log.i(TAG, name + ": " + f.length() + " bytes prefetched");
                    done.accept(name);
                } catch (IOException e) {
                    Log.d(TAG, "prefetch " + name + ": " + e.getMessage());
                }
            });
        }
    }

    private File download(String name, ReleaseFetcher via) throws IOException {
        ReleaseFetcher.Result r = via.fetchUrl(Pronunciation.commonsUrl(name));
        CrashReporting.breadcrumb("audio", name + ": " + r.status + (r.error != null ? " " + r.error : ""));
        if (!r.ok()) throw new IOException(r.error);
        return cache.store(name, r.body, MAX_FILE_BYTES);
    }

    static String mimeType(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".flac")) return "audio/flac";
        if (lower.endsWith(".webm")) return "audio/webm";
        // .ogg, .oga and .opus are Ogg containers.
        return "audio/ogg";
    }

    private static WebResourceResponse error(int status, String message) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", status, status == 404 ? "Not Found" : "Bad Gateway",
                headers, new ByteArrayInputStream(String.valueOf(message).getBytes(StandardCharsets.UTF_8)));
    }
}
