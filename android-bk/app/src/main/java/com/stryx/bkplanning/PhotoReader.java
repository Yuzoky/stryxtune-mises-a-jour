package com.stryx.bkplanning;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.graphics.Point;
import android.graphics.Rect;
import android.media.ExifInterface;
import android.net.Uri;

import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Photo du planning → texte reconnu avec sa position (Google ML Kit, modèle embarqué :
 * tout se fait sur le téléphone, la photo n'est envoyée nulle part).
 * Pour chaque photo, l'appli web reçoit « page » : { ocr: { w, h, lines }, src, scale },
 * où src est une copie réduite de la photo (pour afficher l'extrait à vérifier).
 */
final class PhotoReader {

    interface Callback {
        void event(String event, String payload);
    }

    private static final int OCR_MAX = 3200;
    private static final int PREVIEW_MAX = 2400;
    private static final Pattern TIME = Pattern.compile("\\d{1,2}\\s?[:hH.]\\s?\\d{2}");

    private final Activity activity;
    private final Callback callback;
    private volatile boolean busy;

    PhotoReader(Activity activity, Callback callback) {
        this.activity = activity;
        this.callback = callback;
    }

    static File previewDir(Context ctx) {
        File dir = new File(ctx.getCacheDir(), "photos");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    void pick(boolean camera) {
        if (busy) return;
        try {
            if (camera) {
                File f = PhotoProvider.file(activity);
                //noinspection ResultOfMethodCallIgnored
                f.delete();
                Uri out = PhotoProvider.uri();
                Intent i = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
                i.putExtra(android.provider.MediaStore.EXTRA_OUTPUT, out);
                i.setClipData(ClipData.newRawUri("photo", out));
                i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                activity.startActivityForResult(i, MainActivity.REQ_CAMERA);
            } else {
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.setType("image/*");
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                activity.startActivityForResult(Intent.createChooser(i, "Photos du planning"), MainActivity.REQ_GALLERY);
            }
        } catch (ActivityNotFoundException e) {
            callback.event("error", camera ? "Pas d'appareil photo disponible" : "Pas de galerie disponible");
        }
    }

    void onResult(int request, int result, Intent data) {
        if (result != Activity.RESULT_OK) { callback.event("cancel", ""); return; }
        List<Uri> uris = new ArrayList<>();
        if (request == MainActivity.REQ_CAMERA) {
            if (PhotoProvider.file(activity).length() > 0) uris.add(Uri.fromFile(PhotoProvider.file(activity)));
        } else if (data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) for (int i = 0; i < clip.getItemCount() && i < 8; i++) uris.add(clip.getItemAt(i).getUri());
            else if (data.getData() != null) uris.add(data.getData());
        }
        if (uris.isEmpty()) { callback.event("cancel", ""); return; }
        busy = true;
        new Thread(() -> readAll(uris), "bk-ocr").start();
    }

    private void readAll(List<Uri> uris) {
        cleanOld();
        TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        int ok = 0;
        try {
            for (int n = 0; n < uris.size(); n++) {
                callback.event("busy", uris.size() > 1 ? "Lecture de la photo " + (n + 1) + " sur " + uris.size() + "…" : "Lecture de la photo…");
                Bitmap orig = null;
                Bitmap bmp = null;
                try {
                    orig = load(uris.get(n));
                    bmp = orig;
                    // Photo de côté ? On essaie aussi tournée si presque aucune heure n'est lue.
                    Text best = recognize(recognizer, orig);
                    int score = score(best);
                    for (int deg : new int[]{90, 270, 180}) {
                        if (score >= 8) break;
                        Bitmap r = rotate(orig, deg);
                        Text t = recognize(recognizer, r);
                        int sc = score(t);
                        if (sc > score) {
                            if (bmp != orig) bmp.recycle();
                            bmp = r;
                            best = t;
                            score = sc;
                        } else r.recycle();
                    }
                    String name = "p" + System.currentTimeMillis() + "_" + n + ".jpg";
                    float scale = savePreview(bmp, new File(previewDir(activity), name));
                    JSONObject page = new JSONObject();
                    page.put("ocr", toJson(best, bmp.getWidth(), bmp.getHeight()));
                    // 2e lecture en 4 morceaux qui se chevauchent : le petit texte d'un tableau
                    // chargé est mieux lu. L'appli garde, ligne par ligne, la lecture qui tombe juste.
                    try {
                        page.put("tiled", tiled(recognizer, bmp));
                    } catch (Exception | OutOfMemoryError ignored) {
                        // Pas grave : la lecture entière suffit.
                    }
                    page.put("src", "/photo/" + name);
                    page.put("scale", scale);
                    callback.event("page", page.toString());
                    ok++;
                } catch (OutOfMemoryError e) {
                    callback.event("error", "Photo trop grande pour ce téléphone");
                } catch (Exception e) {
                    callback.event("error", "Impossible de lire cette photo");
                } finally {
                    if (bmp != null && bmp != orig) bmp.recycle();
                    if (orig != null) orig.recycle();
                }
            }
        } finally {
            recognizer.close();
            busy = false;
            callback.event("done", String.valueOf(ok));
        }
    }

    private Text recognize(TextRecognizer recognizer, Bitmap bmp) throws Exception {
        return Tasks.await(recognizer.process(InputImage.fromBitmap(bmp, 0)));
    }

    private static int score(Text t) {
        Matcher m = TIME.matcher(t.getText());
        int n = 0;
        while (m.find()) n++;
        return n;
    }

    /** Photo réduite (côté max OCR_MAX) et remise à l'endroit selon l'EXIF. */
    private Bitmap load(Uri uri) throws Exception {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream in = open(uri)) {
            BitmapFactory.decodeStream(in, null, bounds);
        }
        if (bounds.outWidth <= 0) throw new IllegalStateException("image");
        int sample = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= OCR_MAX) sample *= 2;
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sample;
        Bitmap bmp;
        try (InputStream in = open(uri)) {
            bmp = BitmapFactory.decodeStream(in, null, opts);
        }
        if (bmp == null) throw new IllegalStateException("image");
        int orientation = ExifInterface.ORIENTATION_NORMAL;
        try (InputStream in = open(uri)) {
            orientation = new ExifInterface(in).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (Exception ignored) {
            // Pas d'EXIF : image telle quelle.
        }
        int deg = orientation == ExifInterface.ORIENTATION_ROTATE_90 ? 90
                : orientation == ExifInterface.ORIENTATION_ROTATE_180 ? 180
                : orientation == ExifInterface.ORIENTATION_ROTATE_270 ? 270 : 0;
        float max = Math.max(bmp.getWidth(), bmp.getHeight());
        float k = max > OCR_MAX ? OCR_MAX / max : 1f;
        if (deg == 0 && k == 1f) return bmp;
        Matrix m = new Matrix();
        m.postScale(k, k);
        m.postRotate(deg);
        Bitmap out = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
        if (out != bmp) bmp.recycle();
        return out;
    }

    private InputStream open(Uri uri) throws Exception {
        if ("file".equals(uri.getScheme())) return new java.io.FileInputStream(uri.getPath());
        InputStream in = activity.getContentResolver().openInputStream(uri);
        if (in == null) throw new IllegalStateException("flux");
        return in;
    }

    private static Bitmap rotate(Bitmap bmp, int deg) {
        Matrix m = new Matrix();
        m.postRotate(deg);
        return Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
    }

    private static float savePreview(Bitmap bmp, File file) throws Exception {
        float max = Math.max(bmp.getWidth(), bmp.getHeight());
        float k = max > PREVIEW_MAX ? PREVIEW_MAX / max : 1f;
        Bitmap small = k < 1f ? Bitmap.createScaledBitmap(bmp, Math.round(bmp.getWidth() * k), Math.round(bmp.getHeight() * k), true) : bmp;
        try (FileOutputStream out = new FileOutputStream(file)) {
            small.compress(Bitmap.CompressFormat.JPEG, 85, out);
        } finally {
            if (small != bmp) small.recycle();
        }
        return k;
    }

    /** Copies réduites de plus d'un jour : effacées. */
    private void cleanOld() {
        File[] files = previewDir(activity).listFiles();
        if (files == null) return;
        long limit = System.currentTimeMillis() - 24L * 3600 * 1000;
        for (File f : files) if (f.lastModified() < limit) //noinspection ResultOfMethodCallIgnored
            f.delete();
    }

    private static JSONObject toJson(Text text, int w, int h) throws Exception {
        JSONArray lines = new JSONArray();
        addLines(lines, text, 0, 0, null);
        JSONObject out = new JSONObject();
        out.put("w", w);
        out.put("h", h);
        out.put("lines", lines);
        return out;
    }

    /** Lecture en 2 × 2 morceaux (20 % de recouvrement), remise en coordonnées de la photo. */
    private JSONObject tiled(TextRecognizer recognizer, Bitmap bmp) throws Exception {
        int w = bmp.getWidth();
        int h = bmp.getHeight();
        int tw = (w + w / 5) / 2;
        int th = (h + h / 5) / 2;
        JSONArray lines = new JSONArray();
        for (int r = 0; r < 2; r++) {
            for (int c = 0; c < 2; c++) {
                int x = c == 0 ? 0 : w - tw;
                int y = r == 0 ? 0 : h - th;
                // Chaque mot n'est gardé que dans le morceau où tombe son centre : pas de doublon.
                Rect core = new Rect(c == 0 ? 0 : w / 2, r == 0 ? 0 : h / 2, c == 0 ? w / 2 : w, r == 0 ? h / 2 : h);
                Bitmap tile = Bitmap.createBitmap(bmp, x, y, tw, th);
                try {
                    addLines(lines, recognize(recognizer, tile), x, y, core);
                } finally {
                    tile.recycle();
                }
            }
        }
        JSONObject out = new JSONObject();
        out.put("w", w);
        out.put("h", h);
        out.put("lines", lines);
        return out;
    }

    /** Lignes reconnues → JSON, décalées de (dx, dy) ; si core, seuls les mots dont le centre y est. */
    private static void addLines(JSONArray lines, Text text, int dx, int dy, Rect core) throws Exception {
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                Rect lb = line.getBoundingBox();
                if (lb == null) continue;
                JSONArray els = new JSONArray();
                StringBuilder sb = new StringBuilder();
                int l = Integer.MAX_VALUE, t = Integer.MAX_VALUE, rr = Integer.MIN_VALUE, bb = Integer.MIN_VALUE;
                int all = 0;
                for (Text.Element e : line.getElements()) {
                    Rect eb = e.getBoundingBox();
                    if (eb == null) continue;
                    all++;
                    if (core != null && !core.contains(eb.centerX() + dx, eb.centerY() + dy)) continue;
                    JSONObject o = new JSONObject();
                    o.put("t", e.getText());
                    o.put("b", rect(eb, dx, dy));
                    JSONArray ec = corners(e.getCornerPoints(), dx, dy);
                    if (ec != null) o.put("c", ec);
                    els.put(o);
                    if (sb.length() > 0) sb.append(' ');
                    sb.append(e.getText());
                    l = Math.min(l, eb.left + dx);
                    t = Math.min(t, eb.top + dy);
                    rr = Math.max(rr, eb.right + dx);
                    bb = Math.max(bb, eb.bottom + dy);
                }
                if (els.length() == 0) continue;
                JSONObject o = new JSONObject();
                boolean whole = els.length() == all;
                o.put("t", whole ? line.getText() : sb.toString());
                o.put("b", whole ? rect(lb, dx, dy) : new JSONArray().put(l).put(t).put(rr).put(bb));
                JSONArray lc = whole ? corners(line.getCornerPoints(), dx, dy) : null;
                if (lc != null) o.put("c", lc);
                o.put("e", els);
                lines.put(o);
            }
        }
    }

    private static JSONArray rect(Rect r, int dx, int dy) {
        return new JSONArray().put(r.left + dx).put(r.top + dy).put(r.right + dx).put(r.bottom + dy);
    }

    private static JSONArray corners(Point[] pts, int dx, int dy) {
        if (pts == null || pts.length != 4) return null;
        JSONArray a = new JSONArray();
        for (Point p : pts) a.put(p.x + dx).put(p.y + dy);
        return a;
    }
}
