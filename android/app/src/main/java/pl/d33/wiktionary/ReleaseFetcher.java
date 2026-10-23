package pl.d33.wiktionary;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Pattern;

/**
 * Fetches files of the data releases for ReleaseProxy (and pronunciation
 * audio for AudioProxy). Plain Java (no
 * Android classes) so the redirect, header and retry handling is unit tested
 * on the JVM against a local server.
 *
 * GitHub answers a release download with a redirect from github.com to
 * release-assets.githubusercontent.com; redirects are followed here hop by
 * hop rather than left to HttpURLConnection, so every hop gets the same
 * headers and a failure names the host it happened on. Connection errors and
 * 5xx answers are retried; 4xx answers are final. On success the body is
 * returned as an open stream, never buffered.
 */
final class ReleaseFetcher {
    static final Pattern ALLOWED_PATH =
            Pattern.compile("(latest/download|download/[A-Za-z0-9._-]+)/[A-Za-z0-9._-]+");
    static final String USER_AGENT = "WiktionaryLookup (+https://github.com/d33mobile/wiktionary-lookup-data)";
    private static final int MAX_REDIRECTS = 5;
    private static final int HTTP_PERMANENT_REDIRECT = 308;
    private static final int HTTP_TEMPORARY_REDIRECT = 307;

    /** Outcome of one fetch: an open body, or a status and a message saying what failed. */
    static final class Result {
        final int status;
        final long length;
        final InputStream body;
        final String error;
        final String finalUrl;

        private Result(int status, long length, InputStream body, String error, String finalUrl) {
            this.status = status;
            this.length = length;
            this.body = body;
            this.error = error;
            this.finalUrl = finalUrl;
        }

        boolean ok() {
            return body != null;
        }
    }

    interface Listener {
        void onAttempt(String url, int attempt);

        void onResult(String path, Result result);
    }

    private final String base;
    private final int timeoutMs;
    private final long[] retryDelaysMs;
    private final Listener listener;

    /** base ends with "/" (e.g. https://github.com/OWNER/REPO/releases/). */
    ReleaseFetcher(String base, int timeoutMs, long[] retryDelaysMs, Listener listener) {
        this.base = base;
        this.timeoutMs = timeoutMs;
        this.retryDelaysMs = retryDelaysMs.clone();
        this.listener = listener;
    }

    Result fetch(String path) {
        Result result = fetchWithRetries(path);
        if (listener != null) listener.onResult(path, result);
        return result;
    }

    private Result fetchWithRetries(String path) {
        if (!ALLOWED_PATH.matcher(path).matches()) {
            return new Result(404, -1, null, "not a release download path: " + path, null);
        }
        Result last = null;
        for (int attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
            if (attempt > 0) {
                try {
                    Thread.sleep(retryDelaysMs[attempt - 1]);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return last;
                }
            }
            last = attempt(base + path, attempt);
            if (last.ok() || (last.status >= 400 && last.status < 500)) return last;
        }
        return last;
    }

    /** Any absolute URL with the same redirect, header and retry handling (no path check). */
    Result fetchUrl(String url) {
        Result last = null;
        for (int attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
            if (attempt > 0) {
                try {
                    Thread.sleep(retryDelaysMs[attempt - 1]);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return last;
                }
            }
            last = attempt(url, attempt);
            if (last.ok() || (last.status >= 400 && last.status < 500)) break;
        }
        if (listener != null) listener.onResult(url, last);
        return last;
    }

    private Result attempt(String start, int attempt) {
        String url = start;
        try {
            for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
                if (listener != null) listener.onAttempt(url, attempt);
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(timeoutMs);
                conn.setReadTimeout(timeoutMs);
                conn.setRequestProperty("User-Agent", USER_AGENT);
                conn.setRequestProperty("Accept", "*/*");
                // The page gunzips .gz assets itself and counts progress against
                // the stored size; transparent decoding would get in the way.
                conn.setRequestProperty("Accept-Encoding", "identity");
                int status = conn.getResponseCode();
                if (isRedirect(status)) {
                    String location = conn.getHeaderField("Location");
                    conn.disconnect();
                    if (location == null) return failure(502, "redirect without Location from " + host(url), url);
                    URL next = new URL(new URL(url), location);
                    if (!next.getProtocol().equals(new URL(start).getProtocol())) {
                        return failure(502, "redirect to another scheme: " + next.getProtocol(), url);
                    }
                    url = next.toString();
                    continue;
                }
                if (status != HttpURLConnection.HTTP_OK) {
                    conn.disconnect();
                    return failure(status, "upstream HTTP " + status + " from " + host(url), url);
                }
                return new Result(status, conn.getContentLengthLong(), conn.getInputStream(), null, url);
            }
            return failure(502, "too many redirects from " + host(start), url);
        } catch (IOException | RuntimeException e) {
            return failure(502, NetworkHints.describe(e, host(url)), url);
        }
    }

    private static boolean isRedirect(int status) {
        return status == HttpURLConnection.HTTP_MOVED_PERM || status == HttpURLConnection.HTTP_MOVED_TEMP
                || status == HttpURLConnection.HTTP_SEE_OTHER || status == HTTP_TEMPORARY_REDIRECT
                || status == HTTP_PERMANENT_REDIRECT;
    }

    private static String host(String url) {
        try {
            return new URL(url).getHost();
        } catch (IOException e) {
            return url;
        }
    }

    private static Result failure(int status, String error, String url) {
        return new Result(status, -1, null, error, url);
    }
}
