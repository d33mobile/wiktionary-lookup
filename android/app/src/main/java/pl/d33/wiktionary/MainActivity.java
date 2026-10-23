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

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        CrashReporting.init(getApplicationContext(), BuildConfig.SENTRY_DSN, BuildConfig.VERSION_NAME);
        final AudioProxy audio = new AudioProxy(this);
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler(ReleaseProxy.PREFIX, new ReleaseProxy())
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
        webView.addJavascriptInterface(new PageBridge(getApplicationContext(), speech, audio,
                name -> webView.post(() -> webView.evaluateJavascript(
                        "window.onAudioCached && window.onAudioCached(" + JSONObject.quote(name) + ")", null))),
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
                return loader.shouldInterceptRequest(request.getUrl());
            }
        });
        setContentView(webView);
        if (savedInstanceState == null) {
            webView.loadUrl(START_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    // The page pushes a history entry when it opens a detail view; Back pops
    // it before it closes the app.
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView.canGoBack()) {
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
        webView.destroy();
        super.onDestroy();
    }
}
