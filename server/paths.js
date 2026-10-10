/**
 * 运行时路径解析 —— 同时兼容「源码运行」和「单文件 exe 打包运行」
 *
 * 两种运行形态的差异：
 *   源码运行：__dirname = server/          → web 在 ../web，data 在 ./data
 *   exe 运行：代码被塞进虚拟快照，__dirname 指向快照内部（只读、不可写）
 *
 * 因此：
 *   - 只读资源（web 静态文件）→ 打包时嵌入快照，用 __dirname 相对路径即可读到
 *   - 可写数据（data/config.json、.env）→ 必须落在 exe 旁边的真实磁盘目录
 *
 * 判定方式：process.pkg 存在即为打包环境（pkg 注入的标记）。
 */

const path = require('path');
const fs = require('fs');

/** 是否运行在 pkg 打包的单文件里 */
const IS_PACKAGED = Boolean(process.pkg);

/**
 * 可写根目录（放 data/、.env、日志）
 *   打包后：exe 所在目录
 *   开发时：server/ 目录
 */
const WRITABLE_ROOT = IS_PACKAGED ? path.dirname(process.execPath) : __dirname;

/**
 * 只读资源根目录（web 静态文件、内置模板）
 *   打包后：快照内的 server/ 虚拟目录（pkg 会把 ../web 一起打进快照）
 *   开发时：server/ 目录
 */
const RESOURCE_ROOT = __dirname;

/** web 静态目录 */
function webDir() {
  const candidates = [
    path.join(RESOURCE_ROOT, '..', 'web'),
    path.join(WRITABLE_ROOT, 'web'),
    path.join(WRITABLE_ROOT, '..', 'web'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(path.join(p, 'index.html'))) return p;
    } catch (e) {
      /* 快照路径 existsSync 可用，忽略异常 */
    }
  }
  return candidates[0];
}

/** 可写数据目录 */
const DATA_DIR = path.join(WRITABLE_ROOT, 'data');

/** 运行时配置文件 */
const RUNTIME_PATH = path.join(DATA_DIR, 'config.json');

/** .env 路径（可写根目录优先，其次打包内默认） */
function envPath() {
  const local = path.join(WRITABLE_ROOT, '.env');
  try {
    if (fs.existsSync(local)) return local;
  } catch (e) {
    /* ignore */
  }
  return path.join(RESOURCE_ROOT, '.env');
}

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    return true;
  } catch (e) {
    console.error('[paths] 无法创建数据目录：', e.message);
    return false;
  }
}

module.exports = {
  IS_PACKAGED,
  WRITABLE_ROOT,
  RESOURCE_ROOT,
  DATA_DIR,
  RUNTIME_PATH,
  webDir,
  envPath,
  ensureDataDir,
};
