package pl.d33.wiktionary;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;


/**
 * Single WebView showing the web app from the APK assets. WebViewAssetLoader
 * serves assets/ under https://appassets.androidplatform.net/assets/, so the
 * page is a normal https origin: ES modules load and fetch("index.idx")
 * works, which file:// URLs would block. The secure origin also gives the
 * page the Cache API, where it keeps downloaded language indexes, and
 * ReleaseProxy lets it download them from the data releases.
 */
public class MainActivity extends Activity {
    private static final String START_URL = "https://" + WebViewAssetLoader.DEFAULT_DOMAIN + "/assets/web/index.html";

    private WebView webView;
    private Speech speech;
    private PagePanel pages;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        CrashReporting.init(getApplicationContext(), BuildConfig.SENTRY_DSN, BuildConfig.VERSION_NAME);
        final AudioProxy audio = new AudioProxy(this);
        final ReleaseProxy releases = new ReleaseProxy();
        final IndexStore indexes = new IndexStore(new File(getFilesDir(), "indexes"));
        final LocalFiles localFiles = new LocalFiles(indexes);
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler(ReleaseProxy.PREFIX, releases)
                .addPathHandler(AudioProxy.PREFIX, audio)
                .build();
        // Debug builds expose the page to chrome://inspect (and to the
        // emulator tests, which drive it over the DevTools protocol).
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        // localStorage holds the installed languages and the active one.
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        speech = new Speech(getApplicationContext());
        FrameLayout root = new FrameLayout(this);
        // Keep the page and the panel clear of the status and navigation
        // bars (with targetSdk 35+ the window would otherwise extend below
        // them, and the end of a long page could not be tapped).
        root.setFitsSystemWindows(true);
        root.addView(webView);
        pages = new PagePanel(this, root);
        webView.addJavascriptInterface(new PageBridge(getApplicationContext(), speech, audio, indexes,
                releases.fetcher(), script -> webView.post(() -> webView.evaluateJavascript(script, null)),
                () -> runOnUiThread(this::pickTextFile), pages),
                PageBridge.NAME);
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                // Uncaught errors also reach window.onerror, which reports them
                // through PageBridge with the stack position; skip them here.
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR
                        && !message.message().startsWith("Uncaught")) {
                    Log.w("WebConsole", message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
                    CrashReporting.jsError(message.message(), message.sourceId(), message.lineNumber());
                }
                return false;
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            // Links out of the app (e.g. "Open on Wiktionary") open in the browser.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (WebViewAssetLoader.DEFAULT_DOMAIN.equals(uri.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException e) {
                    Log.w("MainActivity", "no app for " + uri);
                }
                return true;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // Index files with Range support; path handlers cannot see headers.
                Uri u = request.getUrl();
                String path = u.getPath();
                if (WebViewAssetLoader.DEFAULT_DOMAIN.equals(u.getHost()) && path != null
                        && path.startsWith(LocalFiles.PREFIX)) {
                    return localFiles.handle(path.substring(LocalFiles.PREFIX.length()), u.getQueryParameter("offset"),
                            u.getQueryParameter("length"), request.getRequestHeaders().get("Range"));
                }
                return loader.shouldInterceptRequest(request.getUrl());
            }
        });
        setContentView(root);
        if (savedInstanceState == null) {
            webView.loadUrl(START_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private static final int PICK_TEXT = 1;
    private static final int MAX_PICKED_BYTES = 5 * 1024 * 1024;

    private void pickTextFile() {
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType("*/*");
        pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {"application/json", "text/plain", "application/octet-stream"});
        try {
            startActivityForResult(pick, PICK_TEXT);
        } catch (ActivityNotFoundException e) {
            Log.w("MainActivity", "no file picker");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_TEXT || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        try (InputStream in = getContentResolver().openInputStream(data.getData())) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            for (int n; in != null && (n = in.read(buf)) > 0; ) {
                out.write(buf, 0, n);
                if (out.size() > MAX_PICKED_BYTES) throw new IOException("file too large");
            }
            String text = new String(out.toByteArray(), StandardCharsets.UTF_8);
            webView.evaluateJavascript("window.onPickedText && window.onPickedText(" + JSONObject.quote(text) + ")", null);
        } catch (IOException e) {
            Log.w("MainActivity", "cannot read the picked file: " + e.getMessage());
        }
    }

    // The page pushes a history entry when it opens a detail view; Back pops
    // it before it closes the app.
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (pages.visible()) {
            pages.hide();
        } else if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (speech != null) speech.shutdown();
        if (pages != null) pages.destroy();
        webView.destroy();
        super.onDestroy();
    }
}
