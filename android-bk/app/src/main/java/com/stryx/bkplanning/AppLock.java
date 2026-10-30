package com.stryx.bkplanning;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;

/**
 * Verrouillage de l'appli : empreinte / visage, ou code du téléphone.
 * Réponse : (ok, message) ; message « cancel » si la personne a fermé la fenêtre.
 */
final class AppLock {

    interface Callback {
        void result(boolean ok, String message);
    }

    private final Activity activity;
    private final Callback callback;

    AppLock(Activity activity, Callback callback) {
        this.activity = activity;
        this.callback = callback;
    }

    /** « ok » si le téléphone a un verrouillage d'écran (code, schéma, empreinte), sinon « none ». */
    String status() {
        KeyguardManager km = (KeyguardManager) activity.getSystemService(Context.KEYGUARD_SERVICE);
        return km != null && km.isDeviceSecure() ? "ok" : "none";
    }

    @SuppressWarnings("deprecation")
    void authenticate(String title) {
        if (!"ok".equals(status())) { callback.result(false, "Aucun verrouillage d'écran sur ce téléphone"); return; }
        if (Build.VERSION.SDK_INT >= 29) {
            BiometricPrompt.Builder b = new BiometricPrompt.Builder(activity).setTitle(title == null ? "Planning BK" : title);
            if (Build.VERSION.SDK_INT >= 30) {
                b.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
            } else {
                b.setDeviceCredentialAllowed(true);
            }
            b.build().authenticate(new CancellationSignal(), activity.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    callback.result(true, "");
                }

                @Override
                public void onAuthenticationError(int code, CharSequence msg) {
                    boolean cancel = code == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED || code == BiometricPrompt.BIOMETRIC_ERROR_CANCELED;
                    callback.result(false, cancel ? "cancel" : String.valueOf(msg));
                }
            });
        } else {
            // Android 7 à 9 : écran de confirmation du code du téléphone.
            KeyguardManager km = (KeyguardManager) activity.getSystemService(Context.KEYGUARD_SERVICE);
            Intent i = km.createConfirmDeviceCredentialIntent(title, "Planning BK");
            if (i == null) { callback.result(true, ""); return; }
            activity.startActivityForResult(i, MainActivity.REQ_AUTH);
        }
    }

    void onResult(int resultCode) {
        callback.result(resultCode == Activity.RESULT_OK, resultCode == Activity.RESULT_OK ? "" : "cancel");
    }
}
