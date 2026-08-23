package com.deepspeak.app;

import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * 返回键：先交给前端页面栈（SPA hash 路由逐页后退），
     * 没有上一页时才退出应用。避免"任何页面按返回都直接退出"。
     */
    @Override
    public void onBackPressed() {
        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv == null) {
            super.onBackPressed();
            return;
        }
        wv.evaluateJavascript(
                "(window.__onBackPressed ? window.__onBackPressed() : false)",
                value -> {
                    if (value == null || !"true".equals(value)) {
                        runOnUiThread(() -> MainActivity.super.onBackPressed());
                    }
                }
        );
    }
}
