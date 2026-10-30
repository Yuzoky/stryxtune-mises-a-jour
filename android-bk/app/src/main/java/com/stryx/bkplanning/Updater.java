package com.stryx.bkplanning;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Mise à jour depuis l'application : compare la version installée à celle publiée sur GitHub,
 * télécharge le nouvel APK et le confie à l'installeur d'Android. Android n'accepte la mise à
 * jour que si l'APK est signé avec la même clé que l'appli installée.
 */
final class Updater {

    interface Callback {
        void result(String event, String payload);
    }

    static final String ACTION_INSTALL_STATUS = "com.stryx.bkplanning.INSTALL_STATUS";
    private static final String BASE = "https://github.com/Yuzoky/stryxtune-mises-a-jour/releases/download/bkplanning/";

    private final Activity activity;
    private final Callback callback;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean busy;

    Updater(Activity activity, Callback callback) {
        this.activity = activity;
        this.callback = callback;
    }

    String currentVersion() {
        return info().versionName;
    }

    @SuppressWarnings("deprecation")
    private long currentCode() {
        PackageInfo p = info();
        return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
    }

    private PackageInfo info() {
        try {
            return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** Vérifie en arrière-plan ; répond « available » (version), « none » ou « error ». */
    void check(boolean manual) {
        new Thread(() -> {
            try {
                long remote = Long.parseLong(readText(BASE + "version.txt").trim());
                if (remote > currentCode()) post("available", "1.0." + remote);
                else post("none", currentVersion());
            } catch (Exception e) {
                if (manual) post("error", "Impossible de vérifier les mises à jour (connexion ?).");
            }
        }, "bk-update-check").start();
    }

    void install() {
        if (busy) return;
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            // Autorisation unique : « Installer des applis inconnues » pour Planning BK.
            post("permission", "");
            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName())));
            return;
        }
        busy = true;
        new Thread(this::downloadAndInstall, "bk-update").start();
    }

    private void downloadAndInstall() {
        PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
        int sessionId = -1;
        try {
            PackageInstaller.SessionParams params =
                    new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(activity.getPackageName());
            sessionId = installer.createSession(params);
            try (PackageInstaller.Session session = installer.openSession(sessionId)) {
                HttpURLConnection conn = open(BASE + "PlanningBK.apk");
                long total = conn.getContentLengthLong();
                try (InputStream in = conn.getInputStream();
                     OutputStream out = session.openWrite("PlanningBK.apk", 0, total)) {
                    byte[] buf = new byte[64 * 1024];
                    long done = 0;
                    int lastPct = -1;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        done += n;
                        int pct = total > 0 ? (int) (done * 100 / total) : 0;
                        if (pct != lastPct) {
                            lastPct = pct;
                            post("progress", String.valueOf(pct));
                        }
                    }
                    session.fsync(out);
                } finally {
                    conn.disconnect();
                }
                Intent status = new Intent(activity, MainActivity.class).setAction(ACTION_INSTALL_STATUS);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT
                        | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                PendingIntent pi = PendingIntent.getActivity(activity, 0, status, flags);
                post("installing", "");
                session.commit(pi.getIntentSender());
            }
        } catch (Exception e) {
            if (sessionId != -1) {
                try {
                    installer.abandonSession(sessionId);
                } catch (Exception ignored) {
                    // Session déjà fermée.
                }
            }
            busy = false;
            post("error", "Échec du téléchargement de la mise à jour.");
        }
    }

    /** Résultat de l'installeur Android, reçu par MainActivity.onNewIntent. */
    @SuppressWarnings("deprecation")
    void onInstallStatus(Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) activity.startActivity(confirm);
            return;
        }
        busy = false;
        if (status == PackageInstaller.STATUS_SUCCESS) return; // Android relance l'appli à jour.
        if (status == PackageInstaller.STATUS_FAILURE_ABORTED) post("error", "cancel");
        else post("error", "Mise à jour refusée par Android (code " + status + ").");
    }

    private void post(String event, String payload) {
        main.post(() -> callback.result(event, payload));
    }

    private static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setInstanceFollowRedirects(true);
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(30_000);
        conn.setUseCaches(false);
        if (conn.getResponseCode() != 200) {
            conn.disconnect();
            throw new IllegalStateException("HTTP " + conn.getResponseCode());
        }
        return conn;
    }

    private static String readText(String url) throws Exception {
        HttpURLConnection conn = open(url);
        try (BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            return sb.toString();
        } finally {
            conn.disconnect();
        }
    }
}
