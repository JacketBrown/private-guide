/**
 * API 封装 —— 两种运行形态自动切换
 *
 * ① 直连模式（App 默认）：用户在「模型设置」里填了自己的密钥/地址/模型，
 *    由 engine.js 直接访问 AI 接口，不需要任何后端。
 * ② 中转模式（可选）：在设置里填了后端地址，则密钥留在后端，前端只调后端。
 *
 * 判断依据：AppConfig.base() 非空就走中转，否则走直连。
 * 上层 app.js 完全不用关心这件事，接口签名保持一致。
 */

const API = (() => {
  /**
   * 后端地址不再硬编码。
   * 为空字符串 ⇒ 直连模式（走 Engine）。
   */
  const BASE = () => (typeof AppConfig !== 'undefined' ? AppConfig.base() : '');

  /** 是否走中转后端 */
  function useBackend() {
    return Boolean(BASE());
  }

  /** 统一 POST（仅中转模式用） */
  async function post(path, body, timeoutMs = 180000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(BASE() + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // 先读文本再尝试解析：后端崩溃时返回的是 HTML 错误页，
      // 旧实现直接 .json() 会静默拿到 null，界面上只剩"请求失败（500）"，
      // 完全看不到真实原因（例如 PHP Fatal error 的堆栈）。
      const raw = await resp.text();
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        if (resp.ok) {
          throw new Error(`服务端返回了非 JSON 内容：${raw.slice(0, 200)}`);
        }
      }
      if (!resp.ok || !data || data.ok === false) {
        const msg = (data && data.error) || `请求失败（${resp.status}）${raw ? '：' + raw.slice(0, 200) : ''}`;
        throw new Error(msg);
      }
      return data.data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时，请检查网络后重试');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 识别图片（支持单张或多张）
   * @param {string|string[]} images 图片 dataURL
   * @param {string} hint 用户补充描述
   */
  function recognize(images, hint = '') {
    const list = Array.isArray(images) ? images : [images];
    if (useBackend()) return post('/api/recognize', { images: list, hint });
    if (!list.filter(Boolean).length) return Promise.resolve(Engine.resolveByName(hint));
    return Engine.recognize(list, hint);
  }

  /**
   * 生成讲解
   * @param {string} pointName 点位名
   * @param {string} locationHint 所属景区
   * @param {string} plaqueText 说明牌文字
   */
  function guide(pointName, locationHint = '', plaqueText = '', onStage) {
    if (useBackend()) return post('/api/guide', { pointName, locationHint, plaqueText });
    return Engine.generateGuide({ pointName, locationHint, plaqueText, onStage });
  }

  /** 健康检查：返回当前配置是否就绪（直连模式下等价于"本地检查"） */
  async function health() {
    if (useBackend()) {
      // 中转模式必须真的探一次：以前这里不 catch，
      // 后端没起来时抛异常会把调用方的 await 打断（界面上一片空白）。
      try {
        const resp = await fetch(BASE() + '/api/health');
        return await resp.json();
      } catch (e) {
        return { ok: false, mode: 'proxy', error: String((e && e.message) || e) };
      }
    }
    const c = Engine.cfg();
    // 直连模式没有"服务端"可问，ok 的含义是"本地配置是否填全"，
    // 不能无脑返回 true —— 否则密钥没填也显示"服务正常"。
    const ready = Boolean(c.apiKey && c.baseUrl && c.modelVision && c.modelText);
    return {
      ok: ready,
      mode: 'direct',
      provider: '直连（本机配置）',
      modelVision: c.modelVision,
      modelText: c.modelText,
      baseUrl: c.baseUrl,
      hasKey: Boolean(c.apiKey),
      error: ready ? '' : '模型设置未填写完整',
    };
  }

  /** 读取服务端配置（脱敏）—— 仅中转模式有意义 */
  async function getConfig() {
    if (!useBackend()) {
      const c = Engine.cfg();
      return {
        provider: c.baseUrl,
        providerName: '直连（本机配置）',
        baseUrl: c.baseUrl,
        modelVision: c.modelVision,
        modelText: c.modelText,
        hasKey: Boolean(c.apiKey),
        keyMask: AppConfig.maskKey(c.apiKey),
        providers: [],
        runtimeEditable: false,
      };
    }
    let resp;
    try {
      resp = await fetch(BASE() + '/api/config');
    } catch (e) {
      throw new Error(`读不到服务端配置：${(e && e.message) || e}`);
    }
    const json = await resp.json().catch(() => null);
    if (!json || json.ok !== true) throw new Error('配置读取失败');
    return json.data;
  }

  return { recognize, guide, health, getConfig, post, base: BASE, useBackend };
})();
