/**
 * 资料检索服务 —— 为讲解生成提供真实、可溯源的资料来源
 *
 * 这是"三层真实性保障"的第二层（溯源托底）的核心：
 *   真实性不靠 AI 自觉，而是每段讲解都有真实公开资料托底。
 *
 * 数据源（实测于 2026-10-09）：
 *   ✅ 百度百科开放 API  https://baike.baidu.com/api/openapi/BaikeLemmaCardApi
 *      - 国内可直连，200 OK，返回结构化百科卡片（中文名/地理位置/描述等）
 *      - 主资料源
 *   ❌ 维基百科 zh.wikipedia.org —— 本机网络不可达（返回 000），保留为备选代码
 *
 * 换资料源：在此文件新增 fetch 函数，加进 collectMaterials 的装配流程。
 */

const BAIDU_BAIKE_API = 'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi';
const BAIDU_APPID = '379020'; // 公开通用 appid，用于百科开放接口
const WIKI_API = 'https://zh.wikipedia.org/w/api.php';
const WIKI_REST = 'https://zh.wikipedia.org/api/rest_v1';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 统一超时 fetch */
async function fetchWithTimeout(url, timeoutMs = 12000, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', ...extraHeaders },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 去掉 HTML 标签、脚注上标、引用标记 */
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

// ============================================================
// 数据源一：百度百科（主）
// ============================================================

/**
 * 拉取百度百科词条卡片
 * @param {string} keyword 词条名
 * @returns {Promise<Object|null>} { title, text, url, source }
 */
async function baiduBaikeLemma(keyword) {
  try {
    const url =
      `${BAIDU_BAIKE_API}?scope=103&format=json&appid=${BAIDU_APPID}` +
      `&bk_key=${encodeURIComponent(keyword)}`;
    const resp = await fetchWithTimeout(url, 12000, {
      Referer: 'https://baike.baidu.com/',
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    if (!data || !data.title) return null;

    const parts = [];

    // ① 摘要正文（abstract）—— 信息量最大的字段，优先取
    if (data.abstract) {
      const abs = stripHtml(data.abstract);
      if (abs.length > 40) parts.push(abs);
    }

    // ② 一句话描述
    if (data.desc) parts.push(stripHtml(data.desc));

    // ③ 结构化卡片字段（中文名/地理位置/建造年代/门票等）
    if (Array.isArray(data.card)) {
      const fieldLines = [];
      for (const item of data.card) {
        const name = item.name ? stripHtml(item.name) : '';
        const value = Array.isArray(item.value) ? stripHtml(item.value.join('；')) : '';
        // 过滤掉过长的实用信息（如开放时间、门票价格），对历史讲解无价值
        if (name && value && value.length < 120) {
          fieldLines.push(`${name}：${value}`);
        }
      }
      if (fieldLines.length) parts.push('【基本信息】\n' + fieldLines.join('\n'));
    }

    // ④ 目录结构（提示可讲的内容维度，对模型有引导作用）
    if (Array.isArray(data.catalog) && data.catalog.length) {
      const cats = data.catalog.map((c) => stripHtml(c)).filter(Boolean);
      if (cats.length) parts.push('【词条目录】' + cats.join('、'));
    }

    // ⑤ 其他可能的正文字段（不同词条结构不一，兼容处理）
    for (const key of ['lemmaDesc', 'lemmaAbstract', 'summary']) {
      if (data[key] && typeof data[key] === 'string' && data[key].length > 40) {
        parts.push(stripHtml(data[key]));
      }
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
    console.warn('[research] 百度百科抓取失败：', e.message);
    return null;
  }
}

// ============================================================
// 数据源二：维基百科（备选，本机网络可能不可达）
// ============================================================

async function wikiExtract(title) {
  try {
    const url =
      `${WIKI_API}?action=query&format=json&prop=extracts` +
      `&explaintext=1&exsectionformat=plain&redirects=1&titles=${encodeURIComponent(title)}`;
    const resp = await fetchWithTimeout(url, 8000);
    if (!resp.ok) return null;
    const data = await resp.json();
    const first = Object.values(data.query?.pages || {})[0];
    if (!first || !first.extract) return null;
    return {
      title: first.title,
      text: first.extract,
      url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(first.title)}`,
      source: '维基百科',
    };
  } catch (e) {
    return null;
  }
}

// ============================================================
// 汇总装配
// ============================================================

/**
 * 汇总某点位的所有可用资料（多级降级检索）
 *
 * 点位级名称（如"枫桥夜泊诗碑"）在百科里往往没有同名词条，
 * 但其上级景区（"寒山寺"）一定有。策略：
 *   L1 直接查点位名
 *   L2 「位置提示 + 点位名」组合查
 *   L3 只查位置提示（上级景区）→ 拿到景区级资料，交给生成模型
 *      结合模型自身可靠知识讲解，来源如实标注
 *
 * @param {string} pointName 点位名，如"太和殿"
 * @param {string} [locationHint] 位置提示，如"北京故宫"
 * @returns {Promise<{materials, sources, hasMaterial, hasDirect, hasParent, parentMaterial}>}
 */
async function collectMaterials(pointName, locationHint = '') {
  const materials = [];
  const sources = [];
  const seen = new Set();

  const add = (item, tag) => {
    if (!item || !item.title || seen.has(item.title)) return false;
    seen.add(item.title);
    const tagged = { ...item, _tag: tag || 'point' };
    materials.push(tagged);
    sources.push({
      name: `${item.source}「${item.title}」`,
      url: item.url,
      tag: tag || 'point', // point=点位本身 parent=上级景区
    });
    return true;
  };

  // ---- 并行检索：L1（点位名）与 L3（上级景区）同时发，节省 2-4 秒 ----
  // L3 的景区资料即使点位命中也有价值（丰富讲解背景），因此总是查询
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

  // ---- L2：位置 + 点位名组合（仅当点位未命中时） ----
  if (!direct && locationHint) {
    const combo = await baiduBaikeLemma(`${locationHint}${pointName}`);
    add(combo, 'point');
  }

  // ---- L4：维基百科兜底（网络可达时） ----
  if (materials.length === 0) {
    const wiki = await wikiExtract(pointName);
    add(wiki, 'point');
  }

  // 截断过长资料，避免超出模型上下文
  const trimmed = materials.slice(0, 4).map((m) => ({
    ...m,
    text: m.text.length > 3500 ? m.text.slice(0, 3500) + '……' : m.text,
  }));

  const hasDirect = trimmed.some((m) => m.text.length > 80 && m._tag !== 'parent');
  const hasParent = Boolean(parentMaterial && parentMaterial.text && parentMaterial.text.length > 80);

  return {
    materials: trimmed,
    sources,
    hasMaterial: trimmed.some((m) => m.text.length > 80),
    hasDirect,
    hasParent,
    parentMaterial,
  };
}

module.exports = { collectMaterials, baiduBaikeLemma, wikiExtract, stripHtml };
