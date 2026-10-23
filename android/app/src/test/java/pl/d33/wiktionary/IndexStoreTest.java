package pl.d33.wiktionary;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.GZIPOutputStream;

import org.junit.Test;

/** Native index downloads (gunzip, size and SHA-256 checks) and byte-range reads. */
public class IndexStoreTest {
    private static byte[] data(int n) {
        byte[] b = new byte[n];
        for (int i = 0; i < n; i++) b[i] = (byte) (i * 31 + i / 7);
        return b;
    }

    private static byte[] gzip(byte[] raw) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (GZIPOutputStream gz = new GZIPOutputStream(out)) {
            gz.write(raw);
        }
        return out.toByteArray();
    }

    private static String sha256(byte[] raw) throws Exception {
        return IndexStore.hex(MessageDigest.getInstance("SHA-256").digest(raw));
    }

    @Test
    public void storesGzipVerifiesAndReadsRanges() throws Exception {
        File dir = Files.createTempDirectory("indexes").toFile();
        IndexStore store = new IndexStore(dir);
        byte[] raw = data(300_000);
        List<Long> progress = new ArrayList<>();
        store.store("de.idx", new ByteArrayInputStream(gzip(raw)), true, raw.length, sha256(raw),
                (done, total) -> progress.add(done), new AtomicBoolean());
        assertEquals(raw.length, store.size("de.idx"));
        assertEquals(raw.length, (long) progress.get(progress.size() - 1));
        byte[] part = store.read("de.idx", 1000, 50);
        byte[] expected = new byte[50];
        System.arraycopy(raw, 1000, expected, 0, 50);
        assertArrayEquals(expected, part);
        assertEquals(10, store.read("de.idx", raw.length - 10, 50).length);
        assertTrue(store.delete("de.idx"));
        assertEquals(-1, store.size("de.idx"));
    }

    @Test
    public void rejectsWrongChecksumsSizesAndNames() throws Exception {
        File dir = Files.createTempDirectory("indexes").toFile();
        IndexStore store = new IndexStore(dir);
        byte[] raw = data(1000);
        assertThrows(IOException.class, () -> store.store("x.idx", new ByteArrayInputStream(raw), false, raw.length,
                "00" + sha256(raw).substring(2), null, null));
        assertThrows(IOException.class, () -> store.store("x.idx", new ByteArrayInputStream(raw), false, 999, null, null, null));
        AtomicBoolean cancelled = new AtomicBoolean(true);
        assertThrows(IOException.class, () -> store.store("x.idx", new ByteArrayInputStream(raw), false, 0, null, null, cancelled));
        assertEquals(-1, store.size("x.idx"));
        assertEquals(0, dir.listFiles().length);
        assertFalse(IndexStore.validName("../x.idx"));
        assertFalse(IndexStore.validName("x.txt"));
        assertTrue(IndexStore.validName("gem-pro.details"));
    }

    @Test
    public void parsesRanges() {
        ByteRange r = ByteRange.parse("bytes=10-19", 100);
        assertEquals(10, r.start);
        assertEquals(10, r.length());
        assertEquals(99, ByteRange.parse("bytes=90-", 100).end);
        assertEquals(95, ByteRange.parse("bytes=-5", 100).start);
        assertEquals(99, ByteRange.parse("bytes=50-500", 100).end);
        assertNull(ByteRange.parse(null, 100));
        assertNull(ByteRange.parse("items=1-2", 100));
        assertThrows(IllegalArgumentException.class, () -> ByteRange.parse("bytes=100-", 100));
    }
}
