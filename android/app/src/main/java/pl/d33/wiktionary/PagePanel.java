package pl.d33.wiktionary;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The Wiktionary (or Wikipedia) page of an entry inside the app: a second
 * WebView in a panel that slides over the page. prefetch() loads a page
 * while it is hidden, so show() is instant; one page at a time (a new
 * prefetch replaces the previous load). The page is shown as the site
 * serves it; nothing is injected. Links to other sites open in the browser.
 */
final class PagePanel {
    private static final int SLIDE_MS = 180;

    private final Activity activity;
    private final LinearLayout panel;
    private final WebView view;
    private final ProgressBar progress;
    private final TextView title;
    private final TextView error;
    // Read by state() from the bridge thread; written on the UI thread.
    private volatile String url = "";
    private volatile boolean failed;
    private volatile int loaded;
    private volatile String pageTitle = "";
    private volatile boolean shown;

    PagePanel(Activity activity, FrameLayout root) {
        this.activity = activity;
        panel = new LinearLayout(activity);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(Color.WHITE);
        panel.setVisibility(View.GONE);

        LinearLayout bar = new LinearLayout(activity);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int pad = dp(8);
        bar.setPadding(pad, pad, pad, pad);
        Button close = new Button(activity);
        close.setText("Back");
        close.setOnClickListener(v -> hide());
        title = new TextView(activity);
        title.setSingleLine(true);
        title.setPadding(pad, 0, pad, 0);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        Button browser = new Button(activity);
        browser.setText("Open in browser");
        browser.setOnClickListener(v -> openInBrowser());
        bar.addView(close);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        bar.addView(browser);
        panel.addView(bar);

        progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        panel.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(4)));

        error = new TextView(activity);
        error.setPadding(dp(16), dp(16), dp(16), dp(16));
        error.setText("Cannot load the page. Check the network, or use Open in browser.");
        error.setVisibility(View.GONE);
        panel.addView(error);

        view = new WebView(activity);
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int p) {
                loaded = p;
                progress.setProgress(p);
                progress.setVisibility(p < 100 ? View.VISIBLE : View.GONE);
            }

            @Override
            public void onReceivedTitle(WebView v, String t) {
                pageTitle = t == null ? "" : t;
                title.setText(t);
            }
        });
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                String host = request.getUrl().getHost();
                if (host != null && (host.endsWith("wiktionary.org") || host.endsWith("wikipedia.org")
                        || host.endsWith("wikimedia.org"))) {
                    return false;
                }
                openExternal(request.getUrl());
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError err) {
                if (request.isForMainFrame()) {
                    failed = true;
                    error.setVisibility(View.VISIBLE);
                }
            }
        });
        panel.addView(view, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        root.addView(panel, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, activity.getResources().getDisplayMetrics());
    }

    /** Loads `target` in the hidden panel unless it is the page already there. */
    void prefetch(String target) {
        if (target.equals(url) && !failed) return;
        url = target;
        failed = false;
        loaded = 0;
        pageTitle = "";
        error.setVisibility(View.GONE);
        title.setText("");
        view.stopLoading();
        view.loadUrl(target);
    }

    void show(String target) {
        prefetch(target);
        shown = true;
        if (panel.getVisibility() == View.VISIBLE) return;
        panel.setTranslationX(panel.getWidth() > 0 ? panel.getWidth() : activity.getWindow().getDecorView().getWidth());
        panel.setVisibility(View.VISIBLE);
        panel.animate().translationX(0).setDuration(SLIDE_MS).start();
    }

    boolean visible() {
        return panel.getVisibility() == View.VISIBLE;
    }

    void hide() {
        shown = false;
        if (!visible()) return;
        panel.animate().translationX(panel.getWidth()).setDuration(SLIDE_MS)
                .withEndAction(() -> panel.setVisibility(View.GONE)).start();
    }

    // For the page bridge (any thread).
    void prefetchLater(String target) {
        activity.runOnUiThread(() -> prefetch(target));
    }

    void showLater(String target) {
        activity.runOnUiThread(() -> show(target));
    }

    /** {visible, url, progress, title, failed}, for the page and its tests (any thread). */
    String state() {
        try {
            return new JSONObject().put("visible", shown).put("url", url).put("progress", loaded)
                    .put("title", pageTitle).put("failed", failed).toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    private void openInBrowser() {
        if (!url.isEmpty()) openExternal(Uri.parse(url));
    }

    private void openExternal(Uri uri) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            error.setText("No browser to open " + uri);
            error.setVisibility(View.VISIBLE);
        }
    }

    void destroy() {
        view.destroy();
    }
}
