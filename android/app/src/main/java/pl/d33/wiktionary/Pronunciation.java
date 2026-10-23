package pl.d33.wiktionary;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Pure helpers for pronunciation (unit tested on the JVM): the Commons URL of
 * a Wiktionary audio file and the text-to-speech locale of an index language.
 */
final class Pronunciation {
    static final String COMMONS_FILE_PATH = "https://commons.wikimedia.org/wiki/Special:FilePath/";
    // A Commons file name: no path separators or control characters.
    private static final Pattern FILE_NAME = Pattern.compile("[^/\\\\\\p{Cntrl}]{1,240}");
    // Index language code (Wiktionary / kaikki.org) -> BCP 47 tag for TextToSpeech
    // where the bare code does not pick the expected voice.
    private static final Map<String, String> TTS_TAGS = new HashMap<>();

    static {
        TTS_TAGS.put("zh", "zh-CN");
        TTS_TAGS.put("cmn", "zh-CN");
        TTS_TAGS.put("yue", "zh-HK");
        TTS_TAGS.put("ja", "ja-JP");
        TTS_TAGS.put("ko", "ko-KR");
        TTS_TAGS.put("nb", "nb-NO");
        TTS_TAGS.put("no", "nb-NO");
        TTS_TAGS.put("fil", "fil-PH");
        TTS_TAGS.put("tl", "fil-PH");
        TTS_TAGS.put("he", "he-IL");
        TTS_TAGS.put("id", "id-ID");
    }

    private Pronunciation() {
    }

    static boolean validFileName(String name) {
        return name != null && FILE_NAME.matcher(name).matches() && !name.equals(".") && !name.equals("..");
    }

    /** https://commons.wikimedia.org/wiki/Special:FilePath/<name>, spaces as underscores, UTF-8 escaped. */
    static String commonsUrl(String name) {
        if (!validFileName(name)) throw new IllegalArgumentException("not a Commons file name: " + name);
        try {
            String escaped = URLEncoder.encode(name.trim().replace(' ', '_'), "UTF-8").replace("+", "%20");
            return COMMONS_FILE_PATH + escaped;
        } catch (UnsupportedEncodingException e) {
            throw new AssertionError(e);
        }
    }

    /** BCP 47 tag of the TextToSpeech voice for an index language code. */
    static String ttsTag(String languageCode) {
        String code = languageCode == null ? "" : languageCode.trim().toLowerCase(Locale.ROOT);
        String tag = TTS_TAGS.get(code);
        return tag != null ? tag : code;
    }
}
