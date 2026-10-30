package com.stryx.bkplanning;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * Coquille native de Planning BK : affiche l'appli embarquée (dossier assets) dans une WebView,
 * servie sous https://appassets.androidplatform.net (domaine réservé par Android, contexte sécurisé
 * pour WebCrypto). La page n'a aucun accès direct au réseau : tout passe par ce pont, limité
 * au dépôt de données du planning et aux mises à jour.
 */
public class MainActivity extends Activity {

    static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";
    static final int REQ_CAMERA = 11;
    static final int REQ_GALLERY = 12;
    static final int REQ_AUTH = 13;

    private WebView web;
    private Updater updater;
    private PhotoReader photos;
    private GitHubApi github;
    private AppLock lock;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#F5EBDC"));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setMediaPlaybackRequiresUserGesture(true);

        updater = new Updater(this, (event, payload) -> js("bkUpdate", JSONObject.quote(event), JSONObject.quote(payload)));
        photos = new PhotoReader(this, (event, payload) -> js("bkPhoto", JSONObject.quote(event), JSONObject.quote(payload)));
        github = new GitHubApi((id, status, text) -> js("bkGithub", JSONObject.quote(id), String.valueOf(status), JSONObject.quote(text)));
        lock = new AppLock(this, (ok, msg) -> js("bkAuth", String.valueOf(ok), JSONObject.quote(msg)));

        web.addJavascriptInterface(new Bridge(), "BKAndroid");
        web.setWebViewClient(new LocalClient());
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    /** Appelle window.<fn>(args…) dans la page, si la fonction existe. */
    private void js(String fn, String... args) {
        String call = "window." + fn + " && window." + fn + "(" + String.join(",", args) + ")";
        handler.post(() -> web.evaluateJavascript(call, null));
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        js("bkPause");
    }

    @Override
    protected void onResume() {
        super.onResume();
        js("bkResume");
    }

    @Override
    public void onBackPressed() {
        // Laisse l'appli fermer d'abord la fenêtre ouverte ; sinon on quitte.
        web.evaluateJavascript("window.bkBack ? window.bkBack() : false", value -> {
            if (!"true".equals(value)) finish();
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (Updater.ACTION_INSTALL_STATUS.equals(intent.getAction())) updater.onInstallStatus(intent);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_CAMERA || requestCode == REQ_GALLERY) photos.onResult(requestCode, resultCode, data);
        else if (requestCode == REQ_AUTH) lock.onResult(resultCode);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }

    /** Sert les fichiers de l'appli (assets) et les photos lues (/photo/…, dossier cache). */
    private class LocalClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!HOST.equals(url.getHost()) || !"https".equals(url.getScheme())) return status(403, "Forbidden");
            String path = url.getPath();
            if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
            if (path.contains("..")) return status(403, "Forbidden");
            try {
                if (path.startsWith("/photo/")) {
                    String name = path.substring("/photo/".length());
                    if (!name.matches("[A-Za-z0-9_-]+\\.jpg")) return status(404, "Not Found");
                    File f = new File(PhotoReader.previewDir(MainActivity.this), name);
                    return new WebResourceResponse("image/jpeg", null, new FileInputStream(f));
                }
                InputStream in = getAssets().open(path.substring(1));
                return new WebResourceResponse(mime(path), "utf-8", in);
            } catch (IOException e) {
                return status(404, "Not Found");
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (HOST.equals(url.getHost())) return false;
            if ("https".equals(url.getScheme())) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException ignored) {
                    // Aucun navigateur.
                }
            }
            return true;
        }

        private WebResourceResponse status(int code, String reason) {
            WebResourceResponse r = new WebResourceResponse("text/plain", "utf-8", null);
            r.setStatusCodeAndReasonPhrase(code, reason);
            return r;
        }

        private String mime(String path) {
            if (path.endsWith(".html")) return "text/html";
            if (path.endsWith(".js")) return "text/javascript";
            if (path.endsWith(".css")) return "text/css";
            if (path.endsWith(".svg")) return "image/svg+xml";
            if (path.endsWith(".png")) return "image/png";
            if (path.endsWith(".json")) return "application/json";
            return "application/octet-stream";
        }
    }

    /** Fonctions natives appelées par l'appli web (window.BKAndroid). */
    private class Bridge {
        @JavascriptInterface
        public void github(String id, String method, String path, String token, String body) {
            github.request(id, method, path, token, body);
        }

        @JavascriptInterface
        public void pickPhotos(boolean camera) {
            handler.post(() -> photos.pick(camera));
        }

        @JavascriptInterface
        public void copyText(String text) {
            handler.post(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("Planning BK", text));
            });
        }

        @JavascriptInterface
        public void shareText(String text) {
            handler.post(() -> {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("text/plain");
                send.putExtra(Intent.EXTRA_TEXT, text);
                try {
                    startActivity(Intent.createChooser(send, "Envoyer le code"));
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(MainActivity.this, "Aucune appli pour partager", Toast.LENGTH_LONG).show();
                }
            });
        }

        @JavascriptInterface
        public void setBars(String color) {
            handler.post(() -> {
                try {
                    int c = Color.parseColor(color);
                    getWindow().setStatusBarColor(c);
                    getWindow().setNavigationBarColor(c);
                } catch (IllegalArgumentException ignored) {
                    // Couleur invalide : on garde la précédente.
                }
            });
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
        public String authStatus() {
            return lock.status();
        }

        @JavascriptInterface
        public void authenticate(String title) {
            handler.post(() -> lock.authenticate(title));
        }
    }
}
