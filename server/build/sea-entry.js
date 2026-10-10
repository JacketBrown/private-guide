/**
 * 打包入口（build/sea-entry.js）
 *
 * 与 server/index.js 的区别：
 *   单文件 exe 里没有真实的 web/ 目录可读，静态资源必须在打包时内联进来。
 *   本文件在打包阶段读取 web/ 全部文件 → 生成内存映射 → 用中间件直接吐出去，
 *   因此 exe 是真正自包含的，拷到任何地方都能跑。
 *
 * 开发调试不要用这个入口，用 server/index.js。
 */

const path = require('path');
const express = require('express');

// 打包时由 esbuild 的 define 注入：{ "/index.html": {t:"text/html",b:"<base64>"}, ... }
// eslint-disable-next-line no-undef
const WEB_ASSETS = typeof __WEB_ASSETS__ !== 'undefined' ? __WEB_ASSETS__ : null;

const cfg = require('../config');
const { CONFIG } = cfg;
const { recognize, resolveByName } = require('../services/recognize');
const { generateGuide } = require('../services/guide');
const { collectMaterials } = require('../services/research');
const tts = require('../services/tts');
const paths = require('../paths');

const app = express();
app.use(express.json({ limit: '20mb' }));

// ---------- CORS ----------
app.use((req, res, next) => {
  const allow = process.env.ALLOW_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Config-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- 请求日志 ----------
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${req.method} ${req.path}`);
  }
  next();
});

// ---------- 静态资源（内联）----------
function serveEmbedded(req, res, relPath) {
  if (!WEB_ASSETS) return false;
  let key = relPath === '/' || relPath === '' ? '/index.html' : relPath;
  const asset = WEB_ASSETS[key];
  if (!asset) return false;
  res.setHeader('Content-Type', asset.t);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(Buffer.from(asset.b, 'base64'));
  return true;
}

app.get(/^(?!\/api\/).*/, (req, res, next) => {
  const rel = req.path;
  if (serveEmbedded(req, res, rel)) return;
  // 未知路径 → 回首页（SPA 行为）
  if (serveEmbedded(req, res, '/index.html')) return;
  next();
});

// ---------- API ----------

/** 地址发现 */
app.get('/api/endpoint', (req, res) => {
  const explicit = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const derived = explicit || `${proto}://${req.get('host')}`;
  res.json({
    ok: true,
    data: {
      baseUrl: derived,
      app: 'private-guide',
      version: '1.3',
      provider: CONFIG.provider,
      modelVision: CONFIG.modelVision,
      modelText: CONFIG.modelText,
      serverTime: new Date().toISOString(),
    },
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    provider: CONFIG.provider,
    modelVision: CONFIG.modelVision,
    modelText: CONFIG.modelText,
    baseUrl: CONFIG.baseUrl,
    hasKey: Boolean(CONFIG.apiKey),
    packaged: Boolean(paths.IS_PACKAGED),
  });
});

app.get('/api/config', (req, res) => {
  res.json({ ok: true, data: cfg.snapshot() });
});

app.post('/api/config', (req, res) => {
  const requiredToken = process.env.CONFIG_TOKEN;
  if (requiredToken) {
    const got = req.get('X-Config-Token') || '';
    if (got !== requiredToken) {
      return res.status(401).json({ ok: false, error: '配置修改口令错误' });
    }
  }
  const result = cfg.update(req.body || {});
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true, data: cfg.snapshot() });
});

app.post('/api/config/test', async (req, res) => {
  const result = await cfg.selfTest();
  res.json({ ok: true, data: result });
});

app.post('/api/recognize', async (req, res) => {
  const { image, images, hint = '' } = req.body || {};
  let list = [];
  if (Array.isArray(images)) list = images.filter(Boolean);
  else if (image) list = [image];

  if (!list.length) return res.status(400).json({ ok: false, error: '缺少图片数据' });

  const valid = list.filter((img) => typeof img === 'string' && img.startsWith('data:image')).slice(0, 6);
  if (!valid.length) {
    if (hint) {
      const result = await resolveByName(hint);
      return res.json({ ok: true, data: result });
    }
    return res.status(400).json({ ok: false, error: '图片格式不正确，需为 dataURL' });
  }

  try {
    const result = await recognize(valid, hint);
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error('[recognize] 失败：', err.message);
    res.status(500).json({
      ok: false,
      error: '识别失败，请重试或手动输入地点名称',
      detail: String(err.message).slice(0, 300),
    });
  }
});

app.post('/api/guide', async (req, res) => {
  const { pointName, locationHint = '', plaqueText = '', skipResearch = false } = req.body || {};
  if (!pointName || !String(pointName).trim()) {
    return res.status(400).json({ ok: false, error: '缺少点位名称' });
  }
  try {
    const result = await generateGuide({
      pointName: String(pointName).trim(),
      locationHint: String(locationHint).trim(),
      plaqueText: String(plaqueText).trim(),
      skipResearch: Boolean(skipResearch),
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error('[guide] 失败：', err.message);
    res.status(500).json({ ok: false, error: '讲解生成失败，请重试', detail: String(err.message).slice(0, 300) });
  }
});

app.get('/api/research', async (req, res) => {
  const { name, location = '' } = req.query;
  if (!name) return res.status(400).json({ ok: false, error: '缺少 name 参数' });
  try {
    const result = await collectMaterials(String(name), String(location));
    res.json({
      ok: true,
      data: {
        hasMaterial: result.hasMaterial,
        materials: result.materials.map((m) => ({
          title: m.title,
          source: m.source,
          url: m.url,
          length: m.text.length,
          preview: m.text.slice(0, 200),
        })),
        sources: result.sources,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message) });
  }
});

app.post('/api/nearby', async (req, res) => {
  const { pointName, locationHint = '' } = req.body || {};
  if (!pointName) return res.status(400).json({ ok: false, error: '缺少 pointName' });
  try {
    const guide = await generateGuide({ pointName, locationHint });
    res.json({ ok: true, data: { nearby: guide.nearby || [] } });
  } catch (err) {
    res.json({ ok: true, data: { nearby: [] } });
  }
});

app.get('/api/tts/voices', async (req, res) => {
  try {
    const voices = await tts.listVoices();
    res.json({ ok: true, data: { voices, default: tts.DEFAULT_VOICE } });
  } catch (err) {
    console.error('[tts/voices] 失败：', err.message);
    res.status(500).json({ ok: false, error: '音色列表获取失败' });
  }
});

app.post('/api/tts', async (req, res) => {
  const { text, voice = '', rate, pitch, volume } = req.body || {};
  const clean = String(text || '').trim();
  if (!clean) return res.status(400).json({ ok: false, error: '缺少合成文本' });
  if (clean.length > 2000) return res.status(400).json({ ok: false, error: '单次合成文本过长' });

  try {
    const { buffer, voice: used } = await tts.synthesize(clean, voice, { rate, pitch, volume });
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(buffer.length),
      'Cache-Control': 'no-store',
      'X-TTS-Voice': used,
    });
    res.send(buffer);
  } catch (err) {
    console.error('[tts] 失败：', err.message);
    res.status(502).json({ ok: false, error: '语音合成失败，请降级系统音色', detail: String(err.message).slice(0, 200) });
  }
});

// ---------- 启动 ----------

function lanIP() {
  const os = require('os');
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    if (/virtual|vmware|vbox|docker|wsl|hyper-v|loopback|bluetooth|vethernet|tap|tun|atrust/i.test(name)) continue;
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const ip = net.address;
      const isPrivate =
        /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
      if (!isPrivate) continue;
      const score = /^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : 2;
      candidates.push({ ip, score });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates.length ? candidates[0].ip : '127.0.0.1';
}

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  const { spawn } = require('child_process');
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    /* 不影响服务 */
  }
}

function listenWithFallback(startPort, maxTries = 10) {
  let port = startPort;
  let tries = 0;
  const tryListen = () => {
    const server = app.listen(port, () => onReady(port));
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && tries < maxTries) {
        tries += 1;
        port += 1;
        tryListen();
      } else {
        console.error('  启动失败：', err.message);
        process.exit(1);
      }
    });
  };
  tryListen();
}

function onReady(port) {
  const local = `http://localhost:${port}`;
  const lan = `http://${lanIP()}:${port}`;
  const line = '─'.repeat(50);

  console.log('');
  console.log(`  ┌${line}┐`);
  console.log('  │   私人 AI 导游 — 服务已启动                        │');
  console.log(`  ├${line}┤`);
  console.log(`  │   本机访问：${local.padEnd(38)}│`);
  console.log(`  │   手机访问：${lan.padEnd(38)}│`);
  console.log(`  │   （手机需与本机连同一个 WiFi）${' '.repeat(19)}│`);
  console.log(`  └${line}┘`);
  console.log('');
  console.log(`  服务商：${CONFIG.provider}  ·  识别 ${CONFIG.modelVision}  ·  生成 ${CONFIG.modelText}`);
  console.log(`  密钥：${CONFIG.apiKey ? '已配置 ' + cfg.snapshot().keyMask : '未配置 ✗ 请在网页「服务设置」里填写'}`);
  console.log('');
  console.log('  换密钥 / 换模型：网页右上角「服务设置」，改完即时生效，无需重启。');
  console.log('');
  console.log('  ⚠  关闭本窗口即停止服务。');

  if (!CONFIG.apiKey) {
    console.log('');
    console.log('  ➜ 首次使用：浏览器打开上面的地址 → 右上角齿轮 → 服务设置 → 填密钥');
  }

  openBrowser(local);
}

listenWithFallback(CONFIG.port);
