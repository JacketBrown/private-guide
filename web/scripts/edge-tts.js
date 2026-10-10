/**
 * 浏览器端 Edge TTS —— WebSocket 直连微软神经音色，无需任何后端
 *
 * 原理：
 *   Edge 浏览器的「大声朗读」走的是 speech.platform.bing.com 的 WebSocket 服务，
 *   协议公开、免费、音色接近真人（晓晓/云希/云健等）。
 *   服务端版本用 msedge-tts（Node 库）；这里用浏览器原生 WebSocket 重写，
 *   这样 App 里不需要后端也能拿到高质量音色。
 *
 * ⚠️ 握手鉴权（最容易踩的坑，逐条对齐微软现行校验）：
 *   1. Sec-MS-GEC 是 **SHA-256 大写十六进制**，不是裸 ticks：
 *        明文 = 取整到 5 分钟的 Windows file time ticks（100ns 单位）
 *               + TrustedClientToken
 *        摘要 = SHA256(明文).hex().toUpperCase()
 *      漏掉哈希这一步 → 握手必被 403 拒绝，且前端拿不到任何错误码（onerror 无信息）。
 *   2. 必须带 Cookie: muid=<32位随机大写hex>;，否则被风控拒绝
 *   3. ConnectionId 必须是无连字符的 UUID hex，且与 SSML 帧的 X-RequestId 分开
 *   4. X-Timestamp 是 JS 风格日期串（"Sat Oct 09 2026 12:00:00 GMT+0000 (Coordinated Universal Time)"），
 *      SSML 帧末尾还要再加一个 "Z" —— 这是微软自己的历史 bug，必须照抄
 *   5. Origin 用 Edge 大声朗读扩展的 chrome-extension:// ID
 *
 * 失败兜底：任何一环出错都 reject，由 speech.js 降级回系统音色，
 *   保证「听不了高清音色」不会导致整个 App 不可用。
 */

const EdgeTts = (() => {
  const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
  const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  const WSS_URL = `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;

  /** 模拟的浏览器版本（微软会校验，尽量跟官方库保持一致） */
  const CHROMIUM_FULL_VERSION = '143.0.3650.75';
  const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
  const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;

  /** Windows file time 纪元与 Unix 纪元的差（秒）；ticks 单位是 100 纳秒 */
  const WIN_EPOCH = 11644473600;
  const S_TO_NS = 1e9;

  /** 输出格式：24kHz 48kbps 单声道 MP3 —— 体积与音质的平衡点 */
  const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

  /**
   * 与微软服务端的时间偏移（秒）。
   *
   * 保持为 0 —— 依赖系统时间即可：Sec-MS-GEC 的窗口是 5 分钟，
   * 只有设备时钟偏差超过 ±5 分钟才会握手失败，正常设备不会出现。
   * （此前注释声称"403 后从 Date 头校正"，但代码从未实现，属误导，故更正。）
   */
  const clockSkewSeconds = 0;

  // ============================================================
  //  一、握手鉴权参数
  // ============================================================

  function nowUnix() {
    return Date.now() / 1000 + clockSkewSeconds;
  }

  /**
   * 生成 Sec-MS-GEC —— 必须先算 Windows file time ticks，再做 SHA-256 取大写十六进制。
   * 官方 SDK 会每日更新此策略，这里跟随 rany2/edge-tts 的实现。
   */
  function generateSecMsGec() {
    let ticks = nowUnix();
    ticks += WIN_EPOCH;             // 切到 Windows file time 纪元
    ticks -= ticks % 300;           // 向下取整到 5 分钟窗口
    ticks *= (S_TO_NS / 100);       // 换算成 100 纳秒单位
    const strToHash = `${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`;
    return sha256HexUpper(strToHash);
  }

  /**
   * 纯 JS SHA-256（同步、无依赖）。
   * 浏览器只有在 https / localhost 下才有 crypto.subtle，且它是异步的；
   * 为了能用同步方式生成 token，这里内置一份实现。
   */
  function sha256HexUpper(ascii) {
    const K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];

    // UTF-8 编码（token 本身是 ASCII，但保持通用）
    const bytes = [];
    for (let i = 0; i < ascii.length; i++) {
      const c = ascii.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }

    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    // 长度按 64 位大端写入（高 32 位对短字符串恒为 0）
    bytes.push(0, 0, 0, 0, (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    const w = new Array(64);
    const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

    for (let off = 0; off < bytes.length; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i++) {
        const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
        const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }

      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

      for (let i = 0; i < 64; i++) {
        const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        const ch = ((e & f) ^ (~e & g)) >>> 0;
        const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const t2 = (S0 + maj) >>> 0;

        h = g; g = f; f = e;
        e = (d + t1) >>> 0;
        d = c; c = b; b = a;
        a = (t1 + t2) >>> 0;
      }

      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }

    return [h0, h1, h2, h3, h4, h5, h6, h7]
      .map((x) => x.toString(16).padStart(8, '0'))
      .join('')
      .toUpperCase();
  }

  /** 32 位无连字符的随机 hex（ConnectionId / X-RequestId 用） */
  function connectId() {
    const a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** 32 位大写随机 hex（muid Cookie 用） */
  function generateMuid() {
    const a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  /** JS 风格日期串 —— 微软服务端按这个格式解析时间戳 */
  function dateToString() {
    const d = new Date(Date.now() + clockSkewSeconds * 1000);
    const W = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
      d.getUTCMonth()
    ];
    const p = (n) => String(n).padStart(2, '0');
    return (
      `${W} ${M} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ` +
      `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ` +
      `GMT+0000 (Coordinated Universal Time)`
    );
  }

  /** XML 转义，防止文本里的 & < > 破坏 SSML */
  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /** 微软服务端拒绝的控制字符（SSML 会解析失败） */
  function sanitize(text) {
    return String(text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
  }

  // ============================================================
  //  二、帧构造
  // ============================================================

  /** speech.config 帧：声明输出格式 */
  function speechConfigFrame() {
    return (
      `X-Timestamp:${dateToString()}\r\n` +
      'Content-Type:application/json; charset=utf-8\r\n' +
      'Path:speech.config\r\n\r\n' +
      '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
      '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"' +
      '},' +
      `"outputFormat":"${OUTPUT_FORMAT}"` +
      '}}}}\r\n'
    );
  }

  /** ssml 帧：要读的文本（X-RequestId 必须是新 id） */
  function ssmlFrame(text, voice, prosody = {}) {
    const rate = prosody.rate || '+0%';
    const pitch = prosody.pitch || '+0Hz';
    const volume = prosody.volume || '+0%';
    const ssml =
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
      `<voice name='${esc(voice)}'>` +
      `<prosody pitch='${esc(pitch)}' rate='${esc(rate)}' volume='${esc(volume)}'>` +
      `${esc(sanitize(text))}` +
      `</prosody></voice></speak>`;
    // 注意：这一行末尾的 Z 是微软自己的历史 bug，官方库照抄，我们也照抄
    return (
      `X-RequestId:${connectId()}\r\n` +
      'Content-Type:application/ssml+xml\r\n' +
      `X-Timestamp:${dateToString()}Z\r\n` +
      'Path:ssml\r\n\r\n' +
      ssml
    );
  }

  /** 二进制帧：前 2 字节大端 = 头部长度，之后是头部文本，再之后才是音频 */
  function parseBinaryFrame(buffer) {
    const view = new DataView(buffer);
    const headerLen = view.getUint16(0, false);
    const header = new TextDecoder('utf-8').decode(new Uint8Array(buffer, 2, headerLen));
    const audio = buffer.slice(2 + headerLen);
    return { header, audio };
  }

  // ============================================================
  //  三、合成
  // ============================================================

  /**
   * 合成一段文本 → MP3 Blob
   * @param {string} text 待合成文本
   * @param {string} voice 音色 ShortName，如 zh-CN-XiaoxiaoNeural
   * @param {Object} [prosody] { rate, pitch, volume } 如 '+0%' / '-4%' / '+2Hz'
   * @param {AbortSignal} [signal] 用于句切换时取消
   * @returns {Promise<Blob>}
   */
  function synthesize(text, voice, prosody = {}, signal) {
    // App 环境优先走原生桥（OkHttp，绕开 WebView WebSocket 的网络短板）；
    // 原生失败再退回 WebSocket（Web 调试环境用）。
    if (nativeBridge()) {
      return synthesizeNative(text, voice, prosody, signal).catch((err) => {
        console.warn('[edge-tts] 原生合成失败，降级 WebSocket：', err && err.message);
        return synthesizeWebSocket(text, voice, prosody, signal);
      });
    }
    return synthesizeWebSocket(text, voice, prosody, signal);
  }

  // ---------- 原生桥（Android addJavascriptInterface） ----------

  function nativeBridge() {
    return typeof window !== 'undefined' &&
      window.NativeEdgeTts &&
      typeof window.NativeEdgeTts.synthesize === 'function'
      ? window.NativeEdgeTts
      : null;
  }

  let nativeReqSeq = 0;
  const nativePending = new Map();

  // Java 侧回调入口
  window.__nativeTtsResult = function (reqId, err, b64) {
    const p = nativePending.get(reqId);
    if (!p) return;
    // 优先走 settle：它会顺带清掉 30 秒定时器与 abort 监听
    const finish = p.settle || ((e, blob) => {
      nativePending.delete(reqId);
      if (e) p.reject(e);
      else p.resolve(blob);
    });

    if (err) {
      finish(new Error(err));
      return;
    }
    // base64 → Blob
    try {
      finish(null, b64ToBlob(b64));
    } catch (e) {
      finish(new Error('音频解码失败'));
    }
  };

  /**
   * base64 字符串 → MP3 Blob
   *
   * 一句 200 字的中文讲解合成出来约 200-400 KB，base64 后约 270-540 KB 字符。
   * 一次性 atob 会先造出等长的二进制字符串、再造 Uint8Array，内存峰值约 3 倍；
   * 分段解码可以把峰值摊平，也避免单次超长字符串操作卡住主线程（会造成播放掉帧）。
   */
  const B64_CHUNK = 0x8000; // 必须是 4 的倍数，32768 满足
  function b64ToBlob(b64) {
    const s = String(b64 || '');
    const total = s.length;
    // 先算出解码后的总字节数，一次性分配
    const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
    const byteLen = Math.floor((total * 3) / 4) - pad;
    const out = new Uint8Array(byteLen > 0 ? byteLen : 0);

    let outPos = 0;
    for (let i = 0; i < total; i += B64_CHUNK) {
      const slice = s.substring(i, Math.min(i + B64_CHUNK, total));
      const bin = atob(slice);
      const n = bin.length;
      for (let j = 0; j < n; j++) out[outPos + j] = bin.charCodeAt(j);
      outPos += n;
    }
    return new Blob([outPos === byteLen ? out : out.subarray(0, outPos)], { type: 'audio/mpeg' });
  }

  function synthesizeNative(text, voice, prosody, signal) {
    const native = nativeBridge();
    if (!native) return Promise.reject(new Error('原生桥不可用'));

    return new Promise((resolve, reject) => {
      const reqId = 'n' + ++nativeReqSeq + '_' + Date.now();
      nativePending.set(reqId, { resolve, reject });

      let settled = false;
      let timer = null;

      /** 了结本次请求：清理挂起表 / 定时器 / abort 监听，保证只结算一次 */
      const settle = (err, blob) => {
        if (settled) return;
        settled = true;
        nativePending.delete(reqId);
        if (timer) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(blob);
      };

      // 取消：通知原生侧停止，并立即在 JS 侧了结
      const onAbort = () => {
        try { native.cancelSynth(reqId); } catch (e) { /* ignore */ }
        settle(new Error('已取消'));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }

      // 整体超时（原先这里既不 clearTimeout、也不摘 abort 监听，
      // 每合成一句就漏一个 30 秒定时器 + 一个常驻监听器，长讲解会持续堆积）
      timer = setTimeout(() => {
        try { native.cancelSynth(reqId); } catch (e) { /* ignore */ }
        settle(new Error('语音合成超时'));
      }, 30000);

      // 把 settle 暴露给回调入口：__nativeTtsResult 通过 nativePending 的
      // resolve/reject 走不到 settle 的清理逻辑，这里改挂一个钩子
      const entry = nativePending.get(reqId);
      if (entry) entry.settle = settle;

      try {
        native.synthesize(
          reqId,
          String(text || ''),
          String(voice || ''),
          String(prosody.rate || '+0%'),
          String(prosody.pitch || '+0Hz'),
        );
      } catch (e) {
        settle(new Error('原生调用失败'));
      }
    });
  }

  // ---------- WebSocket 直连（Web 调试用 / 原生失败后备） ----------

  function synthesizeWebSocket(text, voice, prosody = {}, signal) {
    return new Promise((resolve, reject) => {
      const clean = String(text || '').trim();
      if (!clean) return reject(new Error('文本为空'));

      const url =
        `${WSS_URL}&ConnectionId=${connectId()}` +
        `&Sec-MS-GEC=${generateSecMsGec()}` +
        `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        return reject(new Error('无法建立语音连接'));
      }
      ws.binaryType = 'arraybuffer';

      const chunks = [];
      let settled = false;
      let gotAudio = false;
      let turnEnded = false;

      // 整体超时（含建连），30 秒够一段话了
      const timer = setTimeout(() => finish(new Error('语音合成超时')), 30000);

      function cleanup() {
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        try {
          if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            ws.close();
          }
        } catch (e) {
          /* ignore */
        }
      }

      function finish(err, blob) {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(blob);
      }

      const onAbort = () => finish(new Error('已取消'));
      if (signal) {
        if (signal.aborted) return finish(new Error('已取消'));
        signal.addEventListener('abort', onAbort, { once: true });
      }

      ws.onopen = () => {
        try {
          ws.send(speechConfigFrame());
          ws.send(ssmlFrame(clean, voice, prosody));
        } catch (e) {
          finish(new Error('发送合成请求失败'));
        }
      };

      ws.onmessage = (ev) => {
        // 文本帧：鉴权失败会在这里露出（服务端发 response 里带错误信息）
        if (typeof ev.data === 'string') {
          const frame = ev.data;

          // 未授权 / 风控：明确报出来，方便排查而不是静默失败
          if (/Path:response/i.test(frame) && /(Unauthorized|Forbidden|403)/i.test(frame)) {
            return finish(new Error('语音服务拒绝访问（鉴权失败）'));
          }
          if (frame.includes('Path:turn.end')) {
            turnEnded = true;
            if (!gotAudio) return finish(new Error('没有收到音频数据'));
            finish(null, new Blob(chunks, { type: 'audio/mpeg' }));
          }
          return;
        }

        // 二进制帧：音频数据
        try {
          const { header, audio } = parseBinaryFrame(ev.data);
          if (header.includes('Path:audio') && audio && audio.byteLength) {
            gotAudio = true;
            chunks.push(audio);
          }
        } catch (e) {
          /* 忽略无法解析的帧 */
        }
      };

      ws.onerror = () => finish(new Error('语音连接出错'));
      ws.onclose = (e) => {
        if (settled) return;
        if (gotAudio) {
          // 音频已收全但没等到 turn.end（部分网络会提前断开），有音频就算成功
          finish(null, new Blob(chunks, { type: 'audio/mpeg' }));
        } else if (e && e.code === 1006) {
          finish(new Error('语音连接被拒绝（可能被限流，稍后重试）'));
        } else {
          finish(new Error(`语音连接已断开（${(e && e.code) || '-'}）`));
        }
      };

      // turnEnded 仅在调试时有用，保留引用避免被压缩器误删
      void turnEnded;
    });
  }

  /** 探测当前网络能否用 Edge TTS（合成一个"好"字） */
  async function available() {
    try {
      const blob = await synthesize('好', 'zh-CN-XiaoxiaoNeural', {});
      return blob && blob.size > 0;
    } catch (e) {
      return false;
    }
  }

  return {
    synthesize,
    available,
    OUTPUT_FORMAT,
    // 内部函数暴露出来便于单测/排查
    _internals: { generateSecMsGec, sha256HexUpper, connectId, dateToString, clockSkew: () => clockSkewSeconds },
  };
})();
