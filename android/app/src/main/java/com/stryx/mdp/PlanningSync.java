package com.stryx.mdp;

import android.os.Handler;
import android.os.Looper;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Récupère le planning chiffré publié par Claude (sync/planning.json du dépôt).
 * Les adresses sont fixes : la page web ne peut pas s'en servir pour joindre un autre site.
 * Le déchiffrement se fait dans l'appli web, avec la clé privée gardée dans le coffre.
 */
final class PlanningSync {

    interface Callback {
        void result(boolean ok, String payload);
    }

    private static final String[] URLS = {
        "https://raw.githubusercontent.com/Yuzoky/stryxtune-mises-a-jour/refs/heads/claude/phone-password-manager-app-kemsf3/sync/planning.json",
        "https://yuzoky.github.io/stryxtune-mises-a-jour/sync/planning.json",
        "https://raw.githubusercontent.com/Yuzoky/stryxtune-mises-a-jour/refs/heads/main/sync/planning.json",
    };
    private static final int MAX_BYTES = 1024 * 1024;

    private final Callback callback;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean busy;

    PlanningSync(Callback callback) {
        this.callback = callback;
    }

    void fetch() {
        if (busy) return;
        busy = true;
        new Thread(() -> {
            String text = null;
            String error = "Planning automatique indisponible (connexion ?)";
            // Paramètre anti-cache, changé chaque minute.
            long bust = System.currentTimeMillis() / 60_000;
            for (String url : URLS) {
                try {
                    text = read(url + "?t=" + bust);
                    if (text != null) break;
                    error = "none";
                } catch (Exception e) {
                    // On essaie l'adresse suivante.
                }
            }
            final boolean ok = text != null;
            final String payload = ok ? text : error;
            busy = false;
            main.post(() -> callback.result(ok, payload));
        }, "stryxhub-plan-sync").start();
    }

    /** Contenu du fichier, ou null s'il n'existe pas (404). */
    private static String read(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setInstanceFollowRedirects(true);
        conn.setConnectTimeout(10_000);
        conn.setReadTimeout(15_000);
        conn.setUseCaches(false);
        try {
            int code = conn.getResponseCode();
            if (code == 404) return null;
            if (code != 200) throw new IllegalStateException("HTTP " + code);
            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (out.size() > MAX_BYTES) throw new IllegalStateException("trop gros");
                }
                return new String(out.toByteArray(), StandardCharsets.UTF_8);
            }
        } finally {
            conn.disconnect();
        }
    }
}
