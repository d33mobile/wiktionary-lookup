package pl.d33.wiktionary;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.function.LongSupplier;

/**
 * Pronunciation files on disk, one per Commons file name (SHA-256 of the
 * name), with a total size cap: after every store the least recently used
 * files (by modification time, which a hit refreshes) are deleted until the
 * cache fits. Plain Java, unit tested on the JVM.
 */
final class AudioCache {
    private static final String TMP = ".tmp";

    private final File dir;
    private final long maxBytes;
    private final LongSupplier clock;

    AudioCache(File dir, long maxBytes, LongSupplier clock) {
        this.dir = dir;
        this.maxBytes = maxBytes;
        this.clock = clock;
    }

    File file(String name) {
        return new File(dir, key(name));
    }

    boolean contains(String name) {
        return file(name).isFile();
    }

    /** The cached file, marked as just used; null when it is not cached. */
    File hit(String name) {
        File f = file(name);
        if (!f.isFile()) return null;
        // Best effort: some file systems refuse; the file then just ages normally.
        f.setLastModified(clock.getAsLong());
        return f;
    }

    /** Copies `in` into the cache (at most maxFileBytes), then trims the cache. */
    File store(String name, InputStream in, long maxFileBytes) throws IOException {
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        File target = file(name);
        File tmp = new File(dir, target.getName() + "." + Thread.currentThread().getId() + TMP);
        long total = 0;
        try (InputStream src = in; OutputStream out = new FileOutputStream(tmp)) {
            byte[] buf = new byte[16384];
            for (int n; (n = src.read(buf)) > 0; ) {
                total += n;
                if (total > maxFileBytes) throw new IOException("audio file larger than " + maxFileBytes + " bytes");
                out.write(buf, 0, n);
            }
        } catch (IOException e) {
            tmp.delete();
            throw e;
        }
        if (!tmp.renameTo(target)) {
            tmp.delete();
            throw new IOException("cannot store " + target);
        }
        target.setLastModified(clock.getAsLong());
        trim();
        return target;
    }

    synchronized long size() {
        long total = 0;
        for (File f : entries()) total += f.length();
        return total;
    }

    /** Deletes least recently used files until the cache is within maxBytes. */
    synchronized void trim() {
        List<File> files = entries();
        long total = 0;
        for (File f : files) total += f.length();
        files.sort((a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (File f : files) {
            if (total <= maxBytes) break;
            long len = f.length();
            if (f.delete()) total -= len;
        }
    }

    private List<File> entries() {
        File[] all = dir.listFiles((d, n) -> !n.endsWith(TMP));
        return all == null ? new ArrayList<>() : new ArrayList<>(Arrays.asList(all));
    }

    static String key(String name) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(name.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : digest) hex.append(String.format(Locale.ROOT, "%02x", b));
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new AssertionError(e);
        }
    }
}
