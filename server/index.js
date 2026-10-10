/**
 * 私人 AI 导游 App —— 本地中转服务
 *
 * 职责：
 *   1. 隐藏 API 密钥（密钥只在服务端，前端拿不到）
 *   2. 代理模型调用（识别 / 生成）
 *   3. 托管前端静态页面（同源，避免 CORS）
 *
 * 启动：node index.js  或  npm start
 */

const path = require('path');
const express = require('express');
const paths = require('./paths');
const cfg = require('./config');
const { CONFIG } = cfg;
const { recognize, resolveByName } = require('./services/recognize');
const { generateGuide } = require('./services/guide');
const { collectMaterials } = require('./services/research');
const tts = require('./services/tts');

const app = express();

// 图片以 base64 传入，需要放宽 body 限制（手机原图约 3-8MB）
app.use(express.json({ limit: '20mb' }));

// ---------- CORS（App / 分域部署必需）----------
// Web 阶段同源访问不走这里；打包成 App 后前端可能来自 file:// 或 capacitor://，
// 属于跨域，必须放行。可用 ALLOW_ORIGIN 环境变量收窄到指定来源。
app.use((req, res, next) => {
  const allow = process.env.ALLOW_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 静态托管前端（路径兼容源码运行与 exe 打包，见 paths.js）
const WEB_DIR = paths.webDir();
app.use(express.static(WEB_DIR));

// 兜底：未知的非 API 路径一律回首页（App/WebView 单页行为更稳）
app.get(/^(?!\/api\/).*/, (req, res, next) => {
  const index = path.join(WEB_DIR, 'index.html');
  res.sendFile(index, (err) => {
    if (err) next();
  });
});

// 简易请求日志
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${req.method} ${req.path}`);
  }
  next();
});

/**
 * 后端地址发现（App 打包后极重要）
 *
 * 前端在"服务地址"里填了一个 base 后，会请求 {base}/api/endpoint 做连通性验证。
 * 返回的 baseUrl 是服务端认为的对外可用地址：
 *   - 显式配置 PUBLIC_BASE_URL 时用它（云部署 / 局域网 IP 场景）
 *   - 否则用请求本身的 Host 反推（同一台机器访问时总是对的）
 * 这样用户只需填一次，后续换 key / 换模型都不需要动前端。
 */
app.get('/api/endpoint', (req, res) => {
  const explicit = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const derived = explicit || `${proto}://${req.get('host')}`;
  res.json({
    ok: true,
    data: {
      baseUrl: derived,
      app: 'private-guide',
      version: '1.2',
      provider: CONFIG.provider,
      modelVision: CONFIG.modelVision,
      modelText: CONFIG.modelText,
      serverTime: new Date().toISOString(),
    },
  });
});

/** 健康检查 */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    provider: CONFIG.provider,
    modelVision: CONFIG.modelVision,
    modelText: CONFIG.modelText,
    baseUrl: CONFIG.baseUrl,
    hasKey: Boolean(CONFIG.apiKey),
  });
});

/**
 * 配置读取（脱敏，可安全暴露给前端）
 * GET /api/config
 */
app.get('/api/config', (req, res) => {
  res.json({ ok: true, data: cfg.snapshot() });
});

/**
 * 配置更新（换密钥 / 换服务商 / 换模型，热生效）
 * POST /api/config  body: { provider?, apiKey?, baseUrl?, modelVision?, modelText? }
 *
 * 安全说明：
 *   - apiKey 传空字符串表示"不修改"，避免误清空
 *   - 响应只回掩码，绝不回传明文
 *   - 生产环境建议加 ACCESS_TOKEN 校验（见 ALLOW_CONFIG_TOKEN）
 */
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

/**
 * 连通性自检：验证当前密钥 / 地址 / 模型是否真的可用
 * POST /api/config/test
 */
app.post('/api/config/test', async (req, res) => {
  const result = await cfg.selfTest();
  res.json({ ok: true, data: result });
});

/**
 * 图片识别（支持单张或多张）
 * POST /api/recognize
 * body: { images: ["data:image/jpeg;base64,...", ...], hint?: "用户补充描述" }
 *   兼容旧格式：{ image: "data:..." }
 */
app.post('/api/recognize', async (req, res) => {
  const { image, images, hint = '' } = req.body || {};

  // 归一化为数组
  let list = [];
  if (Array.isArray(images)) list = images.filter(Boolean);
  else if (image) list = [image];

  if (!list.length) {
    return res.status(400).json({ ok: false, error: '缺少图片数据' });
  }

  // 校验格式
  const valid = list
    .filter((img) => typeof img === 'string' && img.startsWith('data:image'))
    .slice(0, 6); // 与前端 MAX_IMAGES 对齐，避免请求体过大
  if (!valid.length) {
    // 无有效图片 + 有文字描述 → 直接按名称处理
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

/**
 * 讲解生成
 * POST /api/guide
 * body: { pointName, locationHint?, plaqueText?, skipResearch? }
 */
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
    res.status(500).json({
      ok: false,
      error: '讲解生成失败，请重试',
      detail: String(err.message).slice(0, 300),
    });
  }
});

/**
 * 资料检索（单独开放，便于调试和溯源展示）
 * GET /api/research?name=太和殿&location=北京故宫
 */
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

/**
 * 附近点位推荐
 * 原型阶段：由生成模型在 nearby 字段输出（不编造真实距离）
 * POST /api/nearby  body: { pointName, locationHint }
 */
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

/**
 * 高清音色列表（Edge 在线神经音色）
 * GET /api/tts/voices
 */
app.get('/api/tts/voices', async (req, res) => {
  try {
    const voices = await tts.listVoices();
    res.json({ ok: true, data: { voices, default: tts.DEFAULT_VOICE } });
  } catch (err) {
    console.error('[tts/voices] 失败：', err.message);
    res.status(500).json({ ok: false, error: '音色列表获取失败' });
  }
});

/**
 * 语音合成 —— 返回 MP3 音频流
 * POST /api/tts  body: { text, voice?, rate?, pitch? }
 *
 * 前端逐句播报时，对每句调用一次，拿到 MP3 后用 <audio> 播放。
 * 合成失败（网络等）返回 5xx，前端据此降级回系统音色。
 */
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

/** 取本机局域网 IP（手机同 WiFi 访问用） */
function lanIP() {
  const os = require('os');
  const nets = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(nets)) {
    // 跳过虚拟/隧道网卡（VMware/VirtualBox/Docker/WSL/蓝牙等常见干扰源）
    if (/virtual|vmware|vbox|docker|wsl|hyper-v|loopback|bluetooth|vethernet|tap|tun/i.test(name)) {
      continue;
    }
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const ip = net.address;
      // 只取私有网段（192.168 / 10. / 172.16-31），这些才是真实局域网地址
      const isPrivate =
        /^192\.168\./.test(ip) ||
        /^10\./.test(ip) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
      if (!isPrivate) continue;
      // 192.168 段最常见，排前面
      const score = /^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : 2;
      candidates.push({ ip, score });
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates.length ? candidates[0].ip : '127.0.0.1';
}

/** 自动打开浏览器（打包 exe 双击运行时体验更好） */
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
    /* 打不开浏览器不影响服务 */
  }
}

// ---------- 端口占用自动顺延 ----------
function listenWithFallback(app, startPort, maxTries = 10) {
  let port = startPort;
  let tries = 0;

  const tryListen = () => {
    const server = app.listen(port, () => onReady(port, server));
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && tries < maxTries) {
        tries += 1;
        port += 1;
        console.log(`  端口 ${port - 1} 被占用，改用 ${port} …`);
        setTimeout(tryListen, 120);
      } else {
        console.error('  启动失败：', err.message);
        process.exit(1);
      }
    });
  };

  tryListen();
}

function onReady(port, server) {
  const local = `http://localhost:${port}`;
  const lan = `http://${lanIP()}:${port}`;
  const line = '─'.repeat(52);

  console.log('');
  console.log(`  ┌${line}┐`);
  console.log('  │   私人 AI 导游 — 服务已启动                          │');
  console.log(`  ├${line}┤`);
  console.log(`  │   本机访问：${local.padEnd(40)}│`);
  console.log(`  │   手机访问：${lan.padEnd(40)}│`);
  console.log(`  │   （手机需与本机连同一个 WiFi）${' '.repeat(21)}│`);
  console.log('  └' + line + '┘');
  console.log('');
  console.log(`  服务商：${CONFIG.provider}  ·  识别 ${CONFIG.modelVision}  ·  生成 ${CONFIG.modelText}`);
  console.log(
    `  密钥：${CONFIG.apiKey ? '已配置 ' + cfg.snapshot().keyMask : '未配置 ✗ 请在网页「服务设置」里填写'}`,
  );
  console.log('');
  console.log('  换密钥 / 换模型：网页右上角「服务设置」，改完即时生效，无需重启。');
  console.log(`  配置文件位置：${cfg.RUNTIME_PATH}`);
  console.log('');
  console.log('  ⚠  关闭本窗口即停止服务，讲解也会中断。');

  if (!CONFIG.apiKey) {
    console.log('');
    console.log('  ➜ 首次使用：浏览器打开上面的地址 → 右上角齿轮 → 服务设置 → 填密钥');
  }

  openBrowser(local);
}

listenWithFallback(app, CONFIG.port);
