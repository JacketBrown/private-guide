/**
 * 前端配置中心 —— 全部设置都保存在本机（localStorage），随改随生效
 *
 * 两种运行形态共用同一份代码：
 *   ① App（手机上）—— 直连模式：用户自己填密钥 / 接口地址 / 模型，
 *      由 engine.js 用原生网络直接访问 AI 服务，不需要任何后端。
 *   ② Web / 局域网 —— 中转模式：填一个后端地址，密钥留在后端更安全。
 *
 * 优先级（高 → 低）：
 *   用户在本机设置里填的值  >  打包时内置的默认值（web/env.js）  >  空
 *
 * 换密钥 / 换模型不需要重新打包 —— 都在 App 内的「模型设置」里改。
 */

const AppConfig = (() => {
  // ---------- 存储 key ----------
  const KEY_BASE = 'private_guide_base_url_v1'; // 可选：中转后端地址
  const KEY_FIRST_RUN = 'private_guide_first_run_v1';
  const KEY_LLM = 'private_guide_llm_v1'; // 直连模式：密钥/地址/模型

  // ---------- 打包内置默认值（由 web/env.js 提供） ----------
  function builtin(name) {
    try {
      const c = (typeof window !== 'undefined' && window.APP_CONFIG) || {};
      return String(c[name] || '').trim();
    } catch (e) {
      return '';
    }
  }

  function readLS(key, def = '') {
    try {
      return localStorage.getItem(key) || def;
    } catch (e) {
      return def;
    }
  }
  function writeLS(key, val) {
    try {
      if (val === '' || val === null || val === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, String(val));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ============================================================
  //  一、后端地址（中转模式，可选）
  // ============================================================

  function normalize(url) {
    const s = String(url || '').trim();
    if (!s) return '';
    if (s === '/') return '';
    const withProto = /^https?:\/\//i.test(s) ? s : `http://${s}`;
    return withProto.replace(/\/+$/, '');
  }

  function savedBase() {
    return readLS(KEY_BASE).trim();
  }

  /** 当前生效的后端地址（空字符串 = 不走后端，直连） */
  function base() {
    const saved = savedBase();
    if (saved) return normalize(saved);
    const built = builtin('BASE_URL');
    if (built) return normalize(built);
    return '';
  }

  function baseSource() {
    if (savedBase()) return 'user';
    if (builtin('BASE_URL')) return 'builtin';
    return 'relative';
  }

  function setBase(url) {
    return writeLS(KEY_BASE, String(url || '').trim());
  }
  function clearBase() {
    return writeLS(KEY_BASE, '');
  }

  function url(path) {
    return base() + path;
  }

  // ============================================================
  //  二、模型设置（直连模式）—— 密钥 / 接口地址 / 模型
  // ============================================================

  /** 常见服务商预设，方便用户一键带出地址和模型名 */
  const PROVIDER_PRESETS = [
    {
      id: 'taotoken',
      name: 'TaoToken 中转',
      baseUrl: 'https://api.taotoken.net/v1',
      modelVision: 'glm-5.3-flash',
      modelText: 'deepseek-v4-pro',
      hint: '国内直连的聚合中转，按量付费',
    },
    {
      id: 'dashscope',
      name: '阿里云百炼（通义）',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      modelVision: 'qwen-vl-max',
      modelText: 'qwen-max',
      hint: '国内直连，新用户有免费额度',
    },
    {
      id: 'deepseek',
      name: 'DeepSeek 官方',
      baseUrl: 'https://api.deepseek.com/v1',
      modelVision: 'deepseek-vl2',
      modelText: 'deepseek-chat',
      hint: '文本模型便宜，视觉模型需确认可用性',
    },
    {
      id: 'openai',
      name: 'OpenAI 官方',
      baseUrl: 'https://api.openai.com/v1',
      modelVision: 'gpt-4o',
      modelText: 'gpt-4o',
      hint: '需要能访问海外的网络环境',
    },
    {
      id: 'custom',
      name: '自定义（OpenAI 兼容）',
      baseUrl: '',
      modelVision: '',
      modelText: '',
      hint: '填任何 OpenAI 兼容接口，地址一般以 /v1 结尾',
    },
  ];

  /**
   * 读取模型设置
   * 优先级：本机设置 > 打包内置 > 空
   */
  function llm() {
    let saved = {};
    try {
      saved = JSON.parse(readLS(KEY_LLM, '{}')) || {};
    } catch (e) {
      saved = {};
    }
    return {
      provider: String(saved.provider || builtin('PROVIDER') || 'taotoken'),
      apiKey: String(saved.apiKey || builtin('API_KEY') || ''),
      baseUrl: String(saved.baseUrl || builtin('LLM_BASE_URL') || '').replace(/\/+$/, ''),
      modelVision: String(saved.modelVision || builtin('MODEL_VISION') || ''),
      modelText: String(saved.modelText || builtin('MODEL_TEXT') || ''),
    };
  }

  /**
   * 保存模型设置
   *
   * apiKey 的特殊语义：界面上是脱敏展示（sk-abc****xyz），用户不碰就原样提交，
   * 所以"空字符串 = 保持不变"；想真正清空必须显式传 clearApiKey: true。
   * （旧实现没有清空通道，用户换服务商时旧密钥会一直黏着。）
   */
  function saveLlm(patch = {}) {
    let saved = {};
    try {
      saved = JSON.parse(readLS(KEY_LLM, '{}')) || {};
    } catch (e) {
      saved = {};
    }
    const allowed = ['provider', 'apiKey', 'baseUrl', 'modelVision', 'modelText'];
    for (const k of allowed) {
      if (!(k in patch)) continue;
      const v = String(patch[k] == null ? '' : patch[k]).trim();
      if (k === 'apiKey') {
        if (patch.clearApiKey === true) { delete saved.apiKey; continue; }
        if (!v) continue;                // 空 = 不改
        // 前端把脱敏串原样提交回来时（含 ****），不要覆盖真实密钥
        if (v.includes('****')) continue;
      }
      saved[k] = v;
    }
    return writeLS(KEY_LLM, JSON.stringify(saved));
  }

  /** 是否已配置到可直连的状态 */
  function llmReady() {
    const c = llm();
    return Boolean(c.apiKey && c.baseUrl && c.modelVision && c.modelText);
  }

  /**
   * 密钥脱敏展示：sk-abcd****wxyz
   *
   * 短密钥（<=12 位）旧实现是 `s.slice(0,3) + '****'`，
   * 对 8 位的密钥就泄露了 37.5% 的字符，且尾部的 5 位直接裸奔。
   * 现在按长度分档：短密钥只留首尾各 2 位。
   */
  function maskKey(key) {
    const s = String(key || '');
    if (!s) return '';
    if (s.length <= 6) return '****';                       // 太短，全遮
    if (s.length <= 12) return `${s.slice(0, 2)}****${s.slice(-2)}`;
    return `${s.slice(0, 6)}****${s.slice(-4)}`;
  }

  function getPreset(id) {
    return PROVIDER_PRESETS.find((p) => p.id === id) || PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
  }

  // ============================================================
  //  三、首次运行引导
  // ============================================================

  function firstRunDone() {
    return readLS(KEY_FIRST_RUN) === '1';
  }
  function markFirstRunDone() {
    return writeLS(KEY_FIRST_RUN, '1');
  }

  // ============================================================
  //  四、运行环境与连通性
  // ============================================================

  /** 是否运行在 App / WebView 容器里 */
  function isNativeShell() {
    if (typeof window === 'undefined') return false;
    const p = window.location.protocol;
    if (p === 'file:' || p === 'capacitor:' || p === 'ionic:') return true;
    if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function') {
      try {
        return window.Capacitor.isNativePlatform();
      } catch (e) {
        /* ignore */
      }
    }
    if (/Capacitor|Cordova/i.test(navigator.userAgent || '')) return true;
    return false;
  }

  /** 探测某个后端地址是否可用（仅中转模式用） */
  async function probe(candidate) {
    const target = normalize(candidate !== undefined ? candidate : base());
    const started = Date.now();
    // AbortSignal.timeout 在部分老 WebView 上不存在；不兜底会导致探测无限挂起
    // （用户点了"测试连接"就一直转圈）。这里统一用 AbortController。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const resp = await fetch(`${target}/api/endpoint`, { signal: controller.signal });
      const ms = Date.now() - started;
      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json || json.ok !== true) return { ok: false, ms, error: `HTTP ${resp.status}` };
      if (json.data && json.data.app !== 'private-guide') {
        return { ok: false, ms, error: '该地址不是本应用的服务' };
      }
      return { ok: true, ms, info: json.data };
    } catch (e) {
      const ms = Date.now() - started;
      if (e && e.name === 'AbortError') return { ok: false, ms, error: '连接超时（8 秒）' };
      return { ok: false, ms, error: String(e.message || e).slice(0, 120) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function testAndSave(u) {
    const r = await probe(u);
    if (r.ok) setBase(u);
    return r;
  }

  return {
    // 后端地址（中转模式）
    base,
    url,
    baseSource,
    builtin,
    setBase,
    clearBase,
    normalize,
    probe,
    testAndSave,
    // 模型设置（直连模式）
    llm,
    saveLlm,
    llmReady,
    maskKey,
    getPreset,
    // 环境
    isNativeShell,
    firstRunDone,
    markFirstRunDone,
    // 常量
    PROVIDER_PRESETS,
  };
})();
