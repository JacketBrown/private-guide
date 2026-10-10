/**
 * 视觉识别服务 —— 识别用户拍到的建筑/文物是什么
 *
 * 流程：多张图片(base64 dataURL) → 视觉模型 → 结构化 JSON
 * 支持：主景图 + 说明牌/碑文等辅助图（辅助图上的文字会被提取为 plaqueText）
 * 换模型：改 server/.env 的 MODEL_VISION（必须支持 image_url 模态）
 */

const { CONFIG, chat, parseJsonLoose } = require('./client');

const RECOGNIZE_PROMPT = `你是一位中国景区建筑与文物识别专家。用户可能给你一张或多张图片：其中可能有景点本体的照片，也可能有景区说明牌、碑文、匾额、导览图，或者从不同角度/不同距离拍的同一点位。用户很可能是先拍了一张没认准，又补了几张求确认。

【任务】
1. 判断这处景点**属于哪个景区/地点**——这是最重要的信息，用户要靠它确认大方向。
2. 识别景点本体的**具体名称**——尽量细到具体建筑/文物（能认到"太和殿"就不要只写"宫殿"）。
3. 如果图片中有说明牌、碑文、匾额等含文字的图，把上面的关键文字提取到 plaqueText 字段。

【要求】
- 忽略路人、天空、树木等背景元素。
- 说明牌上的文字常常直接给出准确名称和所属景区，请优先采信。
- 多张图时综合全部线索判断：只要任意一张提供能定性的信息（文字、匾额、独特结构），就据此下结论，不要因为部分照片模糊而放弃。
- 如果只能认出所属景区、认不出具体点位，name 写景区名，confidence 降低。
- 完全无法识别（路灯、手掌、模糊画面）时，recognized 设为 false。
- 只返回 JSON，不要任何解释、不要 markdown 代码块。

【返回格式】
{
  "spot": "所属景区或地点，如'北京故宫'、'苏州寒山寺'；这是最重要的字段",
  "name": "景点的具体名称，如'太和殿'；认不出具体点位则填景区名",
  "confidence": 0.0 到 1.0 的置信度,
  "city": "所在城市，如'北京市'，不确定填空字符串",
  "category": "建筑/文物/雕塑/碑刻/自然景观/其他 之一",
  "plaqueText": "图片说明牌/碑文上的关键文字（如有），没有则填空字符串",
  "recognized": true 或 false,
  "reason": "简短说明判断依据，如'重檐庑殿顶，三层汉白玉基座'"
}`;

/**
 * 识别图片（支持多张）
 * @param {string[]} images 图片 dataURL 数组，第一张视为主景图
 * @param {string} [userHint] 用户手动描述（兜底时使用）
 * @returns {Promise<Object>} RecognitionResult
 */
async function recognize(images, userHint = '') {
  const list = Array.isArray(images) ? images.filter(Boolean) : [images].filter(Boolean);

  const userContent = [];

  if (userHint) {
    userContent.push({
      type: 'text',
      text: `用户补充说明：这是「${userHint}」。请优先参考该说明，并结合图片确认最准确的名称。`,
    });
  } else if (list.length > 1) {
    userContent.push({
      type: 'text',
      text:
        `我给了你 ${list.length} 张图：第 1 张是景点本体，其余可能包含说明牌、碑文、匾额，` +
        `也可能是从不同角度、不同距离拍的同一点位。` +
        `请把全部 ${list.length} 张图放在一起综合判断——只要任意一张里有能定性的线索` +
        `（说明牌文字、匾额、独特结构），就据此确定景点名称和所属景区，并提取说明牌上的文字。` +
        `不要因为某一张拍得模糊或离得远就放弃，线索可能在其他照片里。`,
    });
  } else {
    userContent.push({ type: 'text', text: '请识别这张图片中的主体建筑或文物，并判断所属景区。' });
  }

  for (const img of list) {
    userContent.push({
      type: 'image_url',
      image_url: { url: img },
    });
  }

  const { content, usage, model } = await chat({
    model: CONFIG.modelVision,
    messages: [
      { role: 'system', content: RECOGNIZE_PROMPT },
      { role: 'user', content: userContent },
    ],
    jsonMode: true,
    maxTokens: 700,
    timeoutMs: 120000,
    thinking: false,
  });

  let parsed;
  try {
    parsed = parseJsonLoose(content);
  } catch (e) {
    parsed = {
      spot: '',
      name: String(content).slice(0, 40).trim(),
      confidence: 0.3,
      city: '',
      category: '其他',
      plaqueText: '',
      recognized: false,
      reason: '模型返回格式异常，已降级处理',
    };
  }

  const spot = String(parsed.spot || '').trim();
  const name = String(parsed.name || '').trim();

  return {
    name,
    spot,
    city: String(parsed.city || '').trim(),
    confidence: Number(parsed.confidence) || 0,
    category: String(parsed.category || '').trim(),
    plaqueText: String(parsed.plaqueText || '').trim(),
    recognized: parsed.recognized !== false && Boolean(name || spot),
    reason: String(parsed.reason || '').trim(),
    _meta: { model, usage, imageCount: list.length },
  };
}

/**
 * 纯文本识别（用户在兜底态直接输入描述，无需看图）
 */
async function resolveByName(userDescription) {
  return {
    name: userDescription.trim(),
    spot: '',
    city: '',
    confidence: 1,
    category: '其他',
    plaqueText: '',
    recognized: true,
    reason: '由用户手动指定',
    _meta: { model: 'user-input', usage: null },
  };
}

module.exports = { recognize, resolveByName, RECOGNIZE_PROMPT };
