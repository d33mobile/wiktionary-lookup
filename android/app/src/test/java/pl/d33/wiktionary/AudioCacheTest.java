package pl.d33.wiktionary;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.concurrent.atomic.AtomicLong;

import org.junit.Test;

/** The size cap evicts the least recently used files; a hit counts as a use. */
public class AudioCacheTest {
    private static final int FILE_BYTES = 400;
    private final AtomicLong now = new AtomicLong(1_700_000_000_000L);

    private AudioCache cache(File dir, long maxBytes) {
        // A clock that moves 10 s per call, so modification times always differ.
        return new AudioCache(dir, maxBytes, () -> now.addAndGet(10_000));
    }

    private static ByteArrayInputStream bytes(int n) {
        return new ByteArrayInputStream(new byte[n]);
    }

    @Test
    public void evictsTheLeastRecentlyUsedFiles() throws IOException {
        File dir = Files.createTempDirectory("audio-cache").toFile();
        AudioCache c = cache(dir, 1_000);
        c.store("a.ogg", bytes(FILE_BYTES), 10_000);
        c.store("b.ogg", bytes(FILE_BYTES), 10_000);
        assertNotNull(c.hit("a.ogg")); // a is now more recent than b
        c.store("c.ogg", bytes(FILE_BYTES), 10_000); // 1200 bytes > 1000: drop b
        assertTrue(c.contains("a.ogg"));
        assertFalse(c.contains("b.ogg"));
        assertTrue(c.contains("c.ogg"));
        assertEquals(800, c.size());
        assertNull(c.hit("b.ogg"));
    }

    @Test
    public void keepsEverythingUnderTheCap() throws IOException {
        File dir = Files.createTempDirectory("audio-cache").toFile();
        AudioCache c = cache(dir, 50L * 1024 * 1024);
        for (int i = 0; i < 20; i++) c.store("f" + i + ".ogg", bytes(FILE_BYTES), 10_000);
        assertEquals(20L * FILE_BYTES, c.size());
    }

    @Test
    public void refusesOversizedFilesAndLeavesNoTemporaryFile() throws IOException {
        File dir = Files.createTempDirectory("audio-cache").toFile();
        AudioCache c = cache(dir, 1_000_000);
        assertThrows(IOException.class, () -> c.store("big.ogg", bytes(5_000), 4_096));
        assertFalse(c.contains("big.ogg"));
        assertEquals(0, dir.listFiles().length);
    }
}
