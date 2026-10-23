package pl.d33.wiktionary;

import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;

/**
 * Turns network exceptions into messages for the page. Errors that mean the
 * app has no network at all (a per-app network toggle switched off, as
 * LineageOS offers, or a data saver restriction) get a hint where to look,
 * since the system shows nothing in that case.
 */
final class NetworkHints {
    static final String NO_NETWORK = "No network for this app. Check the system settings: App info > Network access"
            + " (LineageOS) or data saver / background data restrictions.";

    private NetworkHints() {
    }

    static boolean meansNoNetwork(Throwable e) {
        if (e instanceof UnknownHostException || e instanceof ConnectException || e instanceof SocketTimeoutException) {
            return true;
        }
        String message = e.getMessage();
        return message != null && message.contains("Network is unreachable");
    }

    /** "ExceptionClass: message (host)", plus the hint when it applies. */
    static String describe(Throwable e, String host) {
        String text = e.getClass().getSimpleName() + ": " + e.getMessage() + " (" + host + ")";
        return meansNoNetwork(e) ? text + ". " + NO_NETWORK : text;
    }
}
