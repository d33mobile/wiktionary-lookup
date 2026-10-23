package pl.d33.wiktionary;

import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Serves the index files of IndexStore at https://appassets.androidplatform.net/local/<name>:
 * the whole file, or with ?offset=N&length=M those bytes (200). The page
 * reads an index by byte range this way without copies through the bridge.
 * (An HTTP Range request works too, but WebView slices an intercepted 206
 * response again by its Content-Range, so the page uses the query form.)
 * MainActivity routes these requests here because WebViewAssetLoader path
 * handlers do not see the query or headers.
 */
final class LocalFiles {
    static final String PREFIX = "/local/";

    private final IndexStore store;

    LocalFiles(IndexStore store) {
        this.store = store;
    }

    WebResourceResponse handle(String name, String offset, String length, String rangeHeader) {
        if (offset != null && length != null) {
            if (!IndexStore.validName(name)) return text(404, "Not Found", "bad name");
            try {
                byte[] bytes = store.read(name, Long.parseLong(offset), Integer.parseInt(length));
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-store");
                return new WebResourceResponse("application/octet-stream", null, 200, "OK", headers, new ByteArrayInputStream(bytes));
            } catch (IOException | IllegalArgumentException e) {
                return text(416, "Range Not Satisfiable", String.valueOf(e.getMessage()));
            }
        }
        return handle(name, rangeHeader);
    }

    WebResourceResponse handle(String name, String rangeHeader) {
        if (!IndexStore.validName(name)) return text(404, "Not Found", "bad name");
        File f = store.file(name);
        if (!f.isFile()) return text(404, "Not Found", "no such file");
        long size = f.length();
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("Accept-Ranges", "bytes");
        try {
            ByteRange range = ByteRange.parse(rangeHeader, size);
            InputStream in = new FileInputStream(f);
            if (range == null) return new WebResourceResponse("application/octet-stream", null, 200, "OK", headers, in);
            long skipped = 0;
            while (skipped < range.start) {
                long n = in.skip(range.start - skipped);
                if (n <= 0) throw new IOException("cannot seek");
                skipped += n;
            }
            headers.put("Content-Range", "bytes " + range.start + "-" + range.end + "/" + size);
            return new WebResourceResponse("application/octet-stream", null, 206, "Partial Content", headers,
                    new Limited(in, range.length()));
        } catch (IllegalArgumentException e) {
            headers.put("Content-Range", "bytes */" + size);
            return new WebResourceResponse("text/plain", "utf-8", 416, "Range Not Satisfiable", headers,
                    new ByteArrayInputStream(new byte[0]));
        } catch (IOException e) {
            return text(500, "Internal Server Error", e.getMessage());
        }
    }

    private static WebResourceResponse text(int status, String reason, String body) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", status, reason, headers,
                new ByteArrayInputStream(String.valueOf(body).getBytes(StandardCharsets.UTF_8)));
    }

    /** At most `left` bytes of the wrapped stream. */
    static final class Limited extends FilterInputStream {
        private long left;

        Limited(InputStream in, long left) {
            super(in);
            this.left = left;
        }

        @Override
        public int read() throws IOException {
            if (left <= 0) return -1;
            int b = super.read();
            if (b >= 0) left--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }
    }
}
