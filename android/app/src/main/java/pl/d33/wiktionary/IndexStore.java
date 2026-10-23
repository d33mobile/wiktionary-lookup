package pl.d33.wiktionary;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;

/**
 * Language index files (<code>.idx, <code>.details) and data files such as
 * hanzi.pack (character data) kept as plain files in
 * the app's storage, downloaded and unpacked natively, so that a large index
 * never passes through JavaScript memory as a whole and can be read by byte
 * range. Plain Java, unit tested on the JVM.
 */
final class IndexStore {
    static final Pattern NAME = Pattern.compile("[a-z0-9][a-z0-9-]{0,40}\\.(idx|details|pack)");
    private static final int BUFFER = 64 * 1024;

    interface Progress {
        void update(long done, long total);
    }

    private final File dir;

    IndexStore(File dir) {
        this.dir = dir;
    }

    static boolean validName(String name) {
        return name != null && NAME.matcher(name).matches();
    }

    File file(String name) {
        if (!validName(name)) throw new IllegalArgumentException("bad index file name: " + name);
        return new File(dir, name);
    }

    long size(String name) {
        File f = file(name);
        return f.isFile() ? f.length() : -1;
    }

    boolean delete(String name) {
        return file(name).delete();
    }

    /**
     * Writes `in` (gzip when `gzipped`) to <name>, checking the unpacked size and
     * SHA-256 when given; progress counts unpacked bytes. The file appears only
     * when complete and verified.
     */
    File store(String name, InputStream in, boolean gzipped, long expectedBytes, String sha256, Progress progress,
               AtomicBoolean cancelled) throws IOException {
        if (!dir.mkdirs() && !dir.isDirectory()) throw new IOException("cannot create " + dir);
        File target = file(name);
        File tmp = new File(dir, name + ".part");
        MessageDigest digest = sha256Digest();
        long done = 0;
        try (InputStream src = gzipped ? new GZIPInputStream(in, BUFFER) : in;
             OutputStream out = new FileOutputStream(tmp)) {
            byte[] buf = new byte[BUFFER];
            for (int n; (n = src.read(buf)) > 0; ) {
                if (cancelled != null && cancelled.get()) throw new IOException("cancelled");
                out.write(buf, 0, n);
                digest.update(buf, 0, n);
                done += n;
                if (progress != null) progress.update(done, expectedBytes);
            }
        } catch (IOException e) {
            tmp.delete();
            throw e;
        }
        if (expectedBytes > 0 && done != expectedBytes) {
            tmp.delete();
            throw new IOException(name + ": got " + done + " bytes, expected " + expectedBytes);
        }
        if (sha256 != null && !sha256.isEmpty() && !hex(digest.digest()).equals(sha256.toLowerCase(Locale.ROOT))) {
            tmp.delete();
            throw new IOException(name + ": checksum mismatch");
        }
        if (target.exists() && !target.delete()) throw new IOException("cannot replace " + target);
        if (!tmp.renameTo(target)) throw new IOException("cannot store " + target);
        return target;
    }

    /** Up to `length` bytes of <name> from `offset` (fewer at the end of the file). */
    byte[] read(String name, long offset, int length) throws IOException {
        try (RandomAccessFile f = new RandomAccessFile(file(name), "r")) {
            long size = f.length();
            if (offset < 0 || offset > size || length < 0) throw new IOException("bad range " + offset + "+" + length);
            int n = (int) Math.min(length, size - offset);
            byte[] out = new byte[n];
            f.seek(offset);
            f.readFully(out);
            return out;
        }
    }

    private static MessageDigest sha256Digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new AssertionError(e);
        }
    }

    static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format(Locale.ROOT, "%02x", b));
        return sb.toString();
    }
}
