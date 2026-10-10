/**
 * 语音合成服务（TTS）—— 基于微软 Edge 在线神经音色
 *
 * 为什么用 Edge 音色：
 *   Edge 浏览器内置的"大声朗读"用的是微软 Azure 神经网络音色（晓晓/云希等），
 *   情感自然、接近真人，且服务本身免费。TaoToken 中转只提供文本/视觉模型，
 *   没有 TTS 通道，所以这里独立接入。
 *
 * 设计要点：
 *   1. 逐句合成（与前端逐句播报对齐），返回 MP3 Buffer
 *   2. 音色列表带缓存，避免每次请求都拉取
 *   3. 失败时向上抛错，由前端降级回系统音色
 *   4. App 阶段可整体替换为云 TTS（阿里百炼 CosyVoice / 火山豆包），
 *      只需重写本模块的 synthesize()，接口不变
 */

const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

/** 输出格式：24kHz 48kbps 单声道 MP3，体积与音质的平衡点 */
const OUT_FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

/**
 * 推荐音色清单（按讲解场景排序）
 * 名字取自 Edge 音色库 ShortName，personality 用于前端展示
 */
const CURATED_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: '女', desc: '温暖亲切，最适合讲解', recommend: true },
  { id: 'zh-CN-YunxiNeural', name: '云希', gender: '男', desc: '阳光活泼，年轻感', recommend: true },
  { id: 'zh-CN-YunjianNeural', name: '云健', gender: '男', desc: '沉稳有力，适合历史讲述', recommend: true },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', gender: '女', desc: '灵动俏皮', recommend: false },
  { id: 'zh-CN-YunyangNeural', name: '云扬', gender: '男', desc: '专业可靠，播报感', recommend: false },
  { id: 'zh-CN-YunxiaNeural', name: '云夏', gender: '男', desc: '可爱童声', recommend: false },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北', gender: '女', desc: '东北口音，幽默', recommend: false },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮', gender: '女', desc: '陕西口音，爽朗', recommend: false },
];

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/** 音色 id 白名单（防止前端传入任意值导致请求异常） */
const VALID_IDS = new Set(CURATED_VOICES.map((v) => v.id));

/**
 * 列出可用中文音色（带缓存）
 * @returns {Promise<Array>}
 */
let voiceCache = null;
async function listVoices() {
  if (voiceCache) return voiceCache;
  try {
    const tts = new MsEdgeTTS();
    const all = await tts.getVoices();
    const zh = all.filter((v) => /^zh-CN/i.test(v.Locale));
    // 只保留白名单内的音色，并合并我们的描述信息
    const merged = CURATED_VOICES.map((c) => {
      const hit = zh.find((v) => v.ShortName === c.id);
      return { ...c, available: Boolean(hit) };
    });
    voiceCache = merged;
    return merged;
  } catch (e) {
    // 拉取失败时返回本地清单（仍然可尝试合成）
    return CURATED_VOICES.map((c) => ({ ...c, available: true }));
  }
}

/**
 * 合成一段文本为 MP3
 * @param {string} text 待合成文本
 * @param {string} [voiceId] 音色 id（默认晓晓）
 * @param {object} [opts] { rate, pitch, volume } 语速/音调/音量，如 '+0%' / '-4%'
 * @returns {Promise<{buffer: Buffer, voice: string}>}
 */
async function synthesize(text, voiceId, opts = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('合成文本为空');

  const voice = VALID_IDS.has(voiceId) ? voiceId : DEFAULT_VOICE;
  // Edge TTS 对单次请求文本长度有限制，超长需分段（按标点粗切，每段 <= 1200 字）
  const chunks = splitForTts(clean, 1200);

  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUT_FORMAT);

  // 韵律参数在 toStream 时传入
  const prosody = {
    rate: opts.rate || DEFAULT_PROSODY.rate,
    pitch: opts.pitch || DEFAULT_PROSODY.pitch,
    volume: opts.volume || DEFAULT_PROSODY.volume,
  };

  const buffers = [];
  try {
    for (const chunk of chunks) {
      const buf = await streamToBuffer(tts, chunk, prosody);
      buffers.push(buf);
    }
  } finally {
    try {
      tts.close();
    } catch (e) {
      /* 连接已关闭，忽略 */
    }
  }

  return { buffer: Buffer.concat(buffers), voice };
}

/** 默认韵律：语速略慢、音调略高 → 娓娓道来，不机械 */
const DEFAULT_PROSODY = { rate: '-4%', pitch: '+2Hz', volume: '+0%' };

/** 单段合成并收集为 Buffer */
function streamToBuffer(tts, text, prosody) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('语音合成超时'));
      }
    }, 30000);

    try {
      const { audioStream } = tts.toStream(text, prosody);
      audioStream.on('data', (d) => chunks.push(d));
      audioStream.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        if (!buf.length) {
          reject(new Error('语音合成为空'));
          return;
        }
        resolve(buf);
      });
      audioStream.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    }
  });
}

/** 按标点切成不超过 maxLen 的片段（尽量在句子边界断开） */
function splitForTts(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const parts = text.split(/(?<=[。！？；!?;\n])/);
  const out = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length > maxLen && buf) {
      out.push(buf);
      buf = '';
    }
    // 单句仍超长则硬切
    if (p.length > maxLen) {
      for (let i = 0; i < p.length; i += maxLen) out.push(p.slice(i, i + maxLen));
    } else {
      buf += p;
    }
  }
  if (buf) out.push(buf);
  return out.filter(Boolean);
}

module.exports = { synthesize, listVoices, splitForTts, DEFAULT_VOICE, CURATED_VOICES };
