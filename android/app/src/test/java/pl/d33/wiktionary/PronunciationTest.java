package pl.d33.wiktionary;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PronunciationTest {
    @Test
    public void commonsUrlEscapesTheFileName() {
        assertEquals("https://commons.wikimedia.org/wiki/Special:FilePath/Zh-ni3hao3.ogg",
                Pronunciation.commonsUrl("Zh-ni3hao3.ogg"));
        assertEquals("https://commons.wikimedia.org/wiki/Special:FilePath/Cmn-n%C7%90_h%C7%8Eo.ogg",
                Pronunciation.commonsUrl("Cmn-nǐ hǎo.ogg"));
        assertEquals("https://commons.wikimedia.org/wiki/Special:FilePath/De-Haus%28e%29_%26_Hof.ogg",
                Pronunciation.commonsUrl("De-Haus(e) & Hof.ogg"));
        assertEquals("https://commons.wikimedia.org/wiki/Special:FilePath/LL-Q150_%28fra%29-a%2Bb.wav",
                Pronunciation.commonsUrl("LL-Q150 (fra)-a+b.wav"));
    }

    @Test
    public void rejectsNamesThatAreNotFileNames() {
        for (String bad : new String[] {"", "a/b.ogg", "..", "a\\b.ogg", "x\ny.ogg", null}) {
            assertFalse(String.valueOf(bad), Pronunciation.validFileName(bad));
        }
        assertThrows(IllegalArgumentException.class, () -> Pronunciation.commonsUrl("../etc/passwd"));
        assertTrue(Pronunciation.validFileName("En-us-house.ogg"));
    }

    @Test
    public void ttsTagForIndexLanguages() {
        assertEquals("zh-CN", Pronunciation.ttsTag("zh"));
        assertEquals("zh-CN", Pronunciation.ttsTag("ZH"));
        assertEquals("ja-JP", Pronunciation.ttsTag("ja"));
        assertEquals("ko-KR", Pronunciation.ttsTag("ko"));
        assertEquals("nb-NO", Pronunciation.ttsTag("no"));
        assertEquals("de", Pronunciation.ttsTag("de"));
        assertEquals("smj", Pronunciation.ttsTag("smj"));
        assertEquals("", Pronunciation.ttsTag(null));
    }

    @Test
    public void audioMimeTypesAndCacheKeys() {
        assertEquals("audio/ogg", AudioProxy.mimeType("Zh-ni3hao3.ogg"));
        assertEquals("audio/mpeg", AudioProxy.mimeType("x.MP3"));
        assertEquals("audio/wav", AudioProxy.mimeType("LL-Q150 (fra)-a.wav"));
        assertEquals(64, AudioCache.key("Zh-ni3hao3.ogg").length());
        assertFalse(AudioCache.key("a.ogg").equals(AudioCache.key("b.ogg")));
    }
}
