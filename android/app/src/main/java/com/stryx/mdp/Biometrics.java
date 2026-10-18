package com.stryx.mdp;

import android.annotation.TargetApi;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.Executor;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Déverrouillage par empreinte : le mot de passe maître est chiffré (AES-256-GCM) avec une clé
 * du Keystore Android, utilisable seulement juste après une authentification biométrique forte.
 * La clé est invalidée si une nouvelle empreinte est ajoutée au téléphone.
 * Les appels propres aux versions récentes sont protégés par status() (Android 10+).
 */
@TargetApi(30)
final class Biometrics {

    interface Callback {
        void result(String action, boolean ok, String payload);
    }

    private static final String KEY_ALIAS = "stryxmdp_biometric";
    private static final String PREFS = "stryxmdp_biometric";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";

    private final Activity activity;
    private final Callback callback;
    private final SharedPreferences prefs;
    private CancellationSignal cancel;

    Biometrics(Activity activity, Callback callback) {
        this.activity = activity;
        this.callback = callback;
        this.prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** "available", "none-enrolled" ou "unavailable". */
    String status() {
        if (Build.VERSION.SDK_INT < 29) return "unavailable";
        BiometricManager bm = activity.getSystemService(BiometricManager.class);
        if (bm == null) return "unavailable";
        int r = Build.VERSION.SDK_INT >= 30
                ? bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                : bm.canAuthenticate();
        if (r == BiometricManager.BIOMETRIC_SUCCESS) return "available";
        if (r == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED) return "none-enrolled";
        return "unavailable";
    }

    boolean isEnabled() {
        return prefs.contains("data") && prefs.contains("iv");
    }

    void disable() {
        prefs.edit().clear().apply();
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            ks.deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {
            // Rien à supprimer.
        }
    }

    void enable(String masterPassword) {
        if (!"available".equals(status())) {
            callback.result("enable", false, "Aucune empreinte enregistrée sur ce téléphone (Paramètres › Sécurité).");
            return;
        }
        Cipher cipher;
        try {
            disable();
            cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, createKey());
        } catch (Exception e) {
            callback.result("enable", false, "Empreinte indisponible sur cet appareil.");
            return;
        }
        authenticate("Activer l'empreinte", cipher, "enable", c -> {
            byte[] data = c.doFinal(masterPassword.getBytes(StandardCharsets.UTF_8));
            prefs.edit()
                    .putString("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP))
                    .putString("data", Base64.encodeToString(data, Base64.NO_WRAP))
                    .apply();
            return "";
        });
    }

    void unlock() {
        if (!isEnabled()) return;
        Cipher cipher;
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            SecretKey key = (SecretKey) ks.getKey(KEY_ALIAS, null);
            if (key == null) throw new KeyPermanentlyInvalidatedException();
            byte[] iv = Base64.decode(prefs.getString("iv", ""), Base64.NO_WRAP);
            cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
        } catch (KeyPermanentlyInvalidatedException e) {
            disable();
            callback.result("unlock", false, "invalidated");
            return;
        } catch (Exception e) {
            callback.result("unlock", false, "Empreinte indisponible, utilisez le mot de passe.");
            return;
        }
        authenticate("Déverrouiller le coffre", cipher, "unlock", c -> {
            byte[] data = Base64.decode(prefs.getString("data", ""), Base64.NO_WRAP);
            return new String(c.doFinal(data), StandardCharsets.UTF_8);
        });
    }

    private interface CipherStep {
        String run(Cipher cipher) throws Exception;
    }

    private void authenticate(String subtitle, Cipher cipher, String action, CipherStep step) {
        if (cancel != null) cancel.cancel();
        cancel = new CancellationSignal();
        Executor executor = activity.getMainExecutor();
        BiometricPrompt prompt = new BiometricPrompt.Builder(activity)
                .setTitle("Stryx Hub")
                .setSubtitle(subtitle)
                .setNegativeButton("Mot de passe", executor,
                        (dialog, which) -> callback.result(action, false, "cancel"))
                .build();
        prompt.authenticate(new BiometricPrompt.CryptoObject(cipher), cancel, executor,
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        try {
                            String out = step.run(result.getCryptoObject().getCipher());
                            callback.result(action, true, out);
                        } catch (Exception e) {
                            if ("enable".equals(action)) disable();
                            callback.result(action, false, "Échec du chiffrement, réessayez.");
                        }
                    }

                    @Override
                    public void onAuthenticationError(int code, CharSequence message) {
                        // Le bouton « Mot de passe » passe par son propre écouteur, pas par ici.
                        boolean cancelled = code == BiometricPrompt.BIOMETRIC_ERROR_CANCELED
                                || code == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED;
                        if ("enable".equals(action)) disable();
                        callback.result(action, false, cancelled ? "cancel" : String.valueOf(message));
                    }
                });
    }

    private SecretKey createKey() throws Exception {
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= 30) {
            spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(spec.build());
        return gen.generateKey();
    }
}
