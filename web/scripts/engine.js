/**
 * 直连引擎 —— 无需任何服务端，手机 App 内直接调用 AI 接口
 *
 * 为什么要这个模块：
 *   服务端 server/ 那套（recognize / guide / research）已经验证可用，
 *   但用户希望"装完就能用、不用开电脑、不用连同一个 WiFi"。
 *   因此把服务端的业务逻辑原样搬到前端，由 App 直接用原生网络请求
 *   去访问用户自己填的 OpenAI 兼容接口。
 *
 * 关键前提：CORS
 *   浏览器里 fetch 第三方接口会被 CORS 拦截；但打包成 App 后，
 *   capacitor.config.json 里开启了 CapacitorHttp，
 *   Capacitor 会把 window.fetch 换成原生 Android 网络请求，不受 CORS 限制。
 *   Web 调试阶段若被拦，可临时用 `npx cap run` 或后端代理（保留兼容）。
 *
 * 配置来源：全部来自 AppConfig.llm()（用户在"模型设置"里填的那份）。
 *   本文件不含任何硬编码密钥、地址、模型名。
 *
 * 对应关系（服务端 → 本文件）：
 *   services/client.js    → chat() / parseJsonLoose()
 *   services/research.js  → collectMaterials() / baiduBaikeLemma()
 *   services/recognize.js → recognize() / RECOGNIZE_PROMPT
 *   services/guide.js     → generateGuide() / buildGuidePrompt()
 */

const Engine = (() => {
  // ============================================================
  //  模型调用（对应服务端 services/client.js）
  // ============================================================

  /** 取当前生效的模型配置 */
  function cfg() {
    const c = typeof AppConfig !== 'undefined' && AppConfig.llm ? AppConfig.llm() : {};
    return {
      apiKey: String(c.apiKey || '').trim(),
      baseUrl: String(c.baseUrl || '').trim().replace(/\/+$/, ''),
      modelVision: String(c.modelVision || '').trim(),
      modelText: String(c.modelText || '').trim(),
    };
  }

  /** 是否已配置到可用状态 */
  function ready() {
    const c = cfg();
    return Boolean(c.apiKey && c.baseUrl && (c.modelVision || c.modelText));
  }

  /** 未配置时的统一报错，文案要能指导用户去设置 */
  function ensureReady() {
    const c = cfg();
    if (!c.apiKey) throw new Error('还没填 API 密钥 —— 请点右上角齿轮，在「模型设置」里填写');
    if (!c.baseUrl) throw new Error('还没填接口地址 —— 请点右上角齿轮，在「模型设置」里填写');
    if (!c.modelVision || !c.modelText) throw new Error('模型名没填全 —— 请点右上角齿轮，在「模型设置」里补上');
  }

  /**
   * 底层 Chat Completions 调用（OpenAI 兼容协议）
   * @param {Object} opts
   * @param {string} opts.model
   * @param {Array}  opts.messages
   * @param {boolean} opts.jsonMode 要求返回 JSON 对象
   * @param {number} opts.maxTokens
   * @param {number} opts.timeoutMs
   * @param {number} opts.temperature
   * @returns {Promise<{content:string, usage:Object, model:string}>}
   */
  async function chat({
    model,
    messages,
    jsonMode = false,
    maxTokens = 3000,
    timeoutMs = 150000,
    temperature = 0.7,
  }) {
    ensureReady();
    const c = cfg();

    const body = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      // 关闭思考模式：实测能把讲解生成从 100 秒级降到 20 秒级
      reasoning_effort: 'none',
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let resp;
    try {
      resp = await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('模型响应超时，请检查网络后重试');
      // 浏览器未开启 CapacitorHttp 时，CORS 失败长这样
      throw new Error(
        `连不上接口（${e.message || '网络错误'}）。请确认接口地址是否以 /v1 结尾，以及手机网络是否正常。`,
      );
    }
    clearTimeout(timer);

    const text = await resp.text();

    if (!resp.ok) {
      // 常见错误给出人话解释
      let hint = '';
      if (resp.status === 401) hint = '（密钥不对或已失效，去服务商后台重新生成一个）';
      else if (resp.status === 402) hint = '（账户余额不足）';
      else if (resp.status === 404) hint = '（接口地址或模型名不对，地址必须以 /v1 结尾）';
      else if (resp.status === 429) hint = '（请求太频繁，稍等再试）';
      throw new Error(`AI 接口报错 [${resp.status}]${hint} ${text.slice(0, 300)}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`接口返回的不是 JSON：[${text.slice(0, 200)}]`);
    }

    const choice = data.choices && data.choices[0];
    if (!choice) throw new Error(`接口没有返回内容：${text.slice(0, 200)}`);

    return {
      content: (choice.message && choice.message.content) || '',
      usage: data.usage || null,
      model: data.model || model,
    };
  }

  /** 容错 JSON 解析：模型有时会包在 ```json ``` 里，或前后带解释文字 */
  function parseJsonLoose(text) {
    if (!text) throw new Error('内容为空，无法解析');
    let cleaned = String(text).trim();

    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) cleaned = fence[1].trim();

    try {
      return JSON.parse(cleaned);
    } catch (_) {
      /* 继续尝试 */
    }

    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch (_) {
        /* 继续 */
      }
    }
    throw new Error(`无法解析返回内容：${cleaned.slice(0, 200)}`);
  }

  // ============================================================
  //  资料检索（对应服务端 services/research.js）
  //  数据源：百度百科开放 API，国内直连，无 CORS 限制
  // ============================================================

  const BAIDU_BAIKE_API = 'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi';
  const BAIDU_APPID = '379020'; // 公开通用 appid

  /** 去 HTML 标签、脚注上标、引用标记 */
  function stripHtml(text) {
    return String(text || '')
      .replace(/<sup[^>]*>.*?<\/sup>/gi, '')
      .replace(/<a[^>]*><\/a>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\[\d+\]/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 带超时的 fetch
   * 性能关键②：百科接口正常 300-800ms 就回，12 秒的超时纯属浪费；
   * 超时后还要等它走完才降级，所以从 12s 收紧到 5s，卡住就快速失败转下一步。
   */
  const BAIKE_TIMEOUT_MS = 5000;

  async function fetchWithTimeout(url, timeoutMs = BAIKE_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 拉取百度百科词条卡片
   * @param {string} keyword 词条名
   */
  async function baiduBaikeLemma(keyword) {
    try {
      const url =
        `${BAIDU_BAIKE_API}?scope=103&format=json&appid=${BAIDU_APPID}` +
        `&bk_key=${encodeURIComponent(keyword)}`;
      const resp = await fetchWithTimeout(url, BAIKE_TIMEOUT_MS);
      if (!resp.ok) return null;

      const data = await resp.json();
      if (!data || !data.title) return null;

      const parts = [];

      // ① 摘要正文 —— 信息量最大
      if (data.abstract) {
        const abs = stripHtml(data.abstract);
        if (abs.length > 40) parts.push(abs);
      }
      // ② 一句话描述
      if (data.desc) parts.push(stripHtml(data.desc));
      // ③ 结构化字段（中文名/地理位置/建造年代…）
      //    card 在部分词条里是单个对象而非数组（如 {name,value}），
      //    旧实现只认数组，会静默丢掉这些词条的全部基本信息。
      const cardList = Array.isArray(data.card) ? data.card : data.card ? [data.card] : [];
      if (cardList.length) {
        const fieldLines = [];
        for (const item of cardList) {
          if (!item || typeof item !== 'object') continue;
          const name = item.name ? stripHtml(item.name) : '';
          const value = Array.isArray(item.value)
            ? stripHtml(item.value.join('；'))
            : item.value
              ? stripHtml(item.value)
              : '';
          // 过滤过长的实用信息（开放时间、票价），对历史讲解无价值
          if (name && value && value.length < 120) fieldLines.push(`${name}：${value}`);
        }
        if (fieldLines.length) parts.push('【基本信息】\n' + fieldLines.join('\n'));
      }
      // ④ 目录结构（引导模型可讲的维度）
      if (Array.isArray(data.catalog) && data.catalog.length) {
        const cats = data.catalog.map((c) => stripHtml(c)).filter(Boolean);
        if (cats.length) parts.push('【词条目录】' + cats.join('、'));
      }

      const text = parts.join('\n\n').trim();
      if (text.length < 40) return null;

      return {
        title: data.title,
        text,
        url: `https://baike.baidu.com/item/${encodeURIComponent(data.title)}`,
        source: '百度百科',
      };
    } catch (e) {
      console.warn('[engine] 百科抓取失败：', e.message);
      return null;
    }
  }

  /**
   * 汇总某点位的所有可用资料（多级降级检索）
   *   L1 直接查点位名
   *   L2 「位置 + 点位名」组合查
   *   L3 只查位置提示（上级景区）→ 景区级资料 + 模型可靠知识
   * @param {Object} [opts]
   * @param {boolean} [opts.skipCombo] 跳过 L2 组合查询（二次检索时用，省一次往返）
   * @param {Function} [opts.warm] 惰性预热回调：在发网络的**同一毫秒**调用，
   *        用来把「位置规范化」这个额外请求提前启程，但不让它阻塞返回。
   */
  async function collectMaterials(pointName, locationHint = '', opts = {}) {
    const materials = [];
    const sources = [];
    const seen = new Set();

    const add = (item, tag) => {
      if (!item || !item.title) return false;
      // 去重键要带上 tag：同一词条既可能作为"点位"也可能作为"上级景区"出现
      // （如"寒山寺"既是点位又是景区），旧实现只按 title 去重，
      // 会把第二次（tag 不同）的资料静默丢掉。
      const key = `${tag || 'point'}::${item.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      materials.push({ ...item, _tag: tag || 'point' });
      sources.push({ name: `${item.source}「${item.title}」`, url: item.url, tag: tag || 'point' });
      return true;
    };

    // 性能关键①：位置规范化（额外一次模型调用，1-3 秒）在这里就启程，
    //   和下面的百科请求并行跑；本函数不等它，命中就直接返回，
    //   没命中时它已经在路上跑了一整个检索的时间，只需再补一点点。
    if (opts.warm) {
      try {
        opts.warm();
      } catch (e) {
        /* 预热失败不影响主流程 */
      }
    }

    // L1 + L3 并行，省 2-4 秒
    let direct = null;
    let parentMaterial = null;

    if (locationHint) {
      [direct, parentMaterial] = await Promise.all([
        baiduBaikeLemma(pointName),
        baiduBaikeLemma(locationHint),
      ]);
    } else {
      direct = await baiduBaikeLemma(pointName);
    }
    add(direct, 'point');
    add(parentMaterial, 'parent');

    // L2：点位未命中时，用「位置 + 点位名」再试一次
    if (!direct && locationHint && !opts.skipCombo) {
      const combo = await baiduBaikeLemma(`${locationHint}${pointName}`);
      add(combo, 'point');
    }

    // 截断过长资料，避免超出模型上下文
    // 性能关键④：每份资料 3500 字严重超量（讲解最终只用 500-800 字），
    //   4 份资料最多 14000 字的 prefill 白白拖慢首字延迟。
    //   压到 1600 字/份、最多 3 份，信息量对 800 字讲解仍然充裕。
    const trimmed = materials.slice(0, 3).map((m) => ({
      ...m,
      text: m.text.length > 1600 ? m.text.slice(0, 1600) + '……' : m.text,
    }));

    const hasDirect = trimmed.some((m) => m.text.length > 80 && m._tag !== 'parent');
    // 与 hasDirect 对称：都基于**截断后**的文本长度判断。
    // 旧实现用未截断的 parentMaterial，会造成"正文 1600 字但 hasParent=true"
    // 这类自相矛盾的状态（明明资料够讲，mode 却按 parent 走）。
    const parentTrimmed = trimmed.find((m) => m._tag === 'parent');
    const hasParent = Boolean(parentTrimmed && parentTrimmed.text.length > 80);

    return {
      materials: trimmed,
      sources,
      hasMaterial: trimmed.some((m) => m.text.length > 80),
      hasDirect,
      hasParent,
      parentMaterial,
    };
  }

  // ============================================================
  //  图片识别（对应服务端 services/recognize.js）
  // ============================================================

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
   * @param {string} [userHint] 用户手动描述
   */
  async function recognize(images, userHint = '') {
    ensureReady();
    const list = (Array.isArray(images) ? images : [images]).filter(Boolean);
    const c = cfg();

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
      userContent.push({ type: 'image_url', image_url: { url: img } });
    }

    const { content, usage, model } = await chat({
      model: c.modelVision,
      messages: [
        { role: 'system', content: RECOGNIZE_PROMPT },
        { role: 'user', content: userContent },
      ],
      jsonMode: true,
      maxTokens: 700,
      timeoutMs: 120000,
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
        reason: '返回格式异常，已降级处理',
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

  /** 纯文本识别（用户直接输入描述，无需看图） */
  function resolveByName(userDescription) {
    return {
      name: String(userDescription || '').trim(),
      spot: '',
      city: '',
      confidence: 1,
      category: '其他',
      plaqueText: '',
      recognized: true,
      reason: '由你手动指定',
      _meta: { model: 'user-input', usage: null },
    };
  }

  // ============================================================
  //  讲解生成（对应服务端 services/guide.js）
  // ============================================================

  /**
   * 位置规范化：把带城市前缀/模糊的位置提示拆成「纯景区名 + 城市」
   * 百度百科是精确匹配，"苏州寒山寺"查不到而"寒山寺"能查到，此步是命中关键。
   *
   * 性能关键⑥：现在这一步会和首轮检索并发（见 generateGuide），
   *   所以它的耗时直接落在关键路径上——不能再失败重试 2 次（最坏 60 秒）。
   *   改为单次、15 秒上限，失败就如实返回空，由上层决定是否二次检索。
   */
  async function normalizeLocation(pointName, rawHint = '') {
    const c = cfg();
    const prompt =
      `景点/文物名：「${pointName}」${rawHint ? `，已知位置线索：「${rawHint}」` : ''}。` +
      `请给出它最可能所属的景区，只返回 JSON：` +
      `{"spot":"景区名（不含城市前缀，如'寒山寺'）","city":"城市名（如'苏州市'）"}。` +
      `推断不出时 spot 填空字符串。`;

    try {
      const { content } = await chat({
        model: c.modelVision, // 轻量模型即可，省成本
        messages: [{ role: 'user', content: prompt }],
        jsonMode: true,
        maxTokens: 80,
        timeoutMs: 15000,
      });
      const parsed = parseJsonLoose(content);
      const spot = String(parsed.spot || '').trim();
      if (spot) return { spot, city: String(parsed.city || '').trim() };
      return { spot: '', city: '' };
    } catch (e) {
      console.warn('[engine] 位置规范化失败：', e.message);
      return { spot: '', city: '' };
    }
  }

  /** 构建生成 Prompt（三层真实性保障的第一层：生成时约束） */
  function buildGuidePrompt(pointName, materials, locationHint, mode = 'direct') {
    // 性能关键③：提示词越长，模型"读题"越久（prefill 阶段线性增长），
    //   实测把重复的格式说明、冗余的风格条目压掉，prompt 从 ~2600 字降到 ~1200 字，
    //   首字延迟明显下降，且输出质量没有可感知的差别。
    const materialBlock = materials.length
      ? materials
          .map(
            (m, i) =>
              `【资料${i + 1}｜${m.source}「${m.title}」${m._tag === 'parent' ? '（上级景区）' : ''}】\n${m.text}`,
          )
          .join('\n\n')
      : '（本次未检索到可用的参考资料）';

    const knowledgeRule =
      mode === 'parent'
        ? `
【本对象的特殊性】「${pointName}」是${locationHint || '该景区'}内的一处具体点位，百科可能没有它的独立词条，上面的资料可能是它所在景区或现场说明牌的。允许你补充自己对该点位确切的知识，但：只讲有把握的事实；具体数字、生僻人物、小众传说没把握就不讲；与资料/说明牌冲突时以资料和说明牌为准；不要声明"这是景区资料"或"这是我的知识"。`
        : '';

    const plaqueRule = materials.some((m) => m._tag === 'plaque')
      ? `
【现场说明牌】参考资料中含一份「现场说明牌」，那是景点官方权威口径，其中的年代、名称、事件请优先采信并如实讲解。`
      : '';

    const strictness =
      mode === 'direct'
        ? '只能使用【参考资料】中出现的信息；资料没提到的人物、年代、事件、数字，一律不许编造。'
        : '以【参考资料】为主，辅以你对这一具体点位本身确切的知识；两方都没有的内容一律不许编造。';

    return `你是一位知识渊博、说话有感染力的私人导游，正站在游客身边讲解眼前这处地方。

【讲解对象】${pointName}${locationHint ? `\n【所在位置】${locationHint}` : ''}

【参考资料】
${materialBlock}
${plaqueRule}${knowledgeRule}

【硬性约束】
1. ${strictness}
2. 事实有争议时用"另有一说……"一句带过，不展开争论。
3. 资料和你的知识都不足以支撑讲解时，把 script 写成简短说明并令 insufficient 为 true，如实告知缺乏可靠资料。
4. 不要出现"根据资料""据记载显示"这类生硬引述腔，要自然讲出来。

【风格要求】
- 总长度 500-800 字，正常语速约 2-3 分钟。
- 开场：一句有画面感或带悬念的话（说书人式），可呼应眼前所见。
- 主体：按时间脉络讲清"这是什么、为什么重要、经历过什么"，严谨知识型。
- 结尾：留一个有意思的细节彩蛋。
- 口语化、句子偏短、适合朗读；用"你"称呼游客。

【输出格式】只返回 JSON，不要 markdown 代码块，不要任何额外解释。
下面模板中「……」都是占位说明，返回时必须全部替换成**真实讲解内容**：
{
  "title": "……讲解标题，12字以内",
  "script": "……完整讲解词全文，纯文本，500-800字，与下面 sections 拼起来的内容一致",
  "sections": [
    {"text": "……写下真正的开场那句话，不要写'开场'两个字", "type": "hook"},
    {"text": "……写下真正的历史脉络段落", "type": "history"},
    {"text": "……写下真正的故事段落", "type": "story"},
    {"text": "……写下真正的结尾彩蛋", "type": "trivia"}
  ],
  "keywords": ["……关键词1", "……关键词2", "……关键词3"],
  "nearby": [
    {"name": "……紧邻点位名", "intro": "……15字以内简介"}
  ],
  "insufficient": false
}

【极度重要——格式纪律】
- sections 里每个 text 必须是**讲给游客听的完整句子**，一段几十到两百字。
- 绝对禁止把"开场""历史脉络""故事""结尾彩蛋"这类**栏目标签词**当作 text 内容返回——
  那是格式说明，不是内容。返回标签词视为生成失败。
- script 必须是完整讲解全文（把 sections 的 text 按顺序连起来），不能为空、不能是标题式短语。

nearby 必须给 2-3 个与当前位置紧邻、值得实地一看的具体讲解对象（如"中和殿""太和殿广场的日晷"），不要写"附近景点"这类泛称，也不要编造不存在的地点。`;
  }

  /** 兜底讲解：资料不足时保证流程不中断（第三层真实性保障：诚实降级） */
  function fallbackGuide(pointName, locationHint) {
    const where = locationHint ? `位于${locationHint}的` : '';
    return {
      title: pointName,
      script:
        `这里是${where}${pointName}。目前我手头还没找到足够可靠的资料来给你完整讲述它的来龙去脉，` +
        `我不想凭印象编故事，那对你没有价值。你可以换个角度再拍一张，比如拍下它的牌匾、碑文或说明牌，` +
        `我就能查到更确切的信息，给你好好讲一讲。`,
      sections: [
        { text: `这里是${where}${pointName}。`, type: 'hook' },
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

  /** 段落标签词黑名单：模型有时会把格式示例里的栏目标签当成内容抄回来（真实事故） */
  const PLACEHOLDER_LABELS = new Set([
    '开场', '历史脉络', '故事', '结尾彩蛋', '结尾', '开场白',
    '故事段落', '历史段落', '细节', '源流', '钩子',
    '开场那一句或几句', '历史脉络段落', '故事段落正文', '彩蛋',
  ]);

  function isPlaceholderText(t) {
    const s = String(t || '').trim();
    if (!s) return true;
    if (PLACEHOLDER_LABELS.has(s)) return true;
    // 去掉结尾句读后再比一次：模型偶尔会返回"太和殿。"这样的标签词加标点，
    // 旧实现只比原串，导致"太和殿"被拦、"太和殿。"漏过，行为不一致。
    const bare = s.replace(/[。！？，、；：\s]+$/, '').trim();
    if (bare && bare !== s && PLACEHOLDER_LABELS.has(bare)) return true;
    // 极短的纯标签式文本（<=6 字且不含句读）也视为占位
    if (s.length <= 6 && !/[。！？，、]/.test(s)) return true;
    return false;
  }

  /** 规范化模型返回的结果 */
  function normalizeGuide(parsed, pointName, locationHint, sources) {
    let script = String(parsed.script || '').trim();
    const insufficient = parsed.insufficient === true;

    // script 本身被标签词污染（如"开场历史脉络故事结尾彩蛋"）→ 视为无正文。
    //
    // 注意这里要区分两种情况：
    //   ① 模型明确声明 insufficient=true —— 它本来就该给一段**简短**的说明，
    //      长度天然可能低于 20 字，"太短"不能作为判废依据，否则会把
    //      合法的诚实回答误判成垃圾、白白重试一次并覆盖成兜底文案。
    //   ② 正常生成 —— 500-800 字的讲解词若只剩不到 20 字，那确实是标签词残留。
    const stripped = script.replace(/[。！？\s]/g, '');
    const scriptIsGarbage = insufficient
      ? (!script || isPlaceholderText(script) || stripped.length < 4)
      : (!script || isPlaceholderText(script) || stripped.length < 20);

    let sections = Array.isArray(parsed.sections) ? parsed.sections : [];
    sections = sections
      .filter((s) => s && s.text)
      .map((s) => ({
        text: String(s.text).trim(),
        type: ['hook', 'history', 'story', 'trivia'].includes(s.type) ? s.type : 'history',
      }))
      // 拦截标签词占位段落
      .filter((s) => {
        if (!isPlaceholderText(s.text)) return true;
        console.warn('[engine] 拦截到标签词占位段落：', s.text.slice(0, 20));
        return false;
      });

    if (scriptIsGarbage && sections.length) {
      // sections 是好的而 script 坏了 → 用 sections 拼出 script
      script = sections.map((s) => s.text).join('');
      console.warn('[engine] script 缺失/污染，已用 sections 拼接重建');
    }

    // script 和 sections 全是标签词/空 → 内容生成彻底失败
    // 返回 null，由 generateGuide 决定重试还是兜底
    if (scriptIsGarbage && !sections.length) {
      console.warn('[engine] 模型只返回了格式标签、没有正文');
      return null;
    }

    if (!script) return null;

    if (!sections.length) {
      // 按句拆时保留类型语义：首句是开场（hook），末句是彩蛋（trivia），
      // 中间都是正文（history）。旧实现把所有非首句都标成 history，
      // 使 sections 重建后故事/彩蛋的区分全部丢失（音色/节奏会趋于平淡）。
      const texts = script
        .split(/(?<=[。！？])/)
        .map((t) => t.trim())
        .filter(Boolean);
      sections = texts.map((text, i) => {
        let type = 'history';
        if (i === 0) type = 'hook';
        else if (i === texts.length - 1 && texts.length > 2) type = 'trivia';
        else if (i === texts.length - 2 && texts.length > 4) type = 'story';
        return { text, type };
      });
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
      insufficient,
    };
  }

  /**
   * 生成讲解（全流程）
   * @param {Object} opts
   * @param {string} opts.pointName 点位名
   * @param {string} [opts.locationHint] 位置提示（识别出的景区名）
   * @param {string} [opts.plaqueText] 说明牌/碑文文字
   * @param {Function} [opts.onStage] 阶段回调（用于界面提示当前在做什么）
   */
  async function generateGuide({ pointName, locationHint = '', plaqueText = '', onStage }) {
    ensureReady();
    const c = cfg();
    const tStart = Date.now();
    const stage = (t) => {
      try {
        if (onStage) onStage(t);
      } catch (e) {
        /* ignore */
      }
    };

    // ---- 第二层：溯源托底，先拿真实资料（多级降级检索） ----
    // 性能关键①：位置规范化要额外调一次模型（1-3 秒），
    //   但只有"直接查不到点位词条"时才真正需要它。
    //
    //   串行写法（旧）= 先等检索回来 → 再等模型推断 → 再等二次检索，冷门点位要 5 秒以上。
    //   直接在开头就无条件并发（第一版改法）也不对：热门点位本来 1.2 秒就命中，
    //   却要陪着等一个根本用不上的推断，反而被拖到 2.5 秒。
    //
    //   正确做法：让规范化请求**惰性起飞**——开始检索的同时就发出，
    //   热门点位检索先回来（约 1.2 秒）就直接用结果、不需要等它；
    //   冷门点位检索没命中时，它早已经在路上跑了 1.2 秒，只需再补 1 秒左右。
    //   两个场景都是最优。
    let collected = {
      materials: [],
      sources: [],
      hasMaterial: false,
      hasDirect: false,
      hasParent: false,
      parentMaterial: null,
    };

    stage('查找相关资料…');

    let normPromise = null;
    const ensureNorm = () => {
      if (!normPromise) {
        normPromise = normalizeLocation(pointName, locationHint).catch((e) => {
          console.warn('[engine] 位置规范化失败：', e.message);
          return { spot: '', city: '' };
        });
      }
      return normPromise;
    };

    try {
      // warm: ensureNorm 会在检索请求发出的同一毫秒启程，但不参与 await
      collected = await collectMaterials(pointName, locationHint, { warm: ensureNorm });
    } catch (e) {
      console.warn('[engine] 资料检索失败，降级为无资料生成：', e.message);
    }

    // 首轮全空 → 用（早就起飞了的）位置推断结果重试一次
    if (!collected.hasMaterial) {
      const norm = await ensureNorm();
      if (norm.spot && norm.spot !== locationHint) {
        try {
          stage('换个线索再查一次…');
          const retryHint = norm.city ? `${norm.city}${norm.spot}` : norm.spot;
          const retried = await collectMaterials(pointName, retryHint, { skipCombo: true });
          if (retried.hasMaterial) {
            collected = retried;
            locationHint = retryHint;
          }
        } catch (e) {
          console.warn('[engine] 二次检索失败：', e.message);
        }
      }
    }

    // ---- 说明牌文字：最高优先级的一手资料，插到最前面 ----
    if (plaqueText && plaqueText.length > 4) {
      collected.materials.unshift({
        title: `${pointName}现场说明牌`,
        text: plaqueText.slice(0, 1200),
        url: '',
        source: '现场说明牌',
        _tag: 'plaque',
      });
      collected.sources.unshift({ name: '现场说明牌（由你拍摄）', url: '', tag: 'plaque' });
      collected.hasMaterial = true;
      if (!collected.hasDirect && !collected.hasParent) collected.hasParent = true;
    }

    // ---- 检索结果分档 ----
    // direct：有点位自身词条 → 纯资料生成（最可靠）
    // parent：无点位词条但有上级景区词条（或有说明牌）→ 景区资料 + 模型可靠知识
    // none：什么都没有 → 诚实兜底，不调模型编造
    const mode = collected.hasDirect ? 'direct' : collected.hasParent ? 'parent' : 'none';

    if (mode === 'none') {
      const fb = fallbackGuide(pointName, locationHint);
      fb.sources = collected.sources;
      return { ...fb, _meta: { model: 'fallback', reason: 'no-reliable-material', mode } };
    }

    // ---- 第一层：生成时约束 ----
    stage('正在组织语言…');
    const prompt = buildGuidePrompt(pointName, collected.materials, locationHint, mode);

    /**
     * 带纠错重试的生成：模型偶发把格式示例当内容抄回来（真实事故：
     * 把「开场/历史脉络/故事/结尾彩蛋」这些栏目标签当正文返回），
     * 第一次返回垃圾时不直接兜底，带明确的纠错指令重试一次。
     */
    async function chatOnce(corrective) {
      const messages = [
        { role: 'system', content: '你是一位严谨可靠的私人导游，只讲有据可查的内容。' },
        { role: 'user', content: corrective ? prompt + '\n\n' + corrective : prompt },
      ];
      return chat({
        model: c.modelText,
        messages,
        jsonMode: true,
        // 性能关键⑤：max_tokens 从 3000 收到 1600。
        //   800 字讲解 + sections 重复一遍 ≈ 1400 token，1600 足够；
        //   留太大只是给了模型"继续啰嗦"的空间，而 output 逐字生成，直接决定耗时。
        maxTokens: 1600,
        timeoutMs: 150000,
      });
    }

    const CORRECTIVE =
      '【上一次返回被判为无效，请注意】你把输出格式示例里的栏目标签词' +
      '（"开场""历史脉络""故事""结尾彩蛋"）直接当成了 sections 的 text 内容。' +
      'text 必须是讲给游客听的完整句子——开场段要有几十到两百字的真实讲解词。' +
      '请重新生成，务必返回真实内容。';

    let usage = null;
    let model = c.modelText;
    let result = null;
    let failReason = '';

    for (let attempt = 1; attempt <= 2; attempt++) {
      let content = '';
      try {
        const r = await chatOnce(attempt > 1 ? CORRECTIVE : '');
        content = r.content;
        usage = r.usage;
        model = r.model;
      } catch (e) {
        // 两次都失败就跳出循环，交给下面统一的兜底逻辑。
        // （旧写法是第 2 次直接 throw，会绕过兜底、把异常抛到界面，
        //   而这时我们其实"有资料但没生成出来"，正该走诚实降级。）
        console.warn(`[engine] 生成请求失败（第 ${attempt} 次）：`, e.message);
        failReason = e.message;
        continue;
      }

      let parsed;
      try {
        parsed = parseJsonLoose(content);
      } catch (e) {
        console.warn(`[engine] JSON 解析失败（第 ${attempt} 次）：`, e.message);
        failReason = 'json-parse';
        continue; // 换纠错指令再试一次
      }

      result = normalizeGuide(parsed, pointName, locationHint, collected.sources);
      if (result) break;
      console.warn(`[engine] 返回内容是格式标签而非正文（第 ${attempt} 次），重试…`);
      failReason = 'invalid-model-output';
      stage('内容质量校验未通过，重新生成…');
    }

    // 两次都没拿到有效正文 → 诚实兜底（而不是把异常抛给用户）
    if (!result) {
      const fb = fallbackGuide(pointName, locationHint);
      fb.sources = collected.sources;
      return {
        ...fb,
        _meta: { model, usage, reason: failReason || 'invalid-model-output', mode },
      };
    }

    // parent 模式：来源区如实标注"部分内容基于 AI 知识整理"
    if (mode === 'parent' && !result.insufficient) {
      result.sources = [
        ...(result.sources || []),
        { name: '部分内容基于 AI 知识整理（建议实地核对说明牌）', url: '' },
      ];
    }

    result._meta = {
      model,
      usage,
      materialCount: collected.materials.length,
      mode,
      elapsedMs: Date.now() - tStart,
    };
    return result;
  }

  /**
   * 连通性自检：用一个最小请求验证密钥 / 地址 / 模型是否真的可用
   * 走 /models 接口（几乎所有 OpenAI 兼容服务都提供）
   */
  async function selfTest() {
    const c = cfg();
    const started = Date.now();
    if (!c.baseUrl) return { ok: false, ms: 0, error: '请先填写接口地址' };
    if (!c.apiKey) return { ok: false, ms: 0, error: '请先填写 API 密钥' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const resp = await fetch(`${c.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${c.apiKey}` },
        signal: controller.signal,
      });
      const ms = Date.now() - started;
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        let hint = '';
        if (resp.status === 401) hint = '密钥无效';
        else if (resp.status === 404) hint = '接口地址不对（应以 /v1 结尾）';
        return { ok: false, ms, error: `HTTP ${resp.status} ${hint} ${t.slice(0, 160)}` };
      }
      const data = await resp.json().catch(() => null);
      const ids = Array.isArray(data && data.data) ? data.data.map((m) => m.id) : [];
      return {
        ok: true,
        ms,
        modelCount: ids.length,
        hasVision: ids.some((id) => /vl|vision|glm-5|gpt-4o|omni|qwen-vl/i.test(id)),
        hasText: ids.length === 0 || ids.includes(c.modelText),
        hasVisionModel: ids.length === 0 || ids.some((id) => id === c.modelVision),
        sample: ids.slice(0, 12),
      };
    } catch (e) {
      const ms = Date.now() - started;
      if (e && e.name === 'AbortError') return { ok: false, ms, error: '连接超时（20 秒）' };
      return { ok: false, ms, error: String(e.message || e).slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ready,
    chat,
    parseJsonLoose,
    recognize,
    resolveByName,
    generateGuide,
    collectMaterials,
    baiduBaikeLemma,
    normalizeLocation,
    fallbackGuide,
    buildGuidePrompt,
    selfTest,
    cfg,
  };
})();
