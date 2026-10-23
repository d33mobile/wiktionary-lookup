package pl.d33.wiktionary;

import android.util.Log;
import android.webkit.WebResourceResponse;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Serves the data releases on GitHub under the page's own origin:
 * /remote/latest/download/manifest.json and /remote/download/TAG/FILE.
 *
 * GitHub release downloads answer with redirects that carry no CORS headers,
 * so the page cannot fetch them from https://appassets.androidplatform.net
 * directly. ReleaseFetcher makes the request (WebView calls path handlers
 * off the UI thread) and the body is streamed back unchanged, gzip included;
 * the page decompresses and stores it. A failure answers with the upstream
 * status (502 for network errors) and a text body saying what went wrong,
 * which the page shows.
 */
final class ReleaseProxy implements WebViewAssetLoader.PathHandler {
    static final String PREFIX = "/remote/";
    static final String RELEASES = "https://github.com/d33mobile/wiktionary-lookup-data/releases/";
    private static final String TAG = "ReleaseProxy";
    private static final int TIMEOUT_MS = 30_000;
    private static final long[] RETRY_DELAYS_MS = {1_000, 3_000};

    private final ReleaseFetcher fetcher = new ReleaseFetcher(RELEASES, TIMEOUT_MS, RETRY_DELAYS_MS,
            new ReleaseFetcher.Listener() {
                @Override
                public void onAttempt(String url, int attempt) {
                    Log.i(TAG, "GET " + url + (attempt > 0 ? " (retry " + attempt + ")" : ""));
                }

                @Override
                public void onResult(String path, ReleaseFetcher.Result result) {
                    if (result.ok()) {
                        Log.i(TAG, path + ": " + result.status + ", " + result.length + " bytes");
                    } else {
                        Log.w(TAG, path + ": " + result.status + " " + result.error);
                    }
                    CrashReporting.download(path, result.status, result.error);
                }
            });

    /** The fetcher, also used for native downloads into app storage. */
    ReleaseFetcher fetcher() {
        return fetcher;
    }

    @Override
    public WebResourceResponse handle(String path) {
        ReleaseFetcher.Result result = fetcher.fetch(path);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        if (result.ok()) {
            return new WebResourceResponse("application/octet-stream", null, result.status, "OK", headers, result.body);
        }
        byte[] message = result.error.getBytes(StandardCharsets.UTF_8);
        return new WebResourceResponse("text/plain", "utf-8", result.status, reasonPhrase(result.status), headers,
                new ByteArrayInputStream(message));
    }

    private static String reasonPhrase(int status) {
        if (status == 404) return "Not Found";
        if (status == 403) return "Forbidden";
        if (status >= 500) return "Bad Gateway";
        return "Error";
    }
}
