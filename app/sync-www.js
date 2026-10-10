/**
 * 同步 web 资源到 Capacitor 的 www/ 目录
 *
 * Capacitor 要求前端资源放在 webDir（这里配的是 www/）。
 * 我们把 private-guide-app/web/ 整体拷过去，
 * 同时为 App 环境覆盖一份 env.js。
 *
 * 用法：
 *   node sync-www.js
 *
 * 可用环境变量注入内置默认值（全部可选）：
 *   APP_BASE_URL     中转后端地址
 *   APP_PROVIDER     默认服务商 id
 *   APP_LLM_BASE_URL 默认接口地址
 *   APP_MODEL_VISION 默认识别模型
 *   APP_MODEL_TEXT   默认生成模型
 *
 * ⚠️ 不要把 API 密钥写进内置值 —— 随 APK 分发等于公开。
 */

const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname;
const SRC = path.join(APP_DIR, '..', 'web');
const DEST = path.join(APP_DIR, 'www');

const ENV_VALUES = {
  BASE_URL: process.env.APP_BASE_URL || '',
  PROVIDER: process.env.APP_PROVIDER || 'taotoken',
  LLM_BASE_URL: process.env.APP_LLM_BASE_URL || '',
  MODEL_VISION: process.env.APP_MODEL_VISION || '',
  MODEL_TEXT: process.env.APP_MODEL_TEXT || '',
  API_KEY: '', // 永远留空：密钥由用户在 App 内自己填
};

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

(function main() {
  if (!fs.existsSync(SRC)) {
    console.error('✗ 找不到 web 源目录：', SRC);
    process.exit(1);
  }

  console.log('  同步 web → www …');
  rmrf(DEST);
  copyDir(SRC, DEST);

  // 覆盖 env.js：写入打包时的内置默认值（用户填的优先级更高）
  const envContent = `/**
 * 打包时生成的默认值（由 sync-www.js 写入 —— 请勿手改 www/ 下的副本）
 * 用户在 App「模型设置」里填的值优先级更高，会覆盖这里。
 *
 * 安全提醒：API_KEY 恒为空，密钥只保存在用户手机本机。
 */
window.APP_CONFIG = ${JSON.stringify(ENV_VALUES, null, 2)};
`;
  fs.writeFileSync(path.join(DEST, 'env.js'), envContent, 'utf8');

  const count = (function walk(d) {
    let n = 0;
    for (const name of fs.readdirSync(d)) {
      const f = path.join(d, name);
      n += fs.statSync(f).isDirectory() ? walk(f) : 1;
    }
    return n;
  })(DEST);

  console.log(`  ✓ 已同步 ${count} 个文件到 www/`);
  console.log(`  内置后端地址：${ENV_VALUES.BASE_URL || '（空 → 直连模式）'}`);
  if (ENV_VALUES.MODEL_VISION) console.log(`  内置默认模型：${ENV_VALUES.MODEL_VISION} / ${ENV_VALUES.MODEL_TEXT}`);
  console.log('  API 密钥：不内置（用户装完后自行填写）');
})();
