package pl.d33.wiktionary;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** A parsed HTTP Range header ("bytes=a-b", "bytes=a-", "bytes=-n") for one range. */
final class ByteRange {
    private static final Pattern RANGE = Pattern.compile("bytes=(\\d*)-(\\d*)");

    final long start;
    final long end; // inclusive

    private ByteRange(long start, long end) {
        this.start = start;
        this.end = end;
    }

    long length() {
        return end - start + 1;
    }

    /** null: no usable range (serve the whole file); throws for an unsatisfiable one. */
    static ByteRange parse(String header, long size) {
        if (header == null) return null;
        Matcher m = RANGE.matcher(header.trim());
        if (!m.matches() || (m.group(1).isEmpty() && m.group(2).isEmpty())) return null;
        long start;
        long end;
        if (m.group(1).isEmpty()) {
            long suffix = Long.parseLong(m.group(2));
            start = Math.max(0, size - suffix);
            end = size - 1;
        } else {
            start = Long.parseLong(m.group(1));
            end = m.group(2).isEmpty() ? size - 1 : Math.min(Long.parseLong(m.group(2)), size - 1);
        }
        if (start >= size || end < start) throw new IllegalArgumentException("unsatisfiable range " + header);
        return new ByteRange(start, end);
    }
}
