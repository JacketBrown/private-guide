/**
 * 模型调用客户端 —— 统一的 Chat Completions 封装
 *
 * 换密钥 / 换模型 / 换服务商：全部走 server/config.js，本文件不含任何硬编码配置。
 *   - 改 .env            → 重启生效
 *   - 改 /api/config 接口 → 立即热生效（App 内设置界面的实现基础）
 *
 * 注意：入口必须是兼容 OpenAI 的 /v1 地址；
 *      TaoToken 的 /token/v1（Token Plan）会返回 insufficient_quota，不要用。
 */

const { CONFIG } = require('../config');

/**
 * 底层 Chat Completions 调用
 * @param {Object} opts
 * @param {string} opts.model     模型名
 * @param {Array}  opts.messages  消息数组（OpenAI 兼容格式）
 * @param {boolean} opts.jsonMode 是否要求返回 JSON 对象
 * @param {number} opts.maxTokens
 * @param {number} opts.timeoutMs
 * @param {boolean} opts.thinking 是否启用思考模式（默认关闭，可大幅提速）
 * @returns {Promise<{content:string, usage:Object, model:string}>}
 */
async function chat({
  model,
  messages,
  jsonMode = false,
  maxTokens = 3000,
  timeoutMs = 120000,
  thinking = false,
}) {
  if (!CONFIG.apiKey) {
    throw new Error('未配置 API 密钥，请在 server/.env 或 App 设置中填写');
  }

  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.7,
    // 关闭思考模式：实测可把讲解生成从 100 秒级降到 20 秒级
    reasoning_effort: thinking ? 'high' : 'none',
  };
  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp;
  try {
    resp = await fetch(`${CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();

  if (!resp.ok) {
    const err = new Error(`模型调用失败 [${resp.status}] ${text.slice(0, 500)}`);
    err.status = resp.status;
    err.raw = text;
    throw err;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`模型返回非 JSON：[${text.slice(0, 300)}]`);
  }

  const choice = data.choices && data.choices[0];
  if (!choice) {
    throw new Error(`模型无返回内容：${text.slice(0, 300)}`);
  }

  return {
    content: choice.message?.content ?? '',
    usage: data.usage || null,
    model: data.model || model,
  };
}

/**
 * 容错 JSON 解析：模型有时会包在 ```json ``` 代码块里，或前后带解释文字
 */
function parseJsonLoose(text) {
  if (!text) throw new Error('内容为空，无法解析 JSON');

  let cleaned = String(text).trim();

  // 剥离 markdown 代码块
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cleaned = fence[1].trim();

  // 直接尝试
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    /* 继续尝试提取 */
  }

  // 提取第一个 { 到最后一个 }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const sliced = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(sliced);
    } catch (_) {
      /* 继续 */
    }
  }

  throw new Error(`无法解析模型返回的 JSON：${cleaned.slice(0, 300)}`);
}

module.exports = { CONFIG, chat, parseJsonLoose };
