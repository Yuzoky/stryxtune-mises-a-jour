package com.stryx.bkplanning;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * Accès réseau de l'appli web, limité à l'API « contents » du dépôt de données du planning.
 * Les fichiers y sont chiffrés par l'appli web avant l'envoi : ce pont ne voit que du chiffré.
 * Réponse : (id, statut HTTP, corps) ; statut 0 = pas de connexion.
 */
final class GitHubApi {

    interface Callback {
        void result(String id, int status, String text);
    }

    static final String REPO = "Yuzoky/bk-planning-data";
    private static final String BASE = "https://api.github.com/repos/" + REPO;
    private static final Pattern PATH = Pattern.compile("^r/[0-9a-f]{24}(\\.key)?\\.json$");
    private static final int MAX_BYTES = 5 * 1024 * 1024;

    private final Callback callback;
    private final ExecutorService pool = Executors.newFixedThreadPool(2);

    GitHubApi(Callback callback) {
        this.callback = callback;
    }

    void request(String id, String method, String path, String token, String body) {
        if (id == null || id.length() > 40) return;
        boolean root = path == null || path.isEmpty();
        if (!root && !PATH.matcher(path).matches()) { callback.result(id, 400, "chemin refusé"); return; }
        if (!"GET".equals(method) && !("PUT".equals(method) && !root)) { callback.result(id, 405, "méthode refusée"); return; }
        pool.execute(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(root ? BASE : BASE + "/contents/" + path).openConnection();
                conn.setRequestMethod(method);
                conn.setConnectTimeout(15_000);
                conn.setReadTimeout(25_000);
                conn.setUseCaches(false);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("Accept", "application/vnd.github+json");
                conn.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
                conn.setRequestProperty("User-Agent", "PlanningBK-Android");
                conn.setRequestProperty("Cache-Control", "no-cache");
                if (token != null && !token.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + token);
                if ("PUT".equals(method)) {
                    byte[] data = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    conn.setFixedLengthStreamingMode(data.length);
                    try (OutputStream out = conn.getOutputStream()) {
                        out.write(data);
                    }
                }
                int code = conn.getResponseCode();
                InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                callback.result(id, code, in == null ? "" : read(in));
            } catch (Exception e) {
                callback.result(id, 0, "réseau : " + e.getClass().getSimpleName());
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    private static String read(InputStream in) throws Exception {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = s.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_BYTES) throw new IllegalStateException("réponse trop grosse");
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
