/**
 * 配置中心 —— 密钥 / 接口地址 / 模型的唯一管理入口
 *
 * 设计目标：换密钥、换模型、换服务商都不需要改代码、不需要重新打包。
 *
 * 三级优先级（后者覆盖前者）：
 *   1. 内置默认值（DEFAULTS）
 *   2. server/.env            ← 部署时的初始配置，随项目走
 *   3. server/data/config.json ← 运行时配置，通过 /api/config 接口修改，热生效
 *
 * 为什么要有第 3 层：
 *   Web 阶段改 .env 重启即可；但 App 打包后用户无法编辑 .env，
 *   必须在 App 内提供"设置"界面写 config.json，实现免打包换密钥。
 *
 * ⚠️ 安全边界：本文件只在服务端运行。密钥绝不通过 /api/config 的 GET 返回明文。
 */

const fs = require('fs');
const paths = require('./paths');

// ---------- 极简 .env 加载（避免额外依赖） ----------
/**
 * 读取 .env 文件，并与进程环境变量合并。
 * 优先级：真实环境变量（process.env）> .env 文件内容
 * 为什么合并 process.env：打包成 exe 后不便携带 .env，
 *   用户常用 `set LLM_API_KEY=xxx` 或在启动脚本里传参的方式配置。
 */
function loadEnv() {
  const fromFile = {};
  const envPath = paths.envPath();
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      fromFile[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }
  // 进程环境变量覆盖文件（便于 exe 场景）
  const merged = { ...fromFile };
  for (const key of [
    'PORT',
    'LLM_PROVIDER',
    'LLM_API_KEY',
    'LLM_BASE_URL',
    'MODEL_VISION',
    'MODEL_TEXT',
    'ALLOW_ORIGIN',
    'CONFIG_TOKEN',
    'PUBLIC_BASE_URL',
    // 兼容旧名
    'TAOTOKEN_API_KEY',
    'TAOTOKEN_BASE_URL',
  ]) {
    if (process.env[key]) merged[key] = process.env[key];
  }
  return merged;
}

// ---------- 服务商预设 ----------
/**
 * 换服务商时选一个 profile，只需再填 apiKey（和必要的 baseUrl）。
 * 所有预设都走 OpenAI 兼容协议，因此底层 client.js 不需要改。
 */
const PROVIDER_PRESETS = {
  taotoken: {
    name: 'TaoToken 中转（当前）',
    baseUrl: 'https://api.taotoken.net/v1',
    modelVision: 'glm-5.3-flash',
    modelText: 'deepseek-v4-pro',
    hint: '聚合中转，按量付费。换 key 只需在 taotoken 官网重新生成',
  },
  openai: {
    name: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    modelVision: 'gpt-4o',
    modelText: 'gpt-4o',
    hint: '需海外网络环境，注意识别模型必须支持图片输入',
  },
  dashscope: {
    name: '阿里云百炼（通义）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelVision: 'qwen-vl-max',
    modelText: 'qwen-max',
    hint: '国内直连，有免费额度。兼容 OpenAI 协议',
  },
  deepseek: {
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    modelVision: 'deepseek-vl2',
    modelText: 'deepseek-chat',
    hint: '文本模型性价比高；注意其视觉模型支持情况',
  },
  custom: {
    name: '自定义 / 自建代理',
    baseUrl: '',
    modelVision: '',
    modelText: '',
    hint: '填自己的 OpenAI 兼容地址（必须以 /v1 结尾），常用于自建后端',
  },
};

const DEFAULTS = {
  provider: 'taotoken',
  apiKey: '',
  baseUrl: PROVIDER_PRESETS.taotoken.baseUrl,
  modelVision: 'glm-5.3-flash',
  modelText: 'deepseek-v4-pro',
  port: 3000,
};

// ---------- 运行时配置文件（路径兼容 exe 打包，见 paths.js） ----------
const DATA_DIR = paths.DATA_DIR;
const RUNTIME_PATH = paths.RUNTIME_PATH;

function readRuntime() {
  try {
    if (!fs.existsSync(RUNTIME_PATH)) return {};
    return JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8')) || {};
  } catch (e) {
    console.warn('[config] 运行时配置读取失败，已忽略：', e.message);
    return {};
  }
}

function writeRuntime(obj) {
  try {
    paths.ensureDataDir();
    fs.writeFileSync(RUNTIME_PATH, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[config] 运行时配置写入失败：', e.message);
    return false;
  }
}

// ---------- 组装生效配置 ----------
const env = loadEnv();

/** 生效中的配置（可变） */
const CONFIG = {
  provider: DEFAULTS.provider,
  apiKey: '',
  baseUrl: '',
  modelVision: '',
  modelText: '',
  port: Number(env.PORT || DEFAULTS.port),
};

/** 从 env / runtime 重新计算生效配置 */
function refresh() {
  const runtime = readRuntime();

  // provider 决定 baseUrl / 模型名的默认值
  const provider = runtime.provider || env.LLM_PROVIDER || DEFAULTS.provider;
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;

  CONFIG.provider = provider;

  // 密钥：runtime > env
  CONFIG.apiKey = runtime.apiKey || env.LLM_API_KEY || env.TAOTOKEN_API_KEY || DEFAULTS.apiKey;

  // 地址：runtime > env > provider 预设
  CONFIG.baseUrl = (
    runtime.baseUrl ||
    env.LLM_BASE_URL ||
    env.TAOTOKEN_BASE_URL ||
    preset.baseUrl ||
    DEFAULTS.baseUrl
  ).replace(/\/$/, '');

  // 模型：runtime > env > provider 预设
  CONFIG.modelVision =
    runtime.modelVision || env.MODEL_VISION || preset.modelVision || DEFAULTS.modelVision;
  CONFIG.modelText = runtime.modelText || env.MODEL_TEXT || preset.modelText || DEFAULTS.modelText;

  return CONFIG;
}

refresh();

/**
 * 更新配置（来自 /api/config 接口）
 * 只接受白名单字段；apiKey 传空字符串表示"不修改"
 * @returns {{ok:boolean, error?:string}}
 */
function update(patch = {}) {
  const allowed = ['provider', 'apiKey', 'baseUrl', 'modelVision', 'modelText'];
  const runtime = readRuntime();
  let changed = false;

  for (const k of allowed) {
    if (!(k in patch)) continue;
    const v = String(patch[k] ?? '').trim();
    // apiKey 空值 = 保持原样（避免误清空）
    if (k === 'apiKey' && !v) continue;
    if (k === 'provider' && !PROVIDER_PRESETS[v]) {
      return { ok: false, error: `未知的服务商：${v}` };
    }
    runtime[k] = v;
    changed = true;
  }

  if (!changed) return { ok: true };

  if (!writeRuntime(runtime)) {
    return { ok: false, error: '配置写入失败（检查目录权限）' };
  }
  refresh();
  return { ok: true };
}

/** 脱敏后的配置快照（可安全返回给前端） */
function snapshot() {
  return {
    provider: CONFIG.provider,
    providerName: (PROVIDER_PRESETS[CONFIG.provider] || {}).name || CONFIG.provider,
    baseUrl: CONFIG.baseUrl,
    modelVision: CONFIG.modelVision,
    modelText: CONFIG.modelText,
    // 只回传掩码和是否存在，绝不回传明文
    hasKey: Boolean(CONFIG.apiKey),
    keyMask: maskKey(CONFIG.apiKey),
    providers: Object.entries(PROVIDER_PRESETS).map(([id, p]) => ({
      id,
      name: p.name,
      hint: p.hint,
      baseUrl: p.baseUrl,
      modelVision: p.modelVision,
      modelText: p.modelText,
    })),
    runtimeEditable: true,
  };
}

/** 密钥脱敏：sk-abcd****wxyz */
function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 12) return s.slice(0, 3) + '****';
  return `${s.slice(0, 6)}****${s.slice(-4)}`;
}

/** 连通性自检：用最小请求验证当前配置是否可用 */
async function selfTest() {
  const started = Date.now();
  try {
    const resp = await fetch(`${CONFIG.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${CONFIG.apiKey}` },
      signal: AbortSignal.timeout(20000),
    });
    const ms = Date.now() - started;
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return { ok: false, ms, error: `HTTP ${resp.status} ${t.slice(0, 200)}` };
    }
    const data = await resp.json().catch(() => null);
    const ids = Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
    return {
      ok: true,
      ms,
      modelCount: ids.length,
      hasVision: ids.some((id) => /vl|vision|glm-5|gpt-4o|omni/i.test(id)),
      hasText: ids.some((id) => id === CONFIG.modelText) || ids.length === 0,
      sample: ids.slice(0, 12),
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: String(e.message || e).slice(0, 200) };
  }
}

module.exports = {
  CONFIG,
  refresh,
  update,
  snapshot,
  selfTest,
  PROVIDER_PRESETS,
  RUNTIME_PATH,
};
