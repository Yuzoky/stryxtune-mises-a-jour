package com.stryx.bkplanning;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Donne à l'appareil photo un fichier où écrire la photo du planning (cache privé de l'appli),
 * sans permission de stockage. Seul le fichier « capture.jpg » est accessible.
 */
public class PhotoProvider extends ContentProvider {

    static final String AUTHORITY = "com.stryx.bkplanning.photos";
    static final String NAME = "capture.jpg";

    static File file(android.content.Context ctx) {
        File dir = new File(ctx.getCacheDir(), "capture");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return new File(dir, NAME);
    }

    static Uri uri() {
        return Uri.parse("content://" + AUTHORITY + "/" + NAME);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!NAME.equals(uri.getLastPathSegment())) throw new FileNotFoundException();
        return ParcelFileDescriptor.open(file(getContext()), ParcelFileDescriptor.parseMode(mode));
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        if (!NAME.equals(uri.getLastPathSegment())) return null;
        MatrixCursor c = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        c.addRow(new Object[]{NAME, file(getContext()).length()});
        return c;
    }

    @Override
    public String getType(Uri uri) {
        return "image/jpeg";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        return 0;
    }
}
