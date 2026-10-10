/**
 * 讲解生成服务 —— 核心业务。把"点位名 + 真实资料"变成导游口播稿。
 *
 * 三层真实性保障中的第一层（生成时约束）和第三层（冲突降级）在这里实现。
 * 第二层（溯源托底）由 research.js 提供资料。
 *
 * 风格规格（用户确认）：标准版 500-800 字，混合风格（知识型骨架 + 说书人式提味）
 * 换模型：改 server/.env 的 MODEL_TEXT
 */

const { CONFIG, chat, parseJsonLoose } = require('./client');
const { collectMaterials } = require('./research');

/**
 * 位置规范化：把带城市前缀/模糊的位置提示拆成「纯景区名 + 城市」，
 * 并在缺失时推断。例：
 *   ("", "枫桥夜泊诗碑")           → { spot: "寒山寺", city: "苏州市" }
 *   ("苏州寒山寺", "...")          → { spot: "寒山寺", city: "苏州市" }
 * 百度百科是精确匹配，"苏州寒山寺"查不到而"寒山寺"能查到，此步是命中关键。
 */
async function normalizeLocation(pointName, rawHint = '') {
  const prompt =
    `景点/文物名：「${pointName}」${rawHint ? `，已知位置线索：「${rawHint}」` : ''}。` +
    `请给出它最可能所属的景区，只返回 JSON：` +
    `{"spot":"景区名（不含城市前缀，如'寒山寺'）","city":"城市名（如'苏州市'）"}。` +
    `推断不出时 spot 填空字符串。`;

  // 轻量调用偶发返回空，重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { content } = await chat({
        model: CONFIG.modelVision, // 轻量模型即可，省成本
        messages: [{ role: 'user', content: prompt }],
        jsonMode: true,
        maxTokens: 300,
        timeoutMs: 30000,
        thinking: false,
      });
      const parsed = parseJsonLoose(content);
      const spot = String(parsed.spot || '').trim();
      if (spot) return { spot, city: String(parsed.city || '').trim() };
      return { spot: '', city: '' };
    } catch (e) {
      console.warn(`[guide] 位置规范化失败（第 ${attempt + 1} 次）：`, e.message);
    }
  }
  return { spot: '', city: '' };
}

/** 构建生成 Prompt */
function buildGuidePrompt(pointName, materials, locationHint, mode = 'direct') {
  const materialBlock = materials.length
    ? materials
        .map((m, i) => `【资料 ${i + 1}：${m.source}「${m.title}」${m._tag === 'parent' ? '（上级景区资料）' : ''}】\n${m.text}`)
        .join('\n\n')
    : '（本次未检索到可用的参考资料）';

  // 细分点位无独立词条时的增强约束：景区资料 + 模型可靠知识
  const knowledgeRule = mode === 'parent'
    ? `
【本讲解对象的特殊性】
「${pointName}」是${locationHint || '该景区'}内的一处具体点位，百科中可能没有它的独立词条，上面的资料可能是它所在景区或现场说明牌的资料。
因此允许你补充使用你自己对这一具体点位的确切知识，但必须遵守：
1. 只讲你有把握的事实（广为人知的历史、与景区资料明显吻合的内容）。
2. 具体数字、生僻人物、小众传说：没把握就不讲，宁少勿错。
3. 与景区资料、现场说明牌冲突时，以资料和说明牌为准。
4. 讲解结尾不需要声明"这是景区资料"或"这是我的知识"，自然讲述即可。`
    : '';

  const plaqueRule = materials.some((m) => m._tag === 'plaque')
    ? `
【重要：现场说明牌】
参考资料中含有一份「现场说明牌」，那是景点官方的权威口径，其中提到的年代、名称、事件请优先采信并如实讲解。`
    : '';

  const strictness = mode === 'direct'
    ? '1. 只能使用【参考资料】中出现的信息。资料中没有提到的人物、年代、事件、数字，一律不许编造。'
    : '1. 以【参考资料】为主，辅以你对这一具体点位本身确切的知识。两方都没有的内容，一律不许编造。';

  return `你是一位知识渊博、说话有感染力的私人导游。现在你正站在游客身边，为他讲解眼前这处地方。

【讲解对象】${pointName}${locationHint ? `\n【所在位置】${locationHint}` : ''}

【参考资料】
${materialBlock}
${plaqueRule}
${knowledgeRule}

【硬性约束 —— 必须严格遵守】
${strictness}
2. 如果资料对某个事实存在争议，用"另有一说……"一句话带过，不要展开争论。
3. 如果参考资料和你自己的知识都不足以支撑讲解，就把 script 写成简短说明，并在 insufficient 字段标为 true，如实告诉用户目前缺乏可靠资料。
4. 不要出现"根据资料""据记载显示"这类生硬的引述腔，要自然地讲出来。

【风格要求】
- 总长度 500-800 字，正常语速朗读约 2-3 分钟。
- 开场：用一句有画面感或带悬念的话抓住注意力（说书人式），可以直接呼应眼前所见。
- 主体：按时间脉络讲清"这是什么、为什么重要、经历过什么"，表述严谨（知识型）。
- 结尾：留一个有意思的细节彩蛋，让人觉得"原来还有这一层"。
- 语言口语化，句子偏短，适合朗读，避免书面语长句和密集的数字堆砌。
- 使用"你"来称呼游客，营造一对一的陪伴感。

【输出格式】
只返回 JSON，不要 markdown 代码块，不要任何额外解释：
{
  "title": "讲解标题，12 字以内，有点击欲",
  "script": "完整讲解词，纯文本，用于语音播报，不可含 markdown 符号",
  "sections": [
    {"text": "开场那一句或几句", "type": "hook"},
    {"text": "历史脉络段落", "type": "history"},
    {"text": "故事段落", "type": "story"},
    {"text": "结尾彩蛋", "type": "trivia"}
  ],
  "keywords": ["3-5 个关键词，便于用户记忆和搜索"],
  "nearby": [
    {"name": "同一区域内另一个值得讲解的点位名", "intro": "一句话简介，15 字以内"}
  ],
  "insufficient": false
}

【nearby 字段特别说明】
必须给出 2-3 个与当前位置紧邻、且值得实地一看的讲解对象（例如同属一座宫殿群的配殿、殿内的重要陈设、同一院落的其他建筑）。
每个对象的名称要具体到可被识别（如"中和殿""保和殿""太和殿广场的日晷"），不要写"附近景点"这类泛称。
如果确实想不出合适的相邻点位，最多填写 1 个，不要编造不存在的地点。`;
}

/** 兜底讲解：资料不足时保证流程不中断 */
function fallbackGuide(pointName, locationHint) {
  const where = locationHint ? `位于${locationHint}的` : '';
  return {
    title: pointName,
    script:
      `这里是${where}${pointName}。目前我手头还没找到足够可靠的资料来给你完整讲述它的来龙去脉，` +
      `我不想凭印象编故事，那对你没有价值。你可以换个角度再拍一张，比如拍下它的牌匾、碑文或说明牌，` +
      `我就能查到更确切的信息，给你好好讲一讲。`,
    sections: [
      {
        text: `这里是${where}${pointName}。`,
        type: 'hook',
      },
      {
        text: '目前我手头还没找到足够可靠的资料来完整讲述它的来历，我不想凭印象编造内容。',
        type: 'history',
      },
      {
        text: '你可以试着拍一下它的牌匾、碑文或景点说明牌，我就能查到更确切的信息。',
        type: 'trivia',
      },
    ],
    keywords: [pointName],
    nearby: [],
    insufficient: true,
  };
}

/** 规范化模型返回的结果 */
function normalizeGuide(parsed, pointName, locationHint, sources) {
  const script = String(parsed.script || '').trim();
  if (!script) return fallbackGuide(pointName, locationHint);

  let sections = Array.isArray(parsed.sections) ? parsed.sections : [];
  sections = sections
    .filter((s) => s && s.text)
    .map((s) => ({
      text: String(s.text).trim(),
      type: ['hook', 'history', 'story', 'trivia'].includes(s.type) ? s.type : 'history',
    }));

  // 若模型没给 sections，则按标点切分 script
  if (!sections.length) {
    sections = script
      .split(/(?<=[。！？])/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text, i) => ({ text, type: i === 0 ? 'hook' : 'history' }));
  }

  const nearby = Array.isArray(parsed.nearby)
    ? parsed.nearby
        .filter((n) => n && n.name)
        .slice(0, 3)
        .map((n) => ({ name: String(n.name).trim(), intro: String(n.intro || '').trim() }))
    : [];

  return {
    title: String(parsed.title || pointName).trim(),
    script,
    sections,
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 5).map(String) : [],
    nearby,
    sources,
    insufficient: parsed.insufficient === true,
  };
}

/**
 * 生成讲解
 * @param {Object} opts
 * @param {string} opts.pointName 点位名
 * @param {string} [opts.locationHint] 位置提示（优先用识别出的景区名）
 * @param {string} [opts.plaqueText] 说明牌/碑文文字（作为一手资料注入）
 * @param {boolean} [opts.skipResearch] 是否跳过资料检索（调试用）
 * @returns {Promise<Object>} GuideResult
 */
async function generateGuide({ pointName, locationHint = '', plaqueText = '', skipResearch = false }) {
  // ---- 第二层：溯源托底，先拿真实资料（多级降级检索） ----
  let collected = { materials: [], sources: [], hasMaterial: false, hasDirect: false, hasParent: false, parentMaterial: null };

  if (!skipResearch) {
    try {
      collected = await collectMaterials(pointName, locationHint);
    } catch (e) {
      console.warn('[guide] 资料检索失败，降级为无资料生成：', e.message);
    }

    // 首轮全空 → 模型规范化位置（去城市前缀/推断景区）后重试
    if (!collected.hasMaterial) {
      try {
        const norm = await normalizeLocation(pointName, locationHint);
        if (norm.spot && norm.spot !== locationHint) {
          collected = await collectMaterials(pointName, norm.spot);
          if (collected.hasMaterial) {
            // 展示用位置：城市 + 景区
            locationHint = norm.city ? `${norm.city}${norm.spot}` : norm.spot;
          }
        }
      } catch (e) {
        console.warn('[guide] 二次检索失败：', e.message);
      }
    }
  }

  // ---- 说明牌文字：最高优先级的"一手资料"，插到最前面 ----
  if (plaqueText && plaqueText.length > 4) {
    collected.materials.unshift({
      title: `${pointName}现场说明牌`,
      text: plaqueText.slice(0, 1200),
      url: '',
      source: '现场说明牌',
      _tag: 'plaque',
    });
    collected.sources.unshift({
      name: '现场说明牌（由你拍摄）',
      url: '',
      tag: 'plaque',
    });
    collected.hasMaterial = true;
    // 有说明牌时，即使没查到百科词条也能讲（说明牌本身就是官方口径）
    if (!collected.hasDirect && !collected.hasParent) {
      collected.hasParent = true;
    }
  }

  // ---- 检索结果分档 ----
  // direct：有点位自身词条 → 纯资料生成（最可靠）
  // parent：无点位词条但有上级景区词条（或有现场说明牌）→ 景区资料 + 模型可靠知识
  // none：什么都没有 → 诚实兜底
  const mode = collected.hasDirect ? 'direct' : collected.hasParent ? 'parent' : 'none';

  // 完全无资料 → 直接给诚实兜底，不调用模型编造
  if (mode === 'none') {
    const fb = fallbackGuide(pointName, locationHint);
    fb.sources = collected.sources;
    return { ...fb, _meta: { model: 'fallback', reason: 'no-reliable-material' } };
  }

  // ---- 第一层：生成时约束 ----
  const prompt = buildGuidePrompt(pointName, collected.materials, locationHint, mode);

  const { content, usage, model } = await chat({
    model: CONFIG.modelText,
    messages: [
      { role: 'system', content: '你是一位严谨可靠的私人导游，只讲有据可查的内容。' },
      { role: 'user', content: prompt },
    ],
    jsonMode: true,
    maxTokens: 3000,
    timeoutMs: 150000,
    thinking: false,
  });

  let parsed;
  try {
    parsed = parseJsonLoose(content);
  } catch (e) {
    console.warn('[guide] JSON 解析失败，使用兜底：', e.message);
    const fb = fallbackGuide(pointName, locationHint);
    fb.sources = collected.sources;
    fb._parseError = String(content).slice(0, 200);
    return fb;
  }

  // ---- 第三层：冲突降级已写入 Prompt 约束，此处做结果规范化 ----
  let result = normalizeGuide(parsed, pointName, locationHint, collected.sources);

  // parent 模式：在来源区如实标注"部分内容基于 AI 知识整理"
  if (mode === 'parent' && !result.insufficient) {
    result.sources = [
      ...(result.sources || []),
      { name: '部分内容基于 AI 知识整理（建议实地核对说明牌）', url: '' },
    ];
  }

  result._meta = { model, usage, materialCount: collected.materials.length, mode };
  return result;
}

module.exports = { generateGuide, buildGuidePrompt, fallbackGuide, normalizeLocation };
