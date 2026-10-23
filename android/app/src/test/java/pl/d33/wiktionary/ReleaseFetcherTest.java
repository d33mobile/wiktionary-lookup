package pl.d33.wiktionary;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * ReleaseFetcher against two local servers standing in for github.com and
 * the asset host it redirects to (different ports, so a cross-host hop).
 */
public class ReleaseFetcherTest {
    private static final long[] NO_DELAY = {0, 0};
    private static final byte[] ASSET = "gzip bytes of an index".getBytes(StandardCharsets.UTF_8);

    private TinyHttpServer github;
    private TinyHttpServer assets;
    private final List<String> seenAgents = new ArrayList<>();
    private final AtomicInteger assetRequests = new AtomicInteger();
    private volatile int failuresBeforeSuccess;

    @Before
    public void start() throws IOException {
        assets = new TinyHttpServer(request -> {
            String agent = request.headers.get("user-agent");
            synchronized (seenAgents) {
                seenAgents.add(agent);
            }
            if (assetRequests.incrementAndGet() <= failuresBeforeSuccess) return text(503, "busy");
            // Like GitHub, refuse requests without a User-Agent.
            if (agent == null || !agent.startsWith("WiktionaryLookup")) return text(403, "no user agent");
            return new TinyHttpServer.Response(200, ASSET);
        });
        github = new TinyHttpServer(request -> {
            if (request.path.endsWith("/missing.gz")) return text(404, "not found");
            return text(302, "").header("Location", "http://localhost:" + assets.port() + "/blob?sig=abc&name=de.idx.gz");
        });
    }

    @After
    public void stop() throws IOException {
        github.close();
        assets.close();
    }

    private ReleaseFetcher fetcher() {
        return new ReleaseFetcher("http://127.0.0.1:" + github.port() + "/releases/", 5_000, NO_DELAY, null);
    }

    @Test
    public void followsTheRedirectToAnotherHostWithTheUserAgent() throws IOException {
        ReleaseFetcher.Result r = fetcher().fetch("download/data-1/de.idx.gz");
        assertTrue(r.error, r.ok());
        assertEquals(200, r.status);
        assertEquals(ASSET.length, r.length);
        assertEquals(new String(ASSET, StandardCharsets.UTF_8), read(r.body));
        assertTrue(r.finalUrl.startsWith("http://localhost:"));
        assertEquals(ReleaseFetcher.USER_AGENT, seenAgents.get(0));
    }

    @Test
    public void retriesServerErrors() throws IOException {
        failuresBeforeSuccess = 2;
        ReleaseFetcher.Result r = fetcher().fetch("latest/download/manifest.json");
        assertTrue(r.error, r.ok());
        assertEquals(3, assetRequests.get());
    }

    @Test
    public void reportsTheLastServerErrorAfterTheRetries() {
        failuresBeforeSuccess = 10;
        ReleaseFetcher.Result r = fetcher().fetch("latest/download/manifest.json");
        assertFalse(r.ok());
        assertEquals(503, r.status);
        assertTrue(r.error, r.error.contains("upstream HTTP 503 from localhost"));
        assertEquals(3, assetRequests.get());
    }

    @Test
    public void doesNotRetryClientErrors() {
        ReleaseFetcher.Result r = fetcher().fetch("download/data-1/missing.gz");
        assertEquals(404, r.status);
        assertNull(r.body);
        assertEquals(0, assetRequests.get());
    }

    @Test
    public void namesTheExceptionWhenTheHostIsUnreachable() throws IOException {
        int closedPort;
        try (ServerSocket s = new ServerSocket(0)) {
            closedPort = s.getLocalPort();
        }
        ReleaseFetcher.Result r = new ReleaseFetcher("http://127.0.0.1:" + closedPort + "/releases/", 2_000, NO_DELAY, null)
                .fetch("latest/download/manifest.json");
        assertEquals(502, r.status);
        assertTrue(r.error, r.error.startsWith("ConnectException"));
        assertTrue(r.error, r.error.endsWith(NetworkHints.NO_NETWORK));
    }

    @Test
    public void rejectsPathsOutsideReleaseDownloads() {
        assertEquals(404, fetcher().fetch("../../settings").status);
        assertEquals(404, fetcher().fetch("download/x/../y").status);
        assertEquals(404, fetcher().fetch("archive/refs/heads/main.zip").status);
        assertEquals(0, assetRequests.get());
    }

    private static TinyHttpServer.Response text(int status, String body) {
        return new TinyHttpServer.Response(status, body.getBytes(StandardCharsets.UTF_8));
    }

    private static String read(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }
}
