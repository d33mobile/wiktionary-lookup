package pl.d33.wiktionary;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.SystemClock;
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
    private volatile boolean finished;
    // "drawn" (default): the panel stays attached and laid out, transparent
    // and parked off-screen, so showing it only fades and slides it in.
    // "gone": View.GONE while hidden (0.9), kept for comparison.
    static final String PREFS = "page-panel";
    private final boolean keepDrawn;
    // The last show: uptime of the tap (bridge call), of show() on the UI
    // thread and of the panel's first drawn frame; prefetch state at the tap.
    private volatile long tapAt;
    private volatile long shownAt;
    private volatile long firstDrawAt;
    private volatile int progressAtTap = -1;
    private volatile boolean finishedAtTap;
    private boolean awaitingDraw;

    PagePanel(Activity activity, FrameLayout root) {
        this.activity = activity;
        panel = new LinearLayout(activity);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(Color.WHITE);
        keepDrawn = !"gone".equals(activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("mode", "drawn"));
        if (keepDrawn) {
            panel.setVisibility(View.VISIBLE);
            panel.setAlpha(0f);
            panel.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            panel.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
                if (!shown && v.getTranslationX() != v.getWidth()) v.setTranslationX(v.getWidth());
            });
        } else {
            panel.setVisibility(View.GONE);
        }
        panel.getViewTreeObserver().addOnDrawListener(() -> {
            if (awaitingDraw && shown) {
                awaitingDraw = false;
                firstDrawAt = SystemClock.uptimeMillis();
            }
        });

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
            public void onPageFinished(WebView v, String u) {
                finished = true;
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
        finished = false;
        loaded = 0;
        pageTitle = "";
        error.setVisibility(View.GONE);
        title.setText("");
        view.stopLoading();
        view.loadUrl(target);
    }

    void show(String target) {
        if (target.equals(url) && !failed) {
            progressAtTap = loaded;
            finishedAtTap = finished && loaded == 100;
        } else {
            progressAtTap = 0;
            finishedAtTap = false;
        }
        prefetch(target);
        if (shown) return;
        shown = true;
        shownAt = SystemClock.uptimeMillis();
        firstDrawAt = 0;
        awaitingDraw = true;
        if (keepDrawn) {
            panel.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
            panel.animate().cancel();
            if (panel.getWidth() == 0) panel.setTranslationX(activity.getWindow().getDecorView().getWidth());
            panel.setAlpha(1f);
            panel.animate().translationX(0).setDuration(SLIDE_MS).withLayer().start();
            panel.invalidate();
            return;
        }
        panel.setTranslationX(panel.getWidth() > 0 ? panel.getWidth() : activity.getWindow().getDecorView().getWidth());
        panel.setVisibility(View.VISIBLE);
        panel.animate().translationX(0).setDuration(SLIDE_MS).start();
    }

    boolean visible() {
        return shown;
    }

    void hide() {
        if (!shown) return;
        shown = false;
        if (keepDrawn) {
            panel.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            panel.animate().cancel();
            panel.animate().translationX(panel.getWidth()).setDuration(SLIDE_MS).withLayer()
                    .withEndAction(() -> {
                        if (!shown) panel.setAlpha(0f);
                    }).start();
            return;
        }
        panel.animate().translationX(panel.getWidth()).setDuration(SLIDE_MS)
                .withEndAction(() -> panel.setVisibility(View.GONE)).start();
    }

    // For the page bridge (any thread).
    void prefetchLater(String target) {
        activity.runOnUiThread(() -> prefetch(target));
    }

    void showLater(String target) {
        tapAt = SystemClock.uptimeMillis();
        activity.runOnUiThread(() -> show(target));
    }

    /** The panel's mode and the timings of its last show, for Diagnostics (any thread). */
    String diagnostics() {
        try {
            JSONObject last = new JSONObject();
            if (tapAt > 0) {
                last.put("tapToShowMs", shownAt >= tapAt ? shownAt - tapAt : -1)
                        .put("tapToFirstDrawMs", firstDrawAt >= tapAt ? firstDrawAt - tapAt : -1)
                        .put("progressAtTap", progressAtTap).put("finishedAtTap", finishedAtTap).put("url", url);
            }
            return new JSONObject().put("mode", keepDrawn ? "drawn" : "gone").put("lastShow", last)
                    .put("network", networkType()).toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    static void setMode(Context context, String mode) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("mode", "gone".equals(mode) ? "gone" : "drawn").commit();
    }

    private String networkType() {
        ConnectivityManager cm = (ConnectivityManager) activity.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return "unknown";
        NetworkCapabilities caps = cm.getNetworkCapabilities(cm.getActiveNetwork());
        if (caps == null) return "none";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "wifi";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) ? "cellular" : "cellular (metered)";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "ethernet";
        return "other";
    }

    /** {visible, url, progress, title, failed}, for the page and its tests (any thread). */
    String state() {
        try {
            return new JSONObject().put("visible", shown).put("url", url).put("progress", loaded)
                    .put("title", pageTitle).put("failed", failed).put("finished", finished).toString();
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
