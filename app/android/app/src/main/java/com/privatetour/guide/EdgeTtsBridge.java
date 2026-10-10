package com.privatetour.guide;

import android.content.Context;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import okio.Buffer;

/**
 * 原生语音桥 —— 解决两个 WebView 短板：
 *
 * ① Edge TTS：WebView 的 WebSocket 在部分运营商网络下握手被拒（本机实测桌面端同代码可通），
 *    原生 OkHttp 走系统网络栈，且可以带上 WebView 发不了的请求头
 *    （Cookie: muid / Origin / 完整 UA），成功率远高于 WebView。
 *
 * ② 系统音色：Android WebView 的 speechSynthesis 在很多国产 ROM 上拿不到任何 voice，
 *    原生 android.speech.tts.TextToSpeech 直接走系统 TTS 引擎，可用性好得多。
 *
 * JS 侧调用约定（见 web/scripts/edge-tts.js 与 speech.js）：
 *   NativeEdgeTts.synthesize(reqId, text, voice, rate, pitch)
 *   NativeEdgeTts.cancelSynth(reqId)
 *   NativeEdgeTts.sysSpeak(reqId, text)
 *   NativeEdgeTts.sysStop()
 * 回调（Java evaluateJavascript 注入）：
 *   window.__nativeTtsResult(reqId, errorOrNull, base64Mp3OrNull)
 *   window.__nativeSysDone(reqId, errorOrNull)
 */
@SuppressWarnings("deprecation") // UtteranceProgressListener.onError(String,int) 是兼容旧 ROM 必需
public class EdgeTtsBridge {
    private static final String TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    private static final String WSS_URL =
            "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
                    + "?TrustedClientToken=" + TRUSTED_CLIENT_TOKEN;
    private static final String CHROMIUM_FULL_VERSION = "143.0.3650.75";
    private static final String SEC_MS_GEC_VERSION = "1-" + CHROMIUM_FULL_VERSION;
    private static final String OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
    private static final String ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/" + CHROMIUM_FULL_VERSION + " Safari/537.36 Edg/" + CHROMIUM_FULL_VERSION;
    private static final long WIN_EPOCH = 11644473600L;

    private final WebView webView;
    private final OkHttpClient client;
    private final ConcurrentHashMap<String, SynthJob> jobs = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, WebSocket> sockets = new ConcurrentHashMap<>();

    /** TTS 可能被不同线程调用（JS 桥线程 / 初始化回调），必须 volatile */
    private volatile TextToSpeech tts;
    private volatile boolean ttsInitStarted = false;
    /** TTS 初始化完成后的待播队列：初始化前来的请求先排队，就绪后统一放行 */
    private final java.util.List<Runnable> ttsPending = java.util.Collections.synchronizedList(new java.util.ArrayList<>());

    /** utteranceId → JS reqId 映射。原先每次 sysSpeak 都换一个 listener，
     *  会把上一次的 onDone 回调丢掉（JS 侧 nativeSysPending 永远等不到回调）；
     *  改为 listener 只装一次、用映射表分发。 */
    private final ConcurrentHashMap<String, String> utterToReq = new ConcurrentHashMap<>();

    private static final String[] WEEK = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
    private static final String[] MONTH =
            {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};

    public EdgeTtsBridge(WebView webView) {
        this.webView = webView;
        this.client = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .pingInterval(0, TimeUnit.SECONDS)
                .build();
    }

    // ============================================================
    //  鉴权 / 帧（与 web/scripts/edge-tts.js 逐字对齐）
    // ============================================================

    /** Sec-MS-GEC：ticks（100 纳秒、5 分钟窗口）拼接令牌后 SHA-256 大写十六进制 */
    private static String generateSecMsGec() {
        long ticks = System.currentTimeMillis() / 1000L;
        ticks += WIN_EPOCH;
        ticks -= ticks % 300L;
        ticks *= 10_000_000L; // 1e9/100 —— 换算成 100 纳秒单位
        return sha256HexUpper(ticks + TRUSTED_CLIENT_TOKEN);
    }

    private static String sha256HexUpper(String s) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(h.length * 2);
            for (byte b : h) sb.append(String.format("%02X", b));
            return sb.toString();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static String randomHex(boolean upper) {
        StringBuilder sb = new StringBuilder(32);
        java.util.Random r = new java.util.Random();
        for (int i = 0; i < 16; i++) sb.append(String.format("%02x", r.nextInt(256)));
        return upper ? sb.toString().toUpperCase() : sb.toString();
    }

    /** JS 风格日期串："Fri Oct 09 2026 12:23:50 GMT+0000 (Coordinated Universal Time)" */
    private static String jsDate() {
        Calendar c = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        return String.format(Locale.US, "%s %s %02d %04d %02d:%02d:%02d GMT+0000 (Coordinated Universal Time)",
                WEEK[c.get(Calendar.DAY_OF_WEEK) - 1],
                MONTH[c.get(Calendar.MONTH)],
                c.get(Calendar.DAY_OF_MONTH),
                c.get(Calendar.YEAR),
                c.get(Calendar.HOUR_OF_DAY),
                c.get(Calendar.MINUTE),
                c.get(Calendar.SECOND));
    }

    private static String esc(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;").replace("'", "&apos;");
    }

    private static String speechConfigFrame() {
        return "X-Timestamp:" + jsDate() + "\r\n"
                + "Content-Type:application/json; charset=utf-8\r\n"
                + "Path:speech.config\r\n\r\n"
                + "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{"
                + "\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\""
                + "},\"outputFormat\":\"" + OUTPUT_FORMAT + "\"}}}}\r\n";
    }

    /** ssml 帧 —— 末尾 X-Timestamp 多一个 Z 是微软历史 bug，必须照抄 */
    private static String ssmlFrame(String text, String voice, String rate, String pitch, String volume) {
        String ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>"
                + "<voice name='" + esc(voice) + "'>"
                + "<prosody pitch='" + esc(pitch) + "' rate='" + esc(rate) + "' volume='" + esc(volume) + "'>"
                + esc(text)
                + "</prosody></voice></speak>";
        return "X-RequestId:" + randomHex(false) + "\r\n"
                + "Content-Type:application/ssml+xml\r\n"
                + "X-Timestamp:" + jsDate() + "Z\r\n"
                + "Path:ssml\r\n\r\n"
                + ssml;
    }

    // ============================================================
    //  Edge TTS 合成（OkHttp WebSocket）
    // ============================================================

    @JavascriptInterface
    public void synthesize(String reqId, String text, String voice, String rate, String pitch) {
        final String clean = text == null ? "" : text.replaceAll("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]", " ").trim();
        if (clean.isEmpty()) { fail(reqId, "文本为空"); return; }

        String url = WSS_URL
                + "&ConnectionId=" + randomHex(false)
                + "&Sec-MS-GEC=" + generateSecMsGec()
                + "&Sec-MS-GEC-Version=" + SEC_MS_GEC_VERSION;

        Request request = new Request.Builder()
                .url(url)
                .header("Origin", ORIGIN)
                .header("User-Agent", USER_AGENT)
                .header("Cookie", "muid=" + randomHex(true) + ";")
                .build();

        SynthJob job = new SynthJob(reqId);
        jobs.put(reqId, job);

        client.newWebSocket(request, new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response response) {
                // 关键：把 ws 登记进 sockets，否则 cancelSynth 永远拿不到实例、
                // ws.cancel() 形同虚设（跳句时连接会一直挂着直到自然结束）。
                sockets.put(reqId, ws);
                if (job.cancelled) {
                    cleanup(reqId);
                    ws.close(1000, null);
                    return;
                }
                ws.send(speechConfigFrame());
                // 微软要求 prosody 参数带符号：+0% / -4% / +2Hz
                String r = normalizeSign(rate, "%");
                String p = normalizeSign(pitch, "Hz");
                ws.send(ssmlFrame(clean, voice, r, p, "+0%"));
            }

            @Override public void onMessage(WebSocket ws, String text) {
                if (job.cancelled) return;
                if (text.contains("Path:turn.end")) {
                    job.turnEnded = true;
                    if (job.audio.size() == 0) {
                        fail(reqId, "没有收到音频数据");
                    } else {
                        succeed(reqId, job.audio.toByteArray());
                    }
                } else if (text.contains("Path:response")
                        && (text.contains("Unauthorized") || text.contains("Forbidden") || text.contains("403"))) {
                    fail(reqId, "语音服务拒绝访问（鉴权失败）");
                }
            }

            @Override public void onMessage(WebSocket ws, ByteString bytes) {
                if (job.cancelled) return;
                // 前 2 字节大端 = 头部长度，其后是头部文本，其余是音频
                if (bytes.size() < 3) return;
                int headerLen = ((bytes.getByte(0) & 0xff) << 8) | (bytes.getByte(1) & 0xff);
                if (2 + headerLen >= bytes.size()) return;
                // 只收 Path:audio 的帧（简化：头部含 "Path:audio" 才追加）
                String header = bytes.substring(2, 2 + headerLen).utf8();
                if (header.contains("Path:audio")) {
                    Buffer rest = new Buffer();
                    rest.write(bytes, 2 + headerLen, bytes.size() - 2 - headerLen);
                    try {
                        byte[] arr = rest.readByteArray();
                        job.audio.write(arr);
                    } catch (Exception ignored) { }
                }
            }

            @Override public void onFailure(WebSocket ws, Throwable t, Response response) {
                // 先摘表（无论是否 cancelled）—— 早返回路径若不清理，
                // jobs / sockets 表会随每次取消永久增长（内存泄漏）。
                if (job.cancelled) { cleanup(reqId); return; }
                if (job.audio.size() > 0) {
                    // 收到过音频但连接中断：当作成功（与 JS 侧行为一致）
                    succeed(reqId, job.audio.toByteArray());
                } else {
                    fail(reqId, "语音连接出错: " + (t == null ? "unknown" : t.getMessage()));
                }
            }

            @Override public void onClosed(WebSocket ws, int code, String reason) {
                if (job.cancelled) { cleanup(reqId); return; }
                if (job.audio.size() > 0) succeed(reqId, job.audio.toByteArray());
                else fail(reqId, "连接已关闭(" + code + ")");
            }
        });
    }

    /** 从两张表里摘掉本次请求，并释放音频缓冲 */
    private void cleanup(String reqId) {
        jobs.remove(reqId);
        sockets.remove(reqId);
    }

    @JavascriptInterface
    public void cancelSynth(String reqId) {
        SynthJob job = jobs.get(reqId);
        if (job != null) job.cancelled = true;
        WebSocket ws = sockets.get(reqId);
        if (ws != null) {
            try { ws.cancel(); } catch (Exception ignored) { }
        }
        // 主动取消属于终态：连接不会再回调业务回调，这里立即清表，
        // 否则 jobs/sockets 会滞留到 GC 才释放。
        // 注意不能清掉音频缓冲的引用之外的东西——cleanup 只摘表，安全。
        cleanup(reqId);
    }

    private static class SynthJob {
        final String reqId;
        final ByteArrayOutputStream audio = new ByteArrayOutputStream();
        volatile boolean cancelled = false;
        volatile boolean turnEnded = false;
        SynthJob(String reqId) { this.reqId = reqId; }
    }

    private static String normalizeSign(String v, String unit) {
        if (v == null || v.isEmpty()) return "+0" + unit;
        // JS 侧传来的就是带符号的（如 "-4%" / "+2Hz"），透传；纯数字则补 +
        if (v.startsWith("+") || v.startsWith("-")) return v;
        return "+" + v;
    }

    private void succeed(String reqId, byte[] mp3) {
        cleanup(reqId);
        String b64 = android.util.Base64.encodeToString(mp3, android.util.Base64.NO_WRAP);
        // 说明：base64 一次注入是可行的 —— evaluateJavascript 的参数本身
        // 就是完整字符串，不存在"分块注入"的 API；JS 侧用分段 atob 消化大字符串。
        final String js = String.format("window.__nativeTtsResult(%s, null, %s);",
                jsStr(reqId), jsStr(b64));
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private void fail(String reqId, String msg) {
        cleanup(reqId);
        final String js = String.format("window.__nativeTtsResult(%s, %s, null);",
                jsStr(reqId), jsStr(msg));
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private static String jsStr(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    // ============================================================
    //  原生系统 TTS（修国产 ROM WebView 拿不到 voice 的问题）
    // ============================================================

    @JavascriptInterface
    public void sysSpeak(String reqId, String text) {
        // 不阻塞 JS 桥线程：TTS 引擎初始化要几百毫秒，
        // 在桥方法里等待会卡住整个 WebView 的 JS 执行。
        ensureTts(() -> doSysSpeak(reqId, text));
    }

    private synchronized void doSysSpeak(String reqId, String text) {
        TextToSpeech engine = tts;
        if (engine == null) { sysFail(reqId, "系统 TTS 引擎不可用"); return; }
        final String utteranceId = "nat_" + reqId;
        // 建立映射后再说，保证 listener 回调能找到对应的 JS 请求
        utterToReq.put(utteranceId, reqId);
        engine.setLanguage(Locale.SIMPLIFIED_CHINESE);
        // QUEUE_FLUSH：新的一句开始就掐掉上一句（跳句/降级场景需要）
        int r = engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
        if (r == TextToSpeech.ERROR) {
            utterToReq.remove(utteranceId);
            sysFail(reqId, "TTS 播报启动失败");
        }
    }

    @JavascriptInterface
    public synchronized void sysStop() {
        TextToSpeech engine = tts;
        if (engine != null) {
            try { engine.stop(); } catch (Exception ignored) { }
        }
        // 清空映射：被 flush 掉的那些 utterance 不会再收到 onDone，
        // 对应 JS 侧的挂起回调已由 sysStop 的调用方清空。
        utterToReq.clear();
    }

    /**
     * 初始化原生 TTS。
     *
     * 旧实现的 bug：tts 是异步构造的，第一次调用 sysSpeak 时 ttsReady 必然还是 false
     * → 首次播报 100% 失败（用户感知为"点了没反应，第二次才好"）。
     * 现在把"初始化完成要做的事"排队，就绪后统一放行；listener 也只在这里装一次。
     */
    private void ensureTts(Runnable afterReady) {
        if (tts != null) { afterReady.run(); return; }
        synchronized (this) {
            if (tts != null) { afterReady.run(); return; }
            // 无论本次是不是"第一个发起初始化的人"，都要排队 ——
            // 初始化回调统一从 ttsPending 里取出来放行。
            ttsPending.add(afterReady);
            if (ttsInitStarted) return;
            ttsInitStarted = true;

            // 用 holder 承接实例：回调 lambda 在 TextToSpeech 构造期间就引用了它，
            // 直接引用局部变量 engine 会被编译器判定为"可能尚未初始化"。
            final TextToSpeech[] holder = new TextToSpeech[1];

            TextToSpeech created = new TextToSpeech(webView.getContext(), status -> {
                TextToSpeech engine = holder[0];
                if (engine == null || status != TextToSpeech.SUCCESS) {
                    tts = null;
                    ttsInitStarted = false;
                    drainTtsPending(false);
                    return;
                }
                // 装一次全局 listener，靠 utterToReq 分发到具体 reqId
                engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { }
                    @Override public void onDone(String id) {
                        String reqId = utterToReq.remove(id);
                        if (reqId != null) sysDone(reqId);
                    }
                    @Override public void onError(String id) {
                        String reqId = utterToReq.remove(id);
                        if (reqId != null) sysFail(reqId, "TTS 播报失败");
                    }
                    @Deprecated @Override public void onError(String id, int code) {
                        String reqId = utterToReq.remove(id);
                        if (reqId != null) sysFail(reqId, "TTS 播报失败(" + code + ")");
                    }
                });
                tts = engine;
                drainTtsPending(true);
            });
            holder[0] = created;
        }
    }

    /** 初始化完成后放行排队的播报请求；failed 则逐个报错，避免 JS 侧永久等待 */
    private void drainTtsPending(boolean ok) {
        java.util.List<Runnable> queued;
        synchronized (ttsPending) {
            queued = new java.util.ArrayList<>(ttsPending);
            ttsPending.clear();
        }
        for (Runnable r : queued) {
            try {
                r.run();   // 失败时 tts == null，doSysSpeak 会回"引擎不可用"
            } catch (Exception ignored) { }
        }
    }

    private void sysDone(String reqId) {
        final String js = String.format("window.__nativeSysDone(%s, null);", jsStr(reqId));
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private void sysFail(String reqId, String msg) {
        final String js = String.format("window.__nativeSysDone(%s, %s);", jsStr(reqId), jsStr(msg));
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    /**
     * 释放原生资源（Activity 销毁时调用）。
     * TextToSpeech 持有系统引擎连接，不 shutdown 会泄漏一个 service 连接。
     */
    public void shutdown() {
        TextToSpeech engine = tts;
        tts = null;
        utterToReq.clear();
        if (engine != null) {
            try { engine.stop(); } catch (Exception ignored) { }
            try { engine.shutdown(); } catch (Exception ignored) { }
        }
        // 关掉所有在途 WebSocket
        for (WebSocket ws : sockets.values()) {
            try { ws.cancel(); } catch (Exception ignored) { }
        }
        sockets.clear();
        jobs.clear();
    }
}
