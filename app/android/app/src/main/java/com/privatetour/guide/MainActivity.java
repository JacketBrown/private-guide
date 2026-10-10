package com.privatetour.guide;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** 持有桥实例，便于在 onDestroy 里释放原生 TTS / WebSocket 资源 */
    private EdgeTtsBridge ttsBridge;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 原生语音桥：Edge TTS 走 OkHttp（绕开 WebView WebSocket 的网络短板），
        // 系统音色走 android.speech.tts（修国产 ROM WebView 拿不到 voice 的问题）
        WebView webView = bridge.getWebView();
        if (webView != null) {
            ttsBridge = new EdgeTtsBridge(webView);
            webView.addJavascriptInterface(ttsBridge, "NativeEdgeTts");
        }
    }

    @Override
    public void onDestroy() {
        // 不释放会泄漏系统 TTS 引擎连接与在途 WebSocket
        if (ttsBridge != null) {
            ttsBridge.shutdown();
            ttsBridge = null;
        }
        super.onDestroy();
    }
}
