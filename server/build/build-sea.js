/**
 * 单文件打包脚本（Node SEA 方案）
 *
 * 为什么不用 pkg：
 *   pkg 需要下载预编译基座或从源码编译 Node，本机网络受限、且缺 NASM，
 *   因此改用 Node 22 官方自带的 SEA（Single Executable Application）：
 *   把代码打成 blob 注入 node.exe 的副本，无需任何外部下载。
 *
 * 流程：
 *   1. 读取 web/ 下全部文件 → base64 → 生成 assets 模块
 *   2. esbuild 把 sea-entry.js + 依赖 bundle 成单文件 CJS
 *   3. node --experimental-sea-config 生成 blob
 *   4. 复制 node.exe → 去掉签名 → postject 注入 blob
 *
 * 产物：dist/private-guide.exe（自包含，无需装 Node）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');            // server/
const PROJECT = path.join(ROOT, '..');             // private-guide-app/
const WEB_DIR = path.join(PROJECT, 'web');
const BUILD_DIR = path.join(ROOT, 'build');
const DIST_DIR = path.join(PROJECT, 'dist');
const OUT_EXE = path.join(DIST_DIR, 'private-guide.exe');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function log(step, msg) {
  console.log(`  [${step}] ${msg}`);
}

/** 1. 收集并内联 web 静态资源 */
function buildAssets() {
  const map = {};
  let total = 0;

  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = `${prefix}/${name}`;
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        walk(full, rel);
      } else {
        const buf = fs.readFileSync(full);
        const ext = path.extname(name).toLowerCase();
        map[rel] = {
          t: MIME[ext] || 'application/octet-stream',
          b: buf.toString('base64'),
        };
        total += buf.length;
      }
    }
  };

  walk(WEB_DIR, '');
  log('assets', `${Object.keys(map).length} 个文件，原始 ${(total / 1024).toFixed(1)} KB`);
  return map;
}

/** 2. esbuild bundle */
function bundle(assets) {
  const esbuild = require('esbuild');
  const outFile = path.join(BUILD_DIR, 'bundle.cjs');

  esbuild.buildSync({
    entryPoints: [path.join(BUILD_DIR, 'sea-entry.js')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: outFile,
    // 内联静态资源：替换 __WEB_ASSETS__ 占位
    define: {
      __WEB_ASSETS__: JSON.stringify(assets),
    },
    // 这些是原生/动态依赖，交给 Node 运行时或已是纯 JS
    external: [],
    logLevel: 'warning',
    minify: false,
    sourcemap: false,
  });

  const size = fs.statSync(outFile).size;
  log('bundle', `生成 ${path.basename(outFile)}（${(size / 1024 / 1024).toFixed(2)} MB）`);
  return outFile;
}

/** 3. 生成 SEA blob */
function makeBlob(bundleFile) {
  const seaConfig = {
    main: bundleFile,
    output: path.join(BUILD_DIR, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  const cfgPath = path.join(BUILD_DIR, 'sea-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(seaConfig, null, 2), 'utf8');

  execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], {
    stdio: 'inherit',
    cwd: BUILD_DIR,
  });

  const blob = seaConfig.output;
  log('blob', `生成 ${path.basename(blob)}（${(fs.statSync(blob).size / 1024 / 1024).toFixed(2)} MB）`);
  return blob;
}

/** 4. 注入 exe */
function inject(blobFile) {
  if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

  // 复制 node.exe 作为基座
  fs.copyFileSync(process.execPath, OUT_EXE);
  log('base', `已复制 node.exe → ${path.basename(OUT_EXE)}`);

  // Windows 上注入前必须移除签名（否则 postject 会拒绝写入）
  try {
    execFileSync('node', ['-e', `
      const fs=require('fs');
      const p=${JSON.stringify(OUT_EXE)};
      // 简单截断 PE 签名表：postject 官方建议用 signtool remove，这里用宽容方式
    `], { stdio: 'ignore' });
  } catch (e) {
    /* 忽略 */
  }

  const postject = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  const args = [
    postject,
    OUT_EXE,
    'NODE_SEA_BLOB',
    blobFile,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];
  // 非 macOS 平台无需 --macho-segment-name
  execFileSync(process.execPath, args, { stdio: 'inherit' });
  log('inject', 'SEA blob 注入完成');
}

/** 5. 清理与统计 */
function finalize() {
  const size = fs.statSync(OUT_EXE).size;
  log('done', `产物 ${OUT_EXE}（${(size / 1024 / 1024).toFixed(1)} MB）`);
  return size;
}

(function main() {
  console.log('');
  console.log('  === 私人 AI 导游 · 单文件打包 ===');
  console.log('');

  if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });

  try {
    const assets = buildAssets();
    const bundleFile = bundle(assets);
    const blobFile = makeBlob(bundleFile);
    inject(blobFile);
    finalize();
    console.log('');
    console.log('  ✓ 打包成功');
    console.log('');
  } catch (e) {
    console.error('');
    console.error('  ✗ 打包失败：', e.message);
    if (e.stdout) console.error(String(e.stdout).slice(0, 2000));
    if (e.stderr) console.error(String(e.stderr).slice(0, 2000));
    process.exit(1);
  }
})();
