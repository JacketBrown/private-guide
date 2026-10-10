/**
 * 语音播报模块 —— 可插拔音色 provider 架构
 *
 * 两种 provider：
 *   system —— 浏览器内置 Web Speech API（离线、零成本、机械感）
 *   edge   —— 微软 Edge 在线神经音色（需联网、接近真人、免费）
 *             通过 WebSocket 直连 speech.platform.bing.com，
 *             不需要任何后端（见 scripts/edge-tts.js）
 *
 * 公共接口对所有 provider 一致，上层 app.js 无需感知差异：
 *   load(parts) / play() / pause() / stop() / jumpTo(i)
 *   getState() / getCurrentIndex() / getSentenceCount() / isSupported()
 *   on({sentenceChange, stateChange, progress})
 *
 * 音色相关：
 *   listProviders() / getProvider() / setProvider(id)
 *   listVoices()（当前 provider 的音色，异步）
 *   setVoiceByName(name) / getCurrentVoice() / preview()
 *
 * 兼容策略：
 *   若用户在设置里配了后端地址（局域网/云端中转），仍优先走 /api/tts；
 *   没配后端（App 直连模式）则走浏览器原生 WebSocket。
 */

const Speech = (() => {
  const systemSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  /** 后端地址（App 阶段为绝对地址，Web 阶段为 ''）。见 scripts/config.js */
  function backend(path) {
    const b = typeof AppConfig !== 'undefined' ? AppConfig.base() : '';
    return b + path;
  }

  /** 是否配置了后端 —— 配了就优先走后端（密钥不出本机），没配则直连 */
  function hasBackend() {
    try {
      return Boolean(typeof AppConfig !== 'undefined' && AppConfig.base());
    } catch (e) {
      return false;
    }
  }

  /** 直连模式是否可用（浏览器原生 WebSocket 版 Edge TTS） */
  function edgeDirectSupported() {
    return typeof EdgeTts !== 'undefined' && typeof WebSocket !== 'undefined';
  }

  let provider = 'system';   // system | edge
  let sentences = [];
  let currentIndex = 0;
  let state = 'idle';        // idle | playing | paused
  let onSentenceChange = null;
  let onStateChange = null;
  let onProgress = null;
  let onNotice = null; // 面向用户的提示（如"高清音色失败已降级"）

  // ---------- 存储 key ----------
  const KEY_PROVIDER = 'private_guide_provider_v1';
  const KEY_SYS_VOICE = 'private_guide_voice_v1';
  const KEY_EDGE_VOICE = 'private_guide_edge_voice_v1';

  function readLS(k, d = '') {
    try {
      return localStorage.getItem(k) || d;
    } catch (e) {
      return d;
    }
  }
  function writeLS(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (e) {
      /* ignore */
    }
  }

  // ============================================================
  //  provider: system（Web Speech API）
  // ============================================================

  const EMOTIONAL_VOICE_HINTS = [
    'Xiaoxiao', '晓晓', 'Xiaoyi', '晓伊', 'Yunxi', '云希', 'Yunyang', '云扬',
    'Yunjian', '云健', 'Xiaochen', '晓辰', 'Yunxia', '云夏',
    'Huihui', '慧慧', 'Yaoyao', '瑶瑶', 'Kangkang', '康康',
    'Tingting', '婷婷', 'Meijia', '美佳', 'Sinji',
    'Google 普通话', 'Google 國語',
    'Natural', 'Neural', 'Online',
  ];

  function scoreVoice(v) {
    const name = `${v.name} ${v.voiceURI}`;
    for (let i = 0; i < EMOTIONAL_VOICE_HINTS.length; i++) {
      if (name.includes(EMOTIONAL_VOICE_HINTS[i])) return 100 - i;
    }
    return v.localService ? 10 : 20;
  }

  function isChinese(v) {
    return /^zh|Chinese|Mandarin|中文|普通话|國語/i.test(`${v.lang} ${v.name}`);
  }

  let sysVoice = null;
  let sysVoicesCache = [];

  function listSystemVoices() {
    if (!systemSupported) return [];
    const all = window.speechSynthesis.getVoices();
    const zh = all.filter(isChinese);
    const pool = zh.length ? zh : all;
    sysVoicesCache = pool
      .map((v) => ({ voice: v, score: scoreVoice(v) }))
      .sort((a, b) => b.score - a.score)
      .map((x) => ({
        voice: x.voice,
        name: x.voice.name.replace(/\s*\(.*?\)\s*/g, '').trim(),
        lang: x.voice.lang,
        emotional: x.score >= 50,
        id: x.voice.name, // system 用 voice.name 作 id
      }));
    return sysVoicesCache;
  }

  function pickSystemVoice() {
    const list = listSystemVoices();
    if (!list.length) return null;
    const saved = readLS(KEY_SYS_VOICE);
    if (saved) {
      const hit = list.find((v) => v.name === saved);
      if (hit) return hit.voice;
    }
    return list[0].voice;
  }

  // ============================================================
  //  provider: edge（Edge 在线神经音色，走本地 /api/tts）
  // ============================================================

  const EDGE_FALLBACK_VOICES = [
    { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: '女', desc: '温暖亲切，最适合讲解' },
    { id: 'zh-CN-YunxiNeural', name: '云希', gender: '男', desc: '阳光活泼，年轻感' },
    { id: 'zh-CN-YunjianNeural', name: '云健', gender: '男', desc: '沉稳有力，适合历史讲述' },
    { id: 'zh-CN-XiaoyiNeural', name: '晓伊', gender: '女', desc: '灵动俏皮' },
    { id: 'zh-CN-YunyangNeural', name: '云扬', gender: '男', desc: '专业可靠，播报感' },
    { id: 'zh-CN-YunxiaNeural', name: '云夏', gender: '男', desc: '可爱童声' },
    { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北', gender: '女', desc: '东北口音，幽默' },
    { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮', gender: '女', desc: '陕西口音，爽朗' },
  ];

  const EDGE_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
  let edgeVoicesCache = null;   // 从后端拉取后缓存
  let edgeVoice = readLS(KEY_EDGE_VOICE, EDGE_DEFAULT_VOICE);

  async function listEdgeVoices() {
    if (edgeVoicesCache) return edgeVoicesCache;
    // 有后端就走后端（能拿到最新音色清单）；否则用内置清单（直连模式）
    if (hasBackend()) {
      try {
        const res = await fetch(backend('/api/tts/voices'));
        const json = await res.json();
        if (json && json.ok && json.data && Array.isArray(json.data.voices)) {
          edgeVoicesCache = json.data.voices;
          return edgeVoicesCache;
        }
      } catch (e) {
        /* 拉取失败，用本地清单兜底 */
      }
    }
    edgeVoicesCache = EDGE_FALLBACK_VOICES.map((v) => ({ ...v, available: true }));
    return edgeVoicesCache;
  }

  // Edge 播放器：复用单个 <audio>，逐句合成并顺序播放
  const edgeAudio = typeof Audio !== 'undefined' ? new Audio() : null;
  let edgeAbort = null;        // AbortController，句切换时取消在途请求
  let edgeSynthCache = new Map(); // 句子 → objectURL，避免重复合成
  let edgeFailStreak = 0;      // 连续合成失败计数（用于快速降级，避免"无声滑过"）
  const EDGE_FAIL_LIMIT = 2;   // 连续失败这么多次就切换系统音色
  let degradeToken = 0;        // 降级延时令牌：用户期间有操作则作废该次自动续播
  let jumpToken = 0;           // 跳句延时令牌：连续跳转时只有最后一次生效
  let previewToken = 0;        // 试听代际令牌：新试听/停止后旧回调不再生效

  // 原生系统 TTS（Android addJavascriptInterface 桥）的挂起回调表
  let nativeSysBound = false;
  let nativeSysSeq = 0;
  const nativeSysPending = new Map();

  // 预取下一句音频：key = `${voice}::${text}` → Promise<objectURL|null>
  const prefetchPending = new Map();
  const prefetchAborts = new Set();

  /** 系统音色是否可用：WebView 的 speechSynthesis 或 原生 android.speech.tts 任一 */
  function sysAvailable() {
    return systemSupported ||
      (typeof window !== 'undefined' && window.NativeEdgeTts &&
        typeof window.NativeEdgeTts.sysSpeak === 'function');
  }

  /** 用可用的系统音色读一段文字（WebView speechSynthesis 优先，否则原生） */
  function speakSystemOnce(text) {
    const spoken = normalizeForSpeech(text);
    if (typeof window !== 'undefined' && window.NativeEdgeTts &&
        typeof window.NativeEdgeTts.sysSpeak === 'function' && !systemSupported) {
      const reqId = 'p' + Date.now();
      try { window.NativeEdgeTts.sysSpeak(reqId, spoken); } catch (e) { /* ignore */ }
      return;
    }
    if (!systemSupported) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(spoken);
    u.lang = 'zh-CN';
    u.rate = 0.96;
    u.pitch = 1.04;
    if (sysVoice) u.voice = sysVoice;
    window.speechSynthesis.speak(u);
  }

  if (edgeAudio) {
    // 关键：只监听「播完」，不要在这里推进下一句 ——
    // 当前实现是 playEdgeAt 里合成完成后再调用 play()，
    // 若同时监听 ended 推进，会造成双重推进（句子被跳过）。
    edgeAudio.addEventListener('timeupdate', () => {
      if (state !== 'playing') return;
      const d = edgeAudio.duration;
      if (d && isFinite(d) && onProgress) {
        onProgress(currentIndex, Math.min(0.98, edgeAudio.currentTime / d));
      }
    });
    edgeAudio.addEventListener('error', () => {
      // 音频源坏了：不静默跳过，交给 playEdgeAt 的错误通道处理
      if (state === 'playing') {
        edgeFailStreak += 1;
        if (onSentenceChange) onSentenceChange(currentIndex);
        setTimeout(() => speakAt(currentIndex + 1), 120);
      }
    });
  }

  /**
   * 连续失败太多 → 说明高清音色在本机不可用（网络被墙 / 鉴权被拒），
   * 立刻切回系统音色继续读完，而不是让整篇无声地"滑"过去。
   */
  function degradeToSystem(reason) {
    console.warn('[speech] 高清音色不可用，降级系统音色：', reason);
    edgeFailStreak = 0;
    const wasPlaying = state === 'playing';
    const resumeAt = currentIndex;   // 从当前句继续，而不是回到第 0 句
    stop();
    provider = 'system';
    writeLS(KEY_PROVIDER, 'system');
    if (!sysVoice) sysVoice = pickSystemVoice();
    if (onStateChange) onStateChange('idle');
    if (onNotice) {
      try {
        onNotice('高清音色连续失败，已自动切换为系统音色');
      } catch (_) { /* ignore */ }
    }
    if (wasPlaying) {
      // 用"代际令牌"防止降级延时里用户又点了停止/跳转：
      // 旧写法无条件在 120ms 后把 state 拉回 playing 并从 0 重启，
      // 会把用户刚刚的停止操作直接覆盖掉。
      const token = ++degradeToken;
      setTimeout(() => {
        if (token !== degradeToken) return;      // 期间又发生了变更 → 放弃
        if (state !== 'idle') return;            // 用户已手动操作 → 不抢
        state = 'playing';
        if (onStateChange) onStateChange('playing');
        speakAt(Math.min(resumeAt, Math.max(0, sentences.length - 1)));
      }, 120);
    }
  }

  /** 抛 AbortError（与 fetch 被取消时的行为一致，便于上层统一判断） */
  function abortError() {
    try {
      return new DOMException('Aborted', 'AbortError');
    } catch (e) {
      const err = new Error('已取消');
      err.name = 'AbortError';
      return err;
    }
  }

  /** 请求单句音频，返回 objectURL（有后端走代理，无后端走 WebSocket 直连） */
  async function fetchEdgeAudio(text, signal) {
    const spoken = normalizeForSpeech(text);
    const cacheKey = `${edgeVoice}::${spoken}`;
    const hit = edgeSynthCache.get(cacheKey);
    if (hit) return hit;

    let blob;
    if (hasBackend()) {
      const res = await fetch(backend('/api/tts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: spoken, voice: edgeVoice }),
        signal,
      });
      if (!res.ok) throw new Error(`TTS ${res.status}`);
      blob = await res.blob();
    } else {
      if (!edgeDirectSupported()) throw new Error('当前环境不支持语音直连');
      // 语速略慢、音调略高 → 娓娓道来，不机械
      blob = await EdgeTts.synthesize(
        spoken,
        edgeVoice,
        { rate: '-4%', pitch: '+2Hz', volume: '+0%' },
        signal,
      );
    }
    if (!blob || !blob.size) throw new Error('音频为空');

    // 关键：合成/下载期间可能已被 abort（切句、停止、换音色）。
    // 此时若仍然 createObjectURL 并写进缓存，会造成两个后果：
    //   ① 缓存被"用户已经不要了"的音频污染；② objectURL 永远没人 revoke，内存泄漏。
    if (signal && signal.aborted) throw abortError();

    const url = URL.createObjectURL(blob);
    // 双检：插入缓存的瞬间若已被取消，立刻回收并抛出
    if (signal && signal.aborted) {
      URL.revokeObjectURL(url);
      throw abortError();
    }
    edgeSynthCache.set(cacheKey, url);
    return url;
  }

  /**
   * 预取下一句音频 —— 这是消除"段落之间十秒空档"的关键。
   *
   * 之前每句都要「合成完 → 才开始播」，句间空档 = 整句的合成耗时（长句 5-10 秒）。
   * 现在当前句一开始播，就并行合成下一句；等它播完时下一句通常已就绪，空档降到接近 0。
   *
   * 注意：预取**不能**复用 edgeAbort —— 那个 signal 在跳句/停止时会被 abort，
   * 会连带掐掉预取。这里用独立的 controller，并在停止时统一放弃。
   */
  function prefetchNext(index) {
    const next = index + 1;
    if (next >= sentences.length) return;
    const spoken = normalizeForSpeech(sentences[next]);
    const key = `${edgeVoice}::${spoken}`;
    if (edgeSynthCache.has(key)) return;         // 已缓存，无需预取
    if (prefetchPending.has(key)) return;        // 已在路上

    const ctrl = new AbortController();
    prefetchAborts.add(ctrl);
    const p = fetchEdgeAudio(sentences[next], ctrl.signal)
      .catch(() => null)                          // 预取失败无所谓，正式播时会重试
      .finally(() => {
        prefetchPending.delete(key);
        prefetchAborts.delete(ctrl);
      });
    prefetchPending.set(key, p);
  }

  /** 放弃所有在途预取（停止/切歌/换音色时调用） */
  function dropPrefetch() {
    prefetchAborts.forEach((c) => {
      try { c.abort(); } catch (e) { /* ignore */ }
    });
    prefetchAborts.clear();
    prefetchPending.clear();
  }

  /**
   * 等一句音频就绪（正在预取则等它，否则现取）。
   * 换成"等预取"而不是"重新合成"，是空档缩短的核心。
   *
   * 注意：等待在途预取时必须**同时监听本函数的 signal** ——
   * 预取用的是独立 controller，不受 edgeAbort 控制；
   * 若在这里盲目 await，跳句/停止后本函数会一直挂到预取自然结束。
   */
  async function ensureAudio(text, signal) {
    const key = `${edgeVoice}::${normalizeForSpeech(text)}`;
    const cached = edgeSynthCache.get(key);
    if (cached) return cached;

    const inflight = prefetchPending.get(key);
    if (inflight) {
      // 让"等预取"这件事也能被 signal 打断
      let onAbort = null;
      const url = await new Promise((resolve) => {
        let done = false;
        const settle = (v) => {
          if (done) return;
          done = true;
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
          resolve(v);
        };
        onAbort = () => settle(ABORTED);
        if (signal) {
          if (signal.aborted) return settle(ABORTED);
          signal.addEventListener('abort', onAbort, { once: true });
        }
        inflight.then((u) => settle(u || null), () => settle(null));
      });
      if (url === ABORTED) throw abortError();
      if (url) return url;   // 预取成功，直接用
      // 预取失败 → 落到下面现取一次
    }
    return fetchEdgeAudio(text, signal);
  }

  /** ensureAudio 内部用于标记"等预取期间被取消"的哨兵值 */
  const ABORTED = Symbol('aborted');

  async function playEdgeAt(index) {
    if (!edgeAudio) {
      // 极端降级：无 Audio 支持
      state = 'idle';
      if (onStateChange) onStateChange('idle');
      return;
    }
    const text = sentences[index];

    let url;
    try {
      // 同一时刻只允许一个在途正式请求（跳句时取消上一句）
      if (edgeAbort) edgeAbort.abort();
      edgeAbort = new AbortController();
      url = await ensureAudio(text, edgeAbort.signal);
    } catch (e) {
      if (e && e.name === 'AbortError') return; // 被新的跳句打断，正常
      // 失败时若已切走（跳句/停止），这条失败属于旧句，不能推进、也不该计入降级
      if (state !== 'playing' || currentIndex !== index) return;
      // 合成失败：累计计数，过多就整体降级系统音色（避免"无声滑过"）
      console.warn('[speech] edge 合成失败：', e.message);
      edgeFailStreak += 1;
      if (edgeFailStreak >= EDGE_FAIL_LIMIT && sysAvailable()) {
        degradeToSystem(e.message);
        return;
      }
      if (state === 'playing') {
        if (onSentenceChange) onSentenceChange(index);
        const token = ++jumpToken;
        setTimeout(() => {
          if (token !== jumpToken || state !== 'playing' || currentIndex !== index) return;
          speakAt(index + 1);
        }, 120);
      }
      return;
    }

    // 请求返回时若已切走，丢弃
    if (state !== 'playing' || currentIndex !== index) return;

    edgeAudio.src = url;
    try {
      await edgeAudio.play();
      edgeFailStreak = 0; // 播成功了，清零
      // 成功起播后才预取下一句：避免失败时的无谓请求
      prefetchNext(index);
    } catch (e) {
      // play() 被拒（自动播放策略 / 音频解码失败）：同样计入失败
      console.warn('[speech] edge 播放失败：', e && e.message);
      if (state !== 'playing' || currentIndex !== index) return;   // 已被跳走/停止
      edgeFailStreak += 1;
      if (edgeFailStreak >= EDGE_FAIL_LIMIT && sysAvailable()) {
        degradeToSystem((e && e.message) || 'play rejected');
        return;
      }
      if (state === 'playing') speakAt(index + 1);
      return;
    }

    // 播完 → 推进下一句（唯一推进点，避免与 ended 监听重复推进）
    // 必须校验 currentIndex === index：用户可能在播放中途点了跳转，
    // 此时 edgeAudio 的 ended 仍会触发（旧 src），不加校验会"多推一句"。
    edgeAudio.onended = () => {
      if (state !== 'playing' || currentIndex !== index) return;
      if (onProgress) onProgress(index, 1);
      speakAt(index + 1);
    };
  }

  // ============================================================
  //  统一调度：speakAt 按 provider 分派
  // ============================================================

  function speakAt(index) {
    if (state === 'idle') return;

    if (index >= sentences.length) {
      state = 'idle';
      currentIndex = 0;
      if (onProgress) onProgress(-1, 0);
      if (onStateChange) onStateChange('idle');
      return;
    }

    currentIndex = index;
    if (onSentenceChange) onSentenceChange(index);

    if (provider === 'edge') {
      playEdgeAt(index);
    } else {
      speakSystemAt(index);
    }
  }

  // ---------- system 播报（含无 boundary 时的估时降级）----------
  let estimateTimer = null;
  let estimateElapsed = 0;
  let currentEstimateDuration = 0;

  function estimateDuration(text) {
    return Math.max(1.2, text.length / 4.6);
  }
  function clearEstimate() {
    if (estimateTimer) {
      clearInterval(estimateTimer);
      estimateTimer = null;
    }
  }
  function startEstimate(text) {
    clearEstimate();
    estimateElapsed = 0;
    currentEstimateDuration = estimateDuration(text);
    estimateTimer = setInterval(() => {
      estimateElapsed += 0.2;
      if (onProgress) onProgress(currentIndex, Math.min(0.99, estimateElapsed / currentEstimateDuration));
      if (estimateElapsed >= currentEstimateDuration) clearEstimate();
    }, 200);
  }

  function speakSystemAt(index) {
    const text = sentences[index];

    // 原生系统 TTS：安卓 WebView 的 speechSynthesis 在很多国产 ROM 上拿不到任何 voice，
    // 走 android.speech.tts 原生引擎可用性远好于 WebView 版
    const native = typeof window !== 'undefined' && window.NativeEdgeTts &&
      typeof window.NativeEdgeTts.sysSpeak === 'function';
    if (native) {
      if (!nativeSysBound) {
        nativeSysBound = true;
        window.__nativeSysDone = function (reqId, err) {
          const cb = nativeSysPending.get(reqId);
          if (!cb) return;
          nativeSysPending.delete(reqId);
          cb(err);
        };
      }
      const reqId = 's' + ++nativeSysSeq + '_' + Date.now();
      startEstimate(text);
      // 兜底计时器：原生侧若因为引擎异常/ROM 限制既不回 onDone 也不回 onError，
      // 这里按估算时长 + 放宽系数强制推进，避免整篇讲解卡死在某一句。
      const budgetMs = (estimateDuration(text) + 12) * 1000;
      const guardTimer = setTimeout(() => {
        const cb = nativeSysPending.get(reqId);
        if (!cb) return;
        nativeSysPending.delete(reqId);
        console.warn('[speech] 原生系统 TTS 回调超时，强制推进');
        cb(null);
      }, budgetMs);
      nativeSysPending.set(reqId, (err) => {
        clearTimeout(guardTimer);
        clearEstimate();
        if (state !== 'playing') return;
        // 用户可能已跳走：此时该回调属于"旧句"，绝不能推进
        if (currentIndex !== index) return;
        if (err) {
          console.warn('[speech] 原生系统 TTS 失败：', err);
        }
        if (onProgress) onProgress(index, 1);
        speakAt(index + 1);
      });
      try {
        window.NativeEdgeTts.sysSpeak(reqId, normalizeForSpeech(text));
      } catch (e) {
        clearTimeout(guardTimer);
        nativeSysPending.delete(reqId);
        clearEstimate();
        if (state === 'playing' && currentIndex === index) speakAt(index + 1);
      }
      return;
    }

    if (!systemSupported) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'zh-CN';
    if (sysVoice) utter.voice = sysVoice;
    utter.rate = 0.94;
    utter.pitch = 1.06;
    utter.volume = 1;

    // 与 edge 路径同源的问题：cancel() 之后 onend/onerror 仍可能触发，
    // 若此时用户已跳句，就会"多推一句"。统一用 currentIndex === index 校验。
    const stillMine = () => state === 'playing' && currentIndex === index;

    let boundaryFired = false;
    utter.onboundary = (e) => {
      if (e.name === 'word' || e.name === 'sentence') {
        boundaryFired = true;
        clearEstimate();
        if (onProgress && e.charLength) {
          onProgress(index, Math.min(0.98, e.charIndex / Math.max(1, text.length)));
        }
      }
    };
    utter.onstart = () => {
      setTimeout(() => {
        if (!boundaryFired && stillMine()) startEstimate(text);
      }, 260);
    };
    utter.onend = () => {
      clearEstimate();
      if (stillMine()) {
        if (onProgress) onProgress(index, 1);
        speakAt(index + 1);
      }
    };
    utter.onerror = (e) => {
      clearEstimate();
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      console.warn('[speech] 系统音色错误：', e.error);
      if (stillMine()) speakAt(index + 1);
    };

    window.speechSynthesis.speak(utter);
  }

  // ============================================================
  //  公共 API
  // ============================================================

  function splitSentences(text) {
    return String(text || '')
      .split(/(?<=[。！？；…])/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function load(parts) {
    stop();
    sentences = Array.isArray(parts) ? parts.filter(Boolean) : splitSentences(parts);
    currentIndex = 0;
    edgeFailStreak = 0;   // 新一篇讲解重新计数，否则上一篇的失败会"欠账"到这一篇
    if (onProgress) onProgress(-1, 0);
  }

  function play() {
    if (!sentences.length) return;
    if (!isSupported()) return;
    if (state === 'playing') return;

    const wasPaused = state === 'paused';
    state = 'playing';
    if (onStateChange) onStateChange('playing');

    if (provider === 'system') {
      if (wasPaused) {
        window.speechSynthesis.resume();
        setTimeout(() => {
          if (!estimateTimer && state === 'playing') startEstimate(sentences[currentIndex] || '');
        }, 260);
        setTimeout(() => {
          if (state === 'playing' && !window.speechSynthesis.speaking) {
            window.speechSynthesis.cancel();
            speakAt(currentIndex);
          }
        }, 320);
      } else {
        speakAt(currentIndex);
      }
    } else {
      // edge：暂停后重播当前句
      playEdgeAt(currentIndex);
    }
  }

  function pause() {
    if (state !== 'playing') return;
    state = 'paused';
    if (provider === 'system') {
      if (systemSupported) {
        clearEstimate();
        window.speechSynthesis.pause();
      }
    } else if (edgeAudio) {
      edgeAudio.pause();
    }
    if (onStateChange) onStateChange('paused');
  }

  function stop() {
    state = 'idle';
    degradeToken++;   // 作废任何在途的"降级后自动续播"
    clearEstimate();
    // 原生系统 TTS 的停止**不分 provider** —— 降级过程中 provider 可能刚切成 system，
    // 而上一句用原生引擎播的还没停；只在 system 分支里清会导致残留朗读 + 回调表泄漏。
    stopNativeSys();
    if (provider === 'system') {
      if (systemSupported) window.speechSynthesis.cancel();
    } else if (edgeAudio) {
      edgeAudio.pause();
      edgeAudio.removeAttribute('src');
    }
    // 放弃所有在途预取，避免停止后还在后台合成
    dropPrefetch();
    if (edgeAbort) {
      try {
        edgeAbort.abort();
      } catch (e) {
        /* ignore */
      }
      edgeAbort = null;
    }
    currentIndex = 0;
    if (onStateChange) onStateChange('idle');
  }

  /** 停掉原生系统 TTS 并清空挂起回调（避免旧回调在下一句触发"双重推进"） */
  function stopNativeSys() {
    if (typeof window !== 'undefined' && window.NativeEdgeTts &&
        typeof window.NativeEdgeTts.sysStop === 'function') {
      try { window.NativeEdgeTts.sysStop(); } catch (e) { /* ignore */ }
    }
    nativeSysPending.clear();
  }

  function jumpTo(index) {
    if (index < 0 || index >= sentences.length) return;
    const wasPlaying = state === 'playing';
    state = 'idle';
    degradeToken++;   // 跳转后作废任何在途的自动续播，避免旧索引被播出来
    clearEstimate();

    if (provider === 'system') {
      // 跳句要连原生系统 TTS 一起停，否则上一句会继续读完再回调 → 双重推进
      stopNativeSys();
      if (systemSupported) window.speechSynthesis.cancel();
    } else if (edgeAudio) {
      edgeAudio.pause();
      if (edgeAbort) {
        try {
          edgeAbort.abort();
        } catch (e) {
          /* ignore */
        }
        edgeAbort = null;
      }
    }
    // 预取的是"旧顺序"的下一句，跳转后全无意义，必须一起放弃
    dropPrefetch();

    currentIndex = index;
    if (onSentenceChange) onSentenceChange(index);
    if (onProgress) onProgress(index, 0);

    if (wasPlaying) {
      const token = ++jumpToken;
      setTimeout(() => {
        if (token !== jumpToken) return;   // 期间又跳了一次 → 由最新那次接管
        if (state !== 'idle') return;      // 用户已手动操作 → 不抢
        state = 'playing';
        if (onStateChange) onStateChange('playing');
        speakAt(index);
      }, 130);
    } else {
      state = 'paused';
      if (onStateChange) onStateChange('paused');
    }
  }

  function getState() {
    return state;
  }
  function getCurrentIndex() {
    return currentIndex;
  }
  function getSentenceCount() {
    return sentences.length;
  }
  /** 任一 provider 可用即算支持（system 需要 API，edge 需要联网 Audio） */
  function isSupported() {
    if (provider === 'edge') {
      return Boolean(edgeAudio) && (hasBackend() || edgeDirectSupported());
    }
    return systemSupported;
  }

  // ---------- provider 管理 ----------

  const PROVIDERS = [
    { id: 'edge', name: '高清音色', desc: '微软神经音色，接近真人（推荐）', needNet: true },
    { id: 'system', name: '系统音色', desc: '设备自带，离线可用、机械感较强', needNet: false },
  ];
  function listProviders() {
    return PROVIDERS.map((p) => ({ ...p, active: p.id === provider }));
  }

  function getProvider() {
    return provider;
  }

  function setProvider(id) {
    if (!PROVIDERS.some((p) => p.id === id)) return false;
    if (id === provider) return true;
    stop();
    provider = id;
    edgeFailStreak = 0;   // 换了 provider，失败计数重新开始
    writeLS(KEY_PROVIDER, id);
    if (id === 'system' && !sysVoice) sysVoice = pickSystemVoice();
    if (onProgress) onProgress(-1, 0);
    return true;
  }

  /** 当前 provider 的音色列表（edge 为异步） */
  async function listVoices() {
    if (provider === 'edge') {
      const list = await listEdgeVoices();
      return list.map((v) => ({
        id: v.id,
        name: v.name,
        gender: v.gender,
        desc: v.desc,
        lang: 'zh-CN',
        emotional: true,
        active: v.id === edgeVoice,
        recommend: Boolean(v.recommend) || v.id === EDGE_DEFAULT_VOICE,
      }));
    }
    const list = listSystemVoices();
    const cur = getCurrentVoice();
    return list.map((v) => ({
      id: v.id,
      name: v.name,
      lang: v.lang,
      emotional: v.emotional,
      active: cur ? v.name === cur.name : false,
      recommend: v.emotional,
    }));
  }

  function getCurrentVoice() {
    if (provider === 'edge') {
      const hit = (edgeVoicesCache || EDGE_FALLBACK_VOICES).find((v) => v.id === edgeVoice);
      return { name: (hit && hit.name) || '晓晓', id: edgeVoice, lang: 'zh-CN' };
    }
    if (!sysVoice) return null;
    return { name: sysVoice.name.replace(/\s*\(.*?\)\s*/g, '').trim(), lang: sysVoice.lang, id: sysVoice.name };
  }

  function setVoiceByName(name) {
    if (provider === 'edge') {
      const pool = edgeVoicesCache || EDGE_FALLBACK_VOICES;
      const hit = pool.find((v) => v.id === name || v.name === name);
      if (!hit) return false;
      const old = edgeVoice;
      edgeVoice = hit.id;
      writeLS(KEY_EDGE_VOICE, edgeVoice);
      dropPrefetch();
      // 缓存 key 里含音色名，各音色的条目互不污染 ——
      // 只清旧音色的，别的音色预热好的试听保留（点谁谁秒出）。
      edgeSynthCache.forEach((u, k) => {
        if (k.startsWith(`${old}::`)) {
          try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ }
          edgeSynthCache.delete(k);
        }
      });
      // 立刻预热新音色的试听（万一还没被面板预热到）
      warmPreview(edgeVoice);
      return true;
    }
    const list = listSystemVoices();
    const hit = list.find((v) => v.name === name || v.id === name);
    if (!hit) return false;
    sysVoice = hit.voice;
    writeLS(KEY_SYS_VOICE, name);
    return true;
  }

  /**
   * 朗读前文本归一化 —— 修易错的变调字。
   *
   * 「一」在中文里变调规则复杂（yī / yí / yì），神经网络 TTS 偶尔读错。
   * 稳妥办法不是注音，而是**换一个不会读错的说法**。
   *
   * 用户反馈：把「一段」换成「有段」太别扭（"藏有段故事"不成话）。
   * 所以这里不再做"一段 → 有段"这种生硬替换，而是按语境换成自然的说法：
   *   藏着一段 → 藏着（直接删掉"一段"，句子照样通顺）
   *   一段……的故事 → 一个……的故事
   *   单独出现的「一段」→ 保留原样（说错概率低，比换成生硬词更好）
   */
  function normalizeForSpeech(text) {
    let s = String(text || '');

    // ① 先修用户明确反馈的那句（含上一版可能产生的中间态）
    s = s.replace(/藏着一段儿?/g, '藏着');
    s = s.replace(/藏着有段/g, '藏着');
    s = s.replace(/藏有段/g, '藏着');

    // ② 「一段 + 的 + 名词」→ 换成"一个"，读起来自然且无变调歧义
    s = s.replace(/一段(的)/g, '一个$1');

    // ③ 「一段」后接量词性名词（故事/往事/历史/传说/佳话…）→ 用"一个"
    s = s.replace(/一段(?=(故事|往事|历史|岁月|传奇|佳话|经历|渊源|公案))/g, '一个');

    // ④ 其余「一段」保留：如"走一段路""停一段"，换词反而更别扭
    return s;
  }

  /**
   * 试听文案 —— 短句优先：试听只是让用户听音色气质，
   * 句子越长合成越久（用户反馈"选完音色要等三四秒才有声音"）。
   * 12 字左右首次合成约 1 秒出头，配合音色面板的预热基本是秒出。
   */
  const PREVIEW_TEXT = '你好，我是你的私人导游。';

  /** 正在预热的试听请求（防止重复起任务） */
  const previewWarm = new Set();

  /**
   * 预热某个音色的试听音频 —— 音色列表渲染出来时就后台逐个合成好，
   * 用户点谁，谁的音频已经在缓存里，点击即刻出声。
   * 只预热试听这一句（每音色约 20KB），8 个音色全量也不到 200KB。
   */
  async function warmPreview(voiceName) {
    const v = voiceName || edgeVoice;
    const spoken = normalizeForSpeech(PREVIEW_TEXT);
    const key = `${v}::${spoken}`;
    if (edgeSynthCache.has(key) || previewWarm.has(key)) return;
    // 预热只走直连（App 场景）；有后端时试听本身走后端缓存，不必另起一套
    if (!edgeDirectSupported() || hasBackend()) return;
    previewWarm.add(key);
    try {
      const blob = await EdgeTts.synthesize(
        spoken,
        v,
        { rate: '-4%', pitch: '+2Hz', volume: '+0%' },
      );
      if (blob && blob.size) {
        edgeSynthCache.set(key, URL.createObjectURL(blob));
      }
    } catch (e) {
      /* 预热失败无所谓，正式点的时候会重试 */
    } finally {
      previewWarm.delete(key);
    }
  }

  /** 试听是否已在缓存里（供界面决定要不要提示"合成中"） */
  function previewCached() {
    return edgeSynthCache.has(`${edgeVoice}::${normalizeForSpeech(PREVIEW_TEXT)}`);
  }

  /** 试听（保持当前 provider） */
  function preview(text = PREVIEW_TEXT) {
    if (provider === 'edge') {
      if (!edgeAudio) return;
      if (!isSupported()) {
        // 直连与后端都不可用 → 临时用系统音色给个反馈，不让用户点了没反应
        speakSystemOnce(text);
        return;
      }
      // 试听用自己的代际令牌：主播放可能正在跑，试听起播后主播放的
      // 回调不该把试听"接管"掉，反之亦然。
      const token = ++previewToken;
      // 没预热到就明说，别让用户对着静默等 3 秒以为点了没反应
      if (!previewCached() && onNotice) {
        try { onNotice('正在合成试听…'); } catch (_) { /* ignore */ }
      }
      if (edgeAbort) {
        try {
          edgeAbort.abort();
        } catch (e) {
          /* ignore */
        }
      }
      edgeAbort = new AbortController();
      const wasState = state;
      state = 'idle';
      fetchEdgeAudio(text, edgeAbort.signal)
        .then((url) => {
          if (token !== previewToken) return null;   // 已被新的试听/停止取代
          edgeAudio.src = url;
          return edgeAudio.play();
        })
        .then(() => {
          if (token !== previewToken) return;
          state = wasState === 'playing' ? 'playing' : 'idle';
        })
        .catch((e) => {
          if (token !== previewToken) return;
          state = wasState;
          // 试听失败不能没反应：降级系统音色读一遍，并给用户可感知的提示
          console.warn('[speech] 试听失败，降级系统音色：', e && e.message);
          if (e && e.name === 'AbortError') return;  // 主动取消，不必提示
          if (onNotice) {
            try {
              onNotice('高清音色试听失败（' + ((e && e.message) || '网络原因') + '），已用系统音色播报');
            } catch (_) { /* ignore */ }
          }
          speakSystemOnce(text);
        });
      return;
    }
    if (!sysAvailable()) {
      if (onNotice) {
        try { onNotice('当前设备没有可用的系统音色'); } catch (_) { /* ignore */ }
      }
      return;
    }
    speakSystemOnce(text);
  }

  /**
   * 立刻掐断正在播/正在合成的试听（供"切换音色"用）。
   * 不走 stop()，因为 stop() 会把 state 复位、清空进度，不适合音色面板的场景。
   */
  function stopPreview() {
    previewToken++;   // 作废在途试听回调
    if (edgeAbort) {
      try { edgeAbort.abort(); } catch (e) { /* ignore */ }
      edgeAbort = null;
    }
    if (edgeAudio) {
      try {
        edgeAudio.pause();
        edgeAudio.removeAttribute('src');
      } catch (e) { /* ignore */ }
    }
    // 试听期间可能顺带起了预取，别让它继续占用网络
    dropPrefetch();
    // 原生系统 TTS 也停（试听时可能用的是系统音色）
    stopNativeSys();
    if (systemSupported) {
      try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    }
  }

  function on(handlers) {
    if (handlers.sentenceChange) onSentenceChange = handlers.sentenceChange;
    if (handlers.stateChange) onStateChange = handlers.stateChange;
    if (handlers.progress) onProgress = handlers.progress;
    if (handlers.notice) onNotice = handlers.notice;
  }

  // ---------- 初始化 ----------
  function init() {
    const savedProvider = readLS(KEY_PROVIDER);
    provider = savedProvider === 'system' || savedProvider === 'edge' ? savedProvider : 'edge';
    if (systemSupported) {
      sysVoice = pickSystemVoice();
      window.speechSynthesis.onvoiceschanged = () => {
        if (!sysVoice) sysVoice = pickSystemVoice();
      };
    }
    // 预热 edge 音色列表（失败无妨，兜底清单也可用）
    if (provider === 'edge') listEdgeVoices().catch(() => {});
  }

  init();

  return {
    // 播放控制（与旧接口一致）
    load,
    play,
    pause,
    stop,
    jumpTo,
    getState,
    getCurrentIndex,
    getSentenceCount,
    isSupported,
    splitSentences,
    on,
    // 音色 / provider
    listProviders,
    getProvider,
    setProvider,
    listVoices,
    setVoiceByName,
    getCurrentVoice,
    preview,
    stopPreview,
    warmPreview,
    previewCached,
    // 内部常量（调试用）
    _defaults: { EDGE_DEFAULT_VOICE, KEY_PROVIDER },
  };
})();
