package pl.d33.wiktionary;

import android.content.Context;

import io.sentry.Breadcrumb;
import io.sentry.Sentry;
import io.sentry.SentryLevel;
import io.sentry.android.core.SentryAndroid;

/**
 * Optional crash reporting through Sentry. The DSN comes from the build
 * (BuildConfig.SENTRY_DSN, see app/build.gradle); when it is empty nothing is
 * initialised and nothing is sent, which is how builds without a DSN ship.
 * Every other method is a no-op while Sentry is disabled.
 */
final class CrashReporting {
    static final String ENVIRONMENT = "fdroid";

    private CrashReporting() {
    }

    static boolean configured(String dsn) {
        return dsn != null && !dsn.trim().isEmpty();
    }

    /** Returns whether Sentry was started. */
    static boolean init(Context context, String dsn, String release) {
        if (!configured(dsn)) return false;
        SentryAndroid.init(context, options -> {
            options.setDsn(dsn.trim());
            options.setRelease(release);
            options.setEnvironment(ENVIRONMENT);
            options.setSendDefaultPii(false);
            options.setAnrEnabled(true);
            options.setEnableAutoActivityLifecycleTracing(false);
            options.setEnableUserInteractionBreadcrumbs(true);
        });
        return Sentry.isEnabled();
    }

    static void breadcrumb(String category, String message) {
        if (!Sentry.isEnabled()) return;
        Breadcrumb crumb = new Breadcrumb();
        crumb.setCategory(category);
        crumb.setMessage(message);
        Sentry.addBreadcrumb(crumb);
    }

    static void download(String path, int status, String error) {
        if (!Sentry.isEnabled()) return;
        Breadcrumb crumb = Breadcrumb.http(ReleaseProxy.RELEASES + path, "GET", status);
        crumb.setCategory("download");
        if (error != null) {
            crumb.setLevel(SentryLevel.WARNING);
            crumb.setData("error", error);
        }
        Sentry.addBreadcrumb(crumb);
    }

    /** A JavaScript error from the page (window.onerror or console.error). */
    static void jsError(String message, String source, int line) {
        if (!Sentry.isEnabled()) return;
        Sentry.captureMessage("JS: " + message + " (" + source + ":" + line + ")", SentryLevel.ERROR);
    }
}
