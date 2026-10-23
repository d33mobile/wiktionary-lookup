package pl.d33.wiktionary;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import io.sentry.Sentry;

import org.junit.Test;

/** Without a DSN, Sentry must stay off: no init, no events. */
public class CrashReportingTest {
    @Test
    public void emptyDsnLeavesSentryDisabled() {
        assertFalse(CrashReporting.configured(""));
        assertFalse(CrashReporting.configured("   "));
        assertFalse(CrashReporting.configured(null));
        // The Context is never touched when there is no DSN.
        assertFalse(CrashReporting.init(null, "", "0.3"));
        assertFalse(Sentry.isEnabled());
        CrashReporting.jsError("boom", "app.js", 1);
        CrashReporting.download("latest/download/manifest.json", 502, "x");
        assertFalse(Sentry.isEnabled());
    }

    @Test
    public void buildConfigDsnMatchesTheBuild() {
        // Unit tests run without SENTRY_DSN set, like the F-Droid build.
        String expected = System.getenv("SENTRY_DSN") == null ? "" : System.getenv("SENTRY_DSN");
        if (expected.isEmpty()) assertEquals("", BuildConfig.SENTRY_DSN);
        assertTrue(CrashReporting.configured(BuildConfig.SENTRY_DSN) == !BuildConfig.SENTRY_DSN.trim().isEmpty());
    }
}
