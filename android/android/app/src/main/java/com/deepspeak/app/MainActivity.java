package com.deepspeak.app;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Android 13+ 预测性返回：系统不再调用 onBackPressed，
        // 必须通过 OnBackInvokedDispatcher 注册回调，否则返回键 = 直接退出
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    this::handleBackPressed
            );
        }
    }

    /** 返回键统一入口：先让前端页面栈逐页后退，无上一页才退出应用。 */
    private void handleBackPressed() {
        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv == null) {
            finish();
            return;
        }
        wv.evaluateJavascript(
                "(window.__onBackPressed ? window.__onBackPressed() : false)",
                value -> {
                    if (value == null || !"true".equals(value)) {
                        runOnUiThread(this::finish);
                    }
                }
        );
    }

    /** Android 12 及以下：仍走 onBackPressed。 */
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        handleBackPressed();
    }
}
