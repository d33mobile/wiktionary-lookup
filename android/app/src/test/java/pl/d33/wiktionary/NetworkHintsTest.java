package pl.d33.wiktionary;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;

import javax.net.ssl.SSLHandshakeException;

import org.junit.Test;

/** Which network errors get the "no network for this app" hint. */
public class NetworkHintsTest {
    @Test
    public void noNetworkErrorsGetTheHint() {
        Throwable[] noNetwork = {
            new UnknownHostException("Unable to resolve host \"github.com\": No address associated with hostname"),
            new ConnectException("failed to connect to github.com/140.82.121.4 (port 443)"),
            new SocketTimeoutException("timeout"),
            new SocketException("Network is unreachable"),
        };
        for (Throwable e : noNetwork) {
            assertTrue(e.toString(), NetworkHints.meansNoNetwork(e));
            String text = NetworkHints.describe(e, "github.com");
            assertTrue(text, text.startsWith(e.getClass().getSimpleName() + ": "));
            assertTrue(text, text.endsWith("(github.com). " + NetworkHints.NO_NETWORK));
        }
    }

    @Test
    public void otherErrorsKeepTheirMessageOnly() {
        Throwable[] others = {new SSLHandshakeException("certificate expired"), new IOException("unexpected end of stream"),
            new SocketException("Connection reset")};
        for (Throwable e : others) {
            assertFalse(e.toString(), NetworkHints.meansNoNetwork(e));
            assertEquals(e.getClass().getSimpleName() + ": " + e.getMessage() + " (github.com)", NetworkHints.describe(e, "github.com"));
        }
    }
}
