package com.stryx.mdp;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Coquille native de StryxMDP : affiche l'appli embarquée (dossier assets) dans une WebView.
 * Les fichiers sont servis sous https://appassets.androidplatform.net (domaine réservé par Android),
 * ce qui donne un contexte sécurisé pour WebCrypto sans jamais toucher au réseau.
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";
    private static final int REQ_OPEN_FILE = 1;
    private static final int REQ_SAVE_FILE = 2;
    private static final long CLIPBOARD_CLEAR_MS = 30_000;

    private WebView web;
    private Biometrics biometrics;
    private Updater updater;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingSave;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Protection d'écran (captures, partage d'écran, applis récentes) : activée par défaut,
        // désactivable dans les paramètres pour pouvoir streamer l'appli (Discord…).
        applySecure(getSharedPreferences("stryxmdp_ui", MODE_PRIVATE).getBoolean("secure", true));

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportZoom(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        biometrics = new Biometrics(this, (action, ok, payload) -> web.evaluateJavascript(
                "window.stryxBio && window.stryxBio(" + JSONObject.quote(action) + "," + ok + ","
                        + JSONObject.quote(payload) + ")", null));
        updater = new Updater(this, (event, payload) -> web.evaluateJavascript(
                "window.stryxUpdate && window.stryxUpdate(" + JSONObject.quote(event) + ","
                        + JSONObject.quote(payload) + ")", null));
        web.addJavascriptInterface(new Bridge(), "StryxAndroid");
        web.setWebViewClient(new LocalClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(intent, REQ_OPEN_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        // Laisse l'appli fermer d'abord la fenêtre ouverte ; sinon on quitte.
        web.evaluateJavascript("window.stryxBack ? window.stryxBack() : false", value -> {
            if (!"true".equals(value)) finish();
        });
    }

    private void applySecure(boolean secure) {
        if (secure) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (Updater.ACTION_INSTALL_STATUS.equals(intent.getAction())) updater.onInstallStatus(intent);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
        if (requestCode == REQ_OPEN_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(uri != null ? new Uri[]{uri} : null);
            fileCallback = null;
        } else if (requestCode == REQ_SAVE_FILE) {
            String content = pendingSave;
            pendingSave = null;
            if (uri == null || content == null) return;
            try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
                out.write(content.getBytes(StandardCharsets.UTF_8));
                Toast.makeText(this, "Sauvegarde enregistrée", Toast.LENGTH_SHORT).show();
            } catch (IOException | NullPointerException e) {
                Toast.makeText(this, "Échec de l'enregistrement", Toast.LENGTH_LONG).show();
            }
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }

    /** Sert les fichiers de l'appli depuis les assets ; les liens externes s'ouvrent dans le navigateur. */
    private class LocalClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!HOST.equals(url.getHost())) return blocked();
            String path = url.getPath();
            if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
            path = path.substring(1);
            if (path.contains("..")) return blocked();
            try {
                InputStream in = getAssets().open(path);
                return new WebResourceResponse(mime(path), "utf-8", in);
            } catch (IOException e) {
                WebResourceResponse r = new WebResourceResponse("text/plain", "utf-8", null);
                r.setStatusCodeAndReasonPhrase(404, "Not Found");
                return r;
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (HOST.equals(url.getHost())) return false;
            String scheme = url.getScheme();
            if ("https".equals(scheme) || "http".equals(scheme)) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException ignored) {
                    // Aucun navigateur installé.
                }
            }
            return true;
        }

        private WebResourceResponse blocked() {
            WebResourceResponse r = new WebResourceResponse("text/plain", "utf-8", null);
            r.setStatusCodeAndReasonPhrase(403, "Forbidden");
            return r;
        }

        private String mime(String path) {
            if (path.endsWith(".html")) return "text/html";
            if (path.endsWith(".js")) return "text/javascript";
            if (path.endsWith(".css")) return "text/css";
            if (path.endsWith(".png")) return "image/png";
            if (path.endsWith(".json") || path.endsWith(".webmanifest")) return "application/json";
            if (path.endsWith(".svg")) return "image/svg+xml";
            return "application/octet-stream";
        }
    }

    /** Fonctions natives appelées par l'appli web (window.StryxAndroid). */
    private class Bridge {
        @JavascriptInterface
        public void copy(String text) {
            handler.post(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = ClipData.newPlainText("Stryx Hub", text);
                // Android 13+ : le contenu copié n'apparaît pas dans l'aperçu du presse-papiers.
                PersistableBundle extras = new PersistableBundle();
                extras.putBoolean(Build.VERSION.SDK_INT >= 33 ? ClipDescription.EXTRA_IS_SENSITIVE : "android.content.extra.IS_SENSITIVE", true);
                clip.getDescription().setExtras(extras);
                cm.setPrimaryClip(clip);
                handler.postDelayed(() -> {
                    ClipData current = cm.getPrimaryClip();
                    if (current != null && current.getItemCount() > 0
                            && text.contentEquals(current.getItemAt(0).coerceToText(MainActivity.this))) {
                        if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip();
                        else cm.setPrimaryClip(ClipData.newPlainText("", ""));
                    }
                }, CLIPBOARD_CLEAR_MS);
            });
        }

        @JavascriptInterface
        public boolean screenProtected() {
            return getSharedPreferences("stryxmdp_ui", MODE_PRIVATE).getBoolean("secure", true);
        }

        @JavascriptInterface
        public void setScreenProtected(boolean secure) {
            getSharedPreferences("stryxmdp_ui", MODE_PRIVATE).edit().putBoolean("secure", secure).apply();
            handler.post(() -> applySecure(secure));
        }

        @JavascriptInterface
        public String appVersion() {
            return updater.currentVersion();
        }

        @JavascriptInterface
        public void checkUpdate(boolean manual) {
            updater.check(manual);
        }

        @JavascriptInterface
        public void installUpdate() {
            handler.post(updater::install);
        }

        @JavascriptInterface
        public String biometricStatus() {
            return biometrics.status();
        }

        @JavascriptInterface
        public boolean biometricEnabled() {
            return biometrics.isEnabled();
        }

        @JavascriptInterface
        public void biometricEnable(String masterPassword) {
            handler.post(() -> biometrics.enable(masterPassword));
        }

        @JavascriptInterface
        public void biometricUnlock() {
            handler.post(biometrics::unlock);
        }

        @JavascriptInterface
        public void biometricDisable() {
            biometrics.disable();
        }

        @JavascriptInterface
        public void saveFile(String name, String content) {
            handler.post(() -> {
                pendingSave = content;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("application/json");
                intent.putExtra(Intent.EXTRA_TITLE, name);
                try {
                    startActivityForResult(intent, REQ_SAVE_FILE);
                } catch (ActivityNotFoundException e) {
                    pendingSave = null;
                    Toast.makeText(MainActivity.this, "Impossible d'enregistrer le fichier", Toast.LENGTH_LONG).show();
                }
            });
        }
    }
}
