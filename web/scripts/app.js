/**
 * 主流程控制 —— 串联所有模块
 *
 * 流程：拍照/选图 → 压缩 → 识别 → 确认弹层 → 生成讲解 → 讲解页（TTS+高亮）
 *                                                        ↓
 *                                              附近点位推荐 / 再拍一处
 */

(() => {
  // ---------- DOM 引用 ----------
  const $ = (id) => document.getElementById(id);

  const screens = {
    home: $('screen-home'),
    guide: $('screen-guide'),
    history: $('screen-history'),
  };

  const cameraInput = $('cameraInput');
  const galleryInput = $('galleryInput');

  const confirmOverlay = $('confirmOverlay');
  const confirmNormal = $('confirmNormal');
  const confirmManual = $('confirmManual');
  const confirmImage = $('confirmImage');
  const confirmName = $('confirmName');
  const confirmReason = $('confirmReason');
  const confirmQuestion = $('confirmQuestion');
  const recogBadge = $('recogBadge');
  const recogBadgeText = $('recogBadgeText');
  const recogThumbs = $('recogThumbs');
  const spotLayer = $('spotLayer');
  const spotName = $('spotName');
  const plaqueChip = $('plaqueChip');
  const btnAddPhoto = $('btnAddPhoto');
  const btnAddPhotoText = $('btnAddPhotoText');
  const addPhotoHint = $('addPhotoHint');
  const manualInput = $('manualInput');
  const manualLabel = $('manualLabel');

  const loadingOverlay = $('loadingOverlay');
  const loadingText = $('loadingText');
  const loadingSub = $('loadingSub');
  const toast = $('toast');

  const guideImage = $('guideImage');
  const guideHero = guideImage ? guideImage.closest('.guide-hero') : null;
  const guideTitle = $('guideTitle');
  const guideLocation = $('guideLocation');
  const scriptBody = $('scriptBody');
  const sourcesBlock = $('sourcesBlock');
  const sourcesToggle = $('sourcesToggle');
  const sourceNames = $('sourceNames');
  const sourcesDetail = $('sourcesDetail');
  const exploreBlock = $('exploreBlock');
  const nearbyList = $('nearbyList');
  const insufficientNote = $('insufficientNote');

  const btnPlay = $('btnPlay');
  const playIcon = $('playIcon');
  const progressFill = $('progressFill');
  const progressTrack = $('progressTrack');
  const timeCurrent = $('timeCurrent');
  const timeTotal = $('timeTotal');
  const ttsWarning = $('ttsWarning');
  const playerLabel = $('playerLabel');

  const btnLike = $('btnLike');
  const likeLabel = $('likeLabel');

  const historyList = $('historyList');
  const historyEmpty = $('historyEmpty');
  const historyCount = $('historyCount');

  const voiceOverlay = $('voiceOverlay');
  const providerSeg = $('providerSeg');
  const voiceList = $('voiceList');
  const voiceNote = $('voiceNote');

  const settingsOverlay = $('settingsOverlay');
  const connDot = $('connDot');
  const connStatus = $('connStatus');
  const connMeta = $('connMeta');
  const inputProvider = $('inputProvider');
  const providerTag = $('providerTag');
  const providerHint = $('providerHint');
  const keyTag = $('keyTag');
  const inputApiKey = $('inputApiKey');
  const inputBaseUrl = $('inputBaseUrl');
  const inputModelVision = $('inputModelVision');
  const inputModelText = $('inputModelText');
  const serverResult = $('serverResult');
  const voiceInfoList = $('voiceInfoList');
  const advBody = $('advBody');
  const inputRelayUrl = $('inputRelayUrl');
  const probeResult = $('probeResult');

  // ---------- 运行时状态 ----------
  const state = {
    currentImages: [],     // 当前图片 dataURL 数组（第 1 张为主图）
    currentRecognition: null, // 识别结果
    currentGuide: null,    // 讲解结果
    currentRecordId: null, // 当前讲解对应的历史记录 id
    sections: [],          // 段落 DOM 数组
  };

  /** 主图（用于缩略图、封面） */
  function mainImage() {
    return state.currentImages[0] || '';
  }

  // ---------- 工具函数 ----------

  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => {
      el.classList.toggle('is-active', key === name);
    });
  }

  let toastTimer = null;
  function showToast(msg, duration = 2600) {
    toast.textContent = msg;
    toast.classList.add('is-open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-open'), duration);
  }

  function showLoading(text, sub = '') {
    loadingText.textContent = text;
    loadingSub.textContent = sub;
    loadingOverlay.classList.add('is-open');
  }

  function updateLoadingSub(sub) {
    loadingSub.textContent = sub;
  }

  function hideLoading() {
    loadingOverlay.classList.remove('is-open');
  }

  /** 图片压缩：长边限制 + JPEG 质量，避免上传过大 */
  function compressImage(file, maxEdge = 1280, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxEdge || height > maxEdge) {
            const ratio = Math.min(maxEdge / width, maxEdge / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => reject(new Error('图片读取失败'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  /** 估算整篇时长（按字数） */
  function estimateTotalDuration(sentences) {
    const chars = sentences.reduce((sum, s) => sum + s.length, 0);
    return chars / 4.6;
  }

  // ---------- 图片处理入口 ----------

  // MIME 缺失时按扩展名兜底（部分系统 .webp/.heic 的 type 为空）
  const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i;
  function isImageFile(f) {
    if (f.type && f.type.startsWith('image/')) return true;
    return IMAGE_EXT_RE.test(f.name || '');
  }

  const MAX_IMAGES = 6;

  /**
   * 处理选中的图片文件
   * @param {FileList|File[]} files
   * @param {boolean} append true=追加到已有图片后重新识别；false=全新识别
   */
  async function handleFiles(files, append = false) {
    const list = Array.from(files || []).filter(isImageFile);
    if (!list.length) {
      showToast('请选择图片文件');
      return;
    }

    // 追加模式下与已有图片合并，总数上限 MAX_IMAGES
    const existing = append ? state.currentImages.slice() : [];
    const room = MAX_IMAGES - existing.length;
    if (room <= 0) {
      showToast(`最多 ${MAX_IMAGES} 张，已经足够了`);
      return;
    }
    let picked = list.slice(0, room);
    if (list.length > room) {
      showToast(`最多 ${MAX_IMAGES} 张，本次只加了 ${room} 张`);
    }

    try {
      showLoading(
        append ? '正在追加照片' : '正在处理图片',
        append ? '连同前面的照片一起重新识别…' : `共 ${picked.length} 张`
      );
      const newUrls = [];
      for (const f of picked) {
        newUrls.push(await compressImage(f));
      }
      state.currentImages = existing.concat(newUrls);
      hideLoading();
      await doRecognize(state.currentImages, '', append);
    } catch (e) {
      hideLoading();
      showToast(e.message || '图片处理失败');
    }
  }

  /** 识别流程 */
  async function doRecognize(dataUrls, hint = '', isRetry = false) {
    showLoading(
      '正在识别',
      dataUrls.length > 1
        ? `综合 ${dataUrls.length} 张照片分析`
        : '看看这是什么地方'
    );
    try {
      const t = setTimeout(() => updateLoadingSub('正在比对建筑特征…'), 2200);
      const result = await API.recognize(dataUrls, hint);
      clearTimeout(t);

      if (isRetry) {
        result._retried = true;
      }
      state.currentRecognition = result;
      hideLoading();
      openConfirm(result, isRetry);
    } catch (e) {
      hideLoading();
      showToast(e.message || '识别失败，请重试');
    }
  }

  // ---------- 确认弹层 ----------

  let manualFallbackTimer = null;
  // 标记下一次文件选择是否为"追加到已有照片"（由补图按钮触发）
  let pendingAppend = false;

  /** 清除"识别失败 → 自动转手动"的延迟任务，避免污染成功路径 */
  function clearManualFallback() {
    if (manualFallbackTimer) {
      clearTimeout(manualFallbackTimer);
      manualFallbackTimer = null;
    }
  }

  function openConfirm(result, isRetry = false) {
    clearManualFallback();
    confirmImage.src = mainImage();
    confirmNormal.hidden = false;
    confirmManual.hidden = true;

    // 多图缩略图
    if (state.currentImages.length > 1) {
      recogThumbs.hidden = false;
      recogThumbs.innerHTML = state.currentImages
        .map((src) => `<img src="${src}" alt="" />`)
        .join('');
    } else {
      recogThumbs.hidden = true;
      recogThumbs.innerHTML = '';
    }

    const hasSpot = Boolean(result.spot);
    const hasName = Boolean(result.name);

    if (result.recognized && (hasName || hasSpot)) {
      // 景区层级（大方向）
      if (hasSpot) {
        spotLayer.hidden = false;
        spotName.textContent = result.spot;
      } else {
        spotLayer.hidden = true;
      }

      // 具体点位（小方向）
      if (hasName && result.name !== result.spot) {
        confirmQuestion.hidden = false;
        confirmQuestion.textContent = isRetry ? '加上新照片，我看是' : '这处是';
        confirmName.textContent = result.name;
        confirmName.hidden = false;
      } else {
        // 只认出景区，进入手动补全更合适
        confirmQuestion.hidden = false;
        confirmQuestion.textContent = '这是';
        confirmName.textContent = hasName ? result.name : '未能确定具体点位';
        confirmName.hidden = false;
      }

      confirmReason.textContent = result.reason || '';
      confirmReason.hidden = !result.reason;

      // 说明牌已读取
      plaqueChip.hidden = !result.plaqueText;

      const low = result.confidence < 0.6;
      recogBadge.classList.toggle('is-low', low);
      if (isRetry && low) {
        recogBadgeText.textContent = `还是不太确定（${Math.round(result.confidence * 100)}%）`;
      } else if (low) {
        recogBadgeText.textContent = `不太确定（${Math.round(result.confidence * 100)}%）`;
      } else {
        recogBadgeText.textContent = isRetry ? '这次认准了' : '识别完成';
      }

      // 按钮文案：仍然存疑时可再补图
      btnCorrect.textContent = '不对，我来说';
      btnConfirmOk.textContent = '对，就是它';
      setAddPhotoState(low ? 'more' : 'normal');
    } else {
      // 没认出来：展示失败原因，并提供"补图 / 手输"两条出路
      spotLayer.hidden = true;
      confirmQuestion.hidden = false;
      confirmQuestion.textContent =
        isRetry && state.currentImages.length > 1
          ? '加上这些照片还是没认出来'
          : '这张图我没认出来';
      confirmName.textContent = '换个角度再试试';
      confirmName.hidden = false;
      confirmReason.textContent = result.reason
        ? `${result.reason}。可以拍得更完整、更清晰，或者直接告诉我这是哪儿。`
        : '可以拍得更完整、更清晰，或者直接告诉我这是哪儿。';
      confirmReason.hidden = false;
      plaqueChip.hidden = true;
      recogBadge.classList.add('is-low');
      recogBadgeText.textContent = '识别失败';
      btnCorrect.textContent = '我来说';
      btnConfirmOk.textContent = '重新拍一张';
      setAddPhotoState('failed');
    }

    confirmOverlay.classList.add('is-open');

    // 追加照片后重新识别，给个简短反馈
    if (isRetry) {
      showToast(`已合并 ${state.currentImages.length} 张照片重新识别`);
    }
  }

  /**
   * 设置"补图"按钮状态
   * @param {'normal'|'more'|'failed'} mode
   */
  function setAddPhotoState(mode) {
    const n = state.currentImages.length;
    const full = n >= MAX_IMAGES;
    if (mode === 'failed') {
      btnAddPhotoText.textContent = full
        ? `照片已满（${MAX_IMAGES} 张），试试手动输入`
        : '再补一张照片试试';
      btnAddPhoto.classList.add('is-danger');
      btnAddPhoto.hidden = full ? false : false;
      btnAddPhoto.disabled = full;
      addPhotoHint.hidden = full;
      addPhotoHint.textContent =
        '补一张说明牌、门匾或全景照片，我会把全部照片放在一起重新判断';
    } else if (mode === 'more') {
      btnAddPhotoText.textContent = full ? `已上传 ${n} 张（上限 ${MAX_IMAGES} 张）` : '认不准？再加一张照片';
      btnAddPhoto.classList.remove('is-danger');
      btnAddPhoto.disabled = full;
      addPhotoHint.hidden = true;
    } else {
      btnAddPhotoText.textContent = '再加一张照片一起判断';
      btnAddPhoto.classList.remove('is-danger');
      btnAddPhoto.disabled = full;
      addPhotoHint.hidden = true;
    }
  }

  function closeConfirm() {
    clearManualFallback();
    confirmOverlay.classList.remove('is-open');
  }

  function goManualMode(label, defaultValue = '') {
    clearManualFallback();
    confirmNormal.hidden = true;
    confirmManual.hidden = false;
    manualLabel.textContent = label;
    manualInput.value = defaultValue;
    setTimeout(() => manualInput.focus(), 260);
  }

  // ---------- 生成讲解 ----------

  async function generateGuide(pointName, locationHint = '', plaqueText = '') {
    closeConfirm();

    // 兜底进度文案：真实阶段回调没到之前，按时间轴粗粒度提示
    const t0 = Date.now();
    showLoading('正在准备讲解', '查找相关资料…');
    const tick = setInterval(() => {
      const el = Date.now() - t0;
      if (el < 3000) updateLoadingSub('查找相关资料…');
      else if (el < 9000) updateLoadingSub('资料比对中，确保内容可靠…');
      else updateLoadingSub('正在组织语言，请稍候…');
    }, 900);

    const started = Date.now();
    try {
      // 真实阶段回调：引擎走到哪一步就显示哪一步，避免"假进度"
      const guide = await API.guide(pointName, locationHint, plaqueText, (stageText) => {
        clearInterval(tick);
        updateLoadingSub(stageText);
      });
      clearInterval(tick);
      hideLoading();
      console.log(`[perf] 讲解总耗时 ${Date.now() - started}ms`);
      renderGuide(guide, pointName, locationHint);
      showScreen('guide');

      // 自动开始播报（用户此前点击过按钮，满足浏览器自动播放策略）
      setTimeout(() => {
        if (Speech.isSupported() && Speech.getSentenceCount() > 0) {
          Speech.play();
        }
      }, 700);
    } catch (e) {
      clearInterval(tick);
      hideLoading();
      showToast(e.message || '讲解生成失败，请重试');
    }
  }

  // ---------- 渲染讲解页 ----------

  const SECTION_LABEL = {
    hook: '开场',
    history: '源流',
    story: '故事',
    trivia: '细节',
  };

  function renderGuide(guide, pointName, locationHint) {
    state.currentGuide = guide;

    // 头部
    // 「说个名字」进来的没有照片：src 置空会让浏览器去请求页面自身，
    // 渲染成破裂图片图标。这里直接隐藏 img，让 hero 显示装饰性山峦底纹。
    const heroPhoto = mainImage();
    if (heroPhoto) {
      guideImage.src = heroPhoto;
      guideImage.hidden = false;
      if (guideHero) guideHero.classList.remove('no-photo');
    } else {
      guideImage.removeAttribute('src');
      guideImage.hidden = true;
      if (guideHero) guideHero.classList.add('no-photo');
    }
    guideTitle.textContent = guide.title || pointName;

    if (locationHint) {
      guideLocation.hidden = false;
      guideLocation.querySelector('span').textContent = locationHint;
    } else {
      guideLocation.hidden = true;
    }

    // 资料不足提示
    insufficientNote.hidden = !guide.insufficient;

    // 正文段落
    scriptBody.innerHTML = '';
    state.sections = [];

    const sections = guide.sections && guide.sections.length
      ? guide.sections
      : [{ text: guide.script, type: 'history' }];

    sections.forEach((sec, idx) => {
      const div = document.createElement('div');
      div.className = 'script-section';
      div.dataset.index = idx;

      const tag = document.createElement('div');
      tag.className = 'script-tag';
      tag.textContent = SECTION_LABEL[sec.type] || '讲解';

      const p = document.createElement('p');
      p.textContent = sec.text;

      div.appendChild(tag);
      div.appendChild(p);

      div.addEventListener('click', () => {
        Speech.jumpTo(idx);
        if (Speech.getState() !== 'playing') {
          setTimeout(() => Speech.play(), 180);
        }
      });

      scriptBody.appendChild(div);
      state.sections.push(div);
    });

    // 时间估算
    const sentences = sections.map((s) => s.text);
    const total = estimateTotalDuration(sentences);
    timeTotal.textContent = formatTime(total);
    timeCurrent.textContent = '0:00';

    // 载入语音
    Speech.load(sentences);

    if (!Speech.isSupported()) {
      ttsWarning.hidden = false;
      playerLabel.textContent = '文字模式';
      btnPlay.style.opacity = '0.4';
    } else {
      ttsWarning.hidden = true;
      playerLabel.textContent = '讲解中';
      btnPlay.style.opacity = '1';
    }

    // 来源
    renderSources(guide.sources);

    // 附近点位
    renderNearby(guide.nearby);

    // 滚回顶部
    $('guideScroll').scrollTop = 0;

    // 记录历史（去重后返回记录对象，用于点赞关联）
    const record = Storage.add({
      pointName,
      spot: state.currentRecognition ? state.currentRecognition.spot : '',
      location: locationHint,
      title: guide.title,
      script: guide.script,
      sections: guide.sections,
      sources: guide.sources,
      nearby: guide.nearby,
      insufficient: guide.insufficient,
      thumb: mainImage(),
    });
    state.currentRecordId = record.id;

    // 同步点赞状态
    syncLikeUI(record.liked);
  }

  function renderSources(sources) {
    if (!sources || !sources.length) {
      sourcesBlock.hidden = true;
      return;
    }
    sourcesBlock.hidden = false;
    sourceNames.textContent = sources.map((s) => s.name).join('、');
    sourcesDetail.innerHTML = '';
    sources.forEach((s) => {
      if (s.url) {
        const a = document.createElement('a');
        a.href = s.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = s.name;
        sourcesDetail.appendChild(a);
      } else {
        // 无链接的来源（现场说明牌、AI 整理说明）——以纯文本展示
        const div = document.createElement('div');
        div.className = 'source-plain';
        div.textContent = s.name;
        sourcesDetail.appendChild(div);
      }
    });
  }

  function renderNearby(nearby) {
    if (!nearby || !nearby.length) {
      exploreBlock.hidden = true;
      return;
    }
    exploreBlock.hidden = false;
    nearbyList.innerHTML = '';
    nearby.forEach((item) => {
      const btn = document.createElement('button');
      btn.className = 'nearby-card';
      btn.innerHTML = `
        <span class="nearby-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z"/>
            <circle cx="12" cy="10" r="2.4"/>
          </svg>
        </span>
        <span class="nearby-info">
          <span class="nearby-name">${escapeHtml(item.name)}</span>
          <span class="nearby-intro">${escapeHtml(item.intro || '')}</span>
        </span>
        <span class="nearby-arrow">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m9 5 7 7-7 7"/>
          </svg>
        </span>
      `;
      btn.addEventListener('click', () => {
        Speech.stop();
        generateGuide(item.name, '');
      });
      nearbyList.appendChild(btn);
    });
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---------- 点赞 ----------

  function syncLikeUI(liked) {
    btnLike.classList.toggle('is-liked', Boolean(liked));
    likeLabel.textContent = liked ? '已赞' : '有用';
  }

  function handleLike() {
    if (!state.currentRecordId) return;
    const liked = Storage.toggleLike(state.currentRecordId);
    syncLikeUI(liked);
    if (liked) {
      btnLike.classList.add('just-liked');
      setTimeout(() => btnLike.classList.remove('just-liked'), 460);
      showToast('已记录，谢谢你的反馈');
    }
  }

  // ---------- 我的足迹 ----------

  function formatDate(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (sameDay) return `今天 ${hm}`;
    const yesterday = new Date(now.getTime() - 86400000);
    if (
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate()
    ) {
      return `昨天 ${hm}`;
    }
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  }

  function openHistory() {
    const list = Storage.getAll();
    historyCount.textContent = list.length ? `共 ${list.length} 处` : '';

    if (!list.length) {
      historyList.innerHTML = '';
      historyEmpty.hidden = false;
    } else {
      historyEmpty.hidden = true;
      historyList.innerHTML = '';
      list.forEach((item) => historyList.appendChild(buildHistoryItem(item)));
    }

    showScreen('history');
  }

  function buildHistoryItem(item) {
    const el = document.createElement('div');
    el.className = 'history-item';

    const thumb = document.createElement('div');
    thumb.className = 'history-thumb';
    if (item.thumb) {
      const img = document.createElement('img');
      img.src = item.thumb;
      img.alt = '';
      thumb.appendChild(img);
    } else {
      thumb.textContent = (item.pointName || '景')[0];
    }

    const info = document.createElement('div');
    info.className = 'history-info';

    const title = document.createElement('div');
    title.className = 'history-item-title';
    title.textContent = item.title || item.pointName;

    const meta = document.createElement('div');
    meta.className = 'history-item-meta';
    const where = item.location || item.spot || '位置未记录';
    meta.innerHTML = `<span>${escapeHtml(where)}</span><span>·</span><span>${formatDate(item.createdAt)}</span>`;
    if (item.liked) {
      const like = document.createElement('span');
      like.className = 'like-mark';
      like.innerHTML =
        '<svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 22V10l5-8a2.5 2.5 0 0 1 2.4 3.2L13.6 9H19a2 2 0 0 1 1.9 2.6l-2.1 7A2 2 0 0 1 16.9 20H7z"/></svg>已赞';
      meta.appendChild(like);
    }

    const excerpt = document.createElement('div');
    excerpt.className = 'history-item-excerpt';
    excerpt.textContent = item.script || '';

    info.appendChild(title);
    info.appendChild(meta);
    info.appendChild(excerpt);

    const actions = document.createElement('div');
    actions.className = 'history-actions';

    // 重听
    const replay = document.createElement('button');
    replay.className = 'history-btn';
    replay.title = '重听';
    replay.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5.5v13l11-6.5z"/></svg>';
    replay.addEventListener('click', () => replayHistory(item));

    // 删除
    const del = document.createElement('button');
    del.className = 'history-btn danger';
    del.title = '删除';
    del.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6.5 7l.8 12.2A1.5 1.5 0 0 0 8.8 20.5h6.4a1.5 1.5 0 0 0 1.5-1.3L17.5 7"/></svg>';
    del.addEventListener('click', () => {
      Storage.remove(item.id);
      openHistory();
      showToast('已删除这条记录');
    });

    actions.appendChild(replay);
    actions.appendChild(del);

    el.appendChild(thumb);
    el.appendChild(info);
    el.appendChild(actions);

    return el;
  }

  /** 从历史记录重听（不再调用生成接口，直接复用已保存内容） */
  function replayHistory(item) {
    Speech.stop();
    state.currentImages = item.thumb ? [item.thumb] : [];
    state.currentRecognition = { spot: item.spot || item.location || '', name: item.pointName };
    state.currentGuide = null;

    renderGuide(
      {
        title: item.title,
        script: item.script,
        sections: item.sections || [{ text: item.script, type: 'history' }],
        sources: item.sources || [],
        nearby: item.nearby || [],
        insufficient: item.insufficient === true,
      },
      item.pointName,
      item.location || ''
    );

    // renderGuide 会新建记录，这里改回原记录以保证点赞写回同一条
    Storage.remove(state.currentRecordId);
    state.currentRecordId = item.id;

    showScreen('guide');
    setTimeout(() => {
      if (Speech.isSupported()) Speech.play();
    }, 600);
  }

  // ---------- 音色设置 ----------

  function openVoicePanel() {
    renderProviderSeg();
    renderVoiceList();
    voiceOverlay.classList.add('is-open');
  }

  /** 渲染音质档位（高清音色 / 系统音色） */
  function renderProviderSeg() {
    const providers = Speech.listProviders();
    providerSeg.innerHTML = '';
    providers.forEach((p) => {
      const btn = document.createElement('button');
      btn.className = p.active ? 'is-active' : '';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', p.active ? 'true' : 'false');
      btn.innerHTML = `
        <span>${escapeHtml(p.name)}</span>
        <span class="seg-sub">${p.needNet ? '需联网 · 接近真人' : '离线可用'}</span>
      `;
      btn.addEventListener('click', async () => {
        if (p.active) return;
        const ok = Speech.setProvider(p.id);
        if (!ok) {
          showToast('切换失败，请重试');
          return;
        }
        renderProviderSeg();
        await renderVoiceList();
        Speech.preview();
        showToast(`已切换到${p.name}`);
      });
      providerSeg.appendChild(btn);
    });
  }

  async function renderVoiceList() {
    // 先显示加载态（edge 音色需要联网拉取）
    voiceList.innerHTML = '<div class="voice-loading">正在获取音色…</div>';
    const current = Speech.getCurrentVoice();

    let list = [];
    try {
      list = await Speech.listVoices();
    } catch (e) {
      list = [];
    }

    voiceList.innerHTML = '';

    if (!list.length) {
      voiceNote.hidden = false;
      // App 内有原生系统 TTS 兜底，不算"没有音色"
      const hasNative = typeof window !== 'undefined' && window.NativeEdgeTts &&
        typeof window.NativeEdgeTts.sysSpeak === 'function';
      voiceNote.textContent = hasNative
        ? '已使用设备内置系统语音引擎播报。'
        : '当前浏览器未提供可用音色，讲解将以文字形式呈现。';
      return;
    }

    const isEdge = Speech.getProvider() === 'edge';
    voiceNote.hidden = !isEdge ? list.some((v) => v.emotional) : true;

    // 高清音色：把每个音色的试听音频在后台逐个合成好（每句约 20KB），
    // 用户点谁谁秒出 —— 这是"选完音色要等三四秒"的根本解法。
    // 串行预热避免 8 个请求同时打出去；失败无所谓，正式点时会重试。
    if (isEdge && typeof Speech.warmPreview === 'function') {
      let chain = Promise.resolve();
      list.forEach((v) => {
        chain = chain.then(() => Speech.warmPreview(v.id)).catch(() => {});
      });
    }

    list.forEach((item) => {
      const btn = document.createElement('button');
      btn.className = 'voice-item';
      const active = current && (current.id === item.id || current.name === item.name);
      btn.classList.toggle('is-active', active);

      let tag = item.lang || '系统音色';
      if (isEdge) {
        tag = `${item.gender || ''}声 · ${item.desc || '神经网络音色'}`.trim();
      } else if (item.emotional) {
        tag = '情感型 · 推荐';
      }

      btn.innerHTML = `
        <span class="voice-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 5 6.5 9H3v6h3.5L11 19z"/>
            <path d="M15.5 8.5a5 5 0 0 1 0 7"/>
          </svg>
        </span>
        <span class="voice-info">
          <span class="voice-name">${escapeHtml(item.name)}${item.recommend ? ' <em class="voice-rec">推荐</em>' : ''}</span>
          <span class="voice-tag ${item.emotional ? 'warm' : ''}">${escapeHtml(tag)}</span>
        </span>
        ${active ? '<span class="voice-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>' : ''}
      `;

      btn.addEventListener('click', () => {
        const ok = Speech.setVoiceByName(item.id || item.name);
        if (!ok) {
          showToast('切换音色失败');
          return;
        }
        // 音色切换要及时生效：先掐掉正在播的旧音色音频，再立刻用新音色试听。
        // 试听音频在面板渲染时已预热（未命中时 Speech 会提示"正在合成试听…"），
        // 这里点击后基本是秒出声。
        Speech.stopPreview();
        Speech.preview();
        renderVoiceList();
        showToast(`已切换为「${item.name}」`);
      });

      voiceList.appendChild(btn);
    });
  }

  // ---------- 模型设置（直连模式）----------

  function setConnState(kind, statusText, metaText = '') {
    connDot.className = `conn-dot ${kind}`; // ok | bad | loading
    connStatus.textContent = statusText;
    connMeta.textContent = metaText;
  }

  function showProbe(el, text, kind = 'info') {
    el.hidden = false;
    el.className = `probe-result ${kind}`;
    el.textContent = text;
  }

  /** 按当前配置渲染状态卡（直连 vs 中转） */
  function refreshConnCard() {
    if (API.useBackend()) {
      const src = AppConfig.baseSource();
      setConnState(
        'ok',
        '中转后端模式',
        `${AppConfig.base() || location.origin}（${src === 'user' ? '你填的' : '打包内置'}）`,
      );
      return;
    }
    const c = AppConfig.llm();
    if (!c.apiKey || !c.baseUrl || !c.modelVision || !c.modelText) {
      setConnState('loading', '还没配置完', '填好下面的密钥、地址、模型就能用了');
      return;
    }
    setConnState(
      'ok',
      '直连模式（本机配置）',
      `${c.baseUrl} · 识别 ${c.modelVision} · 生成 ${c.modelText}`,
    );
  }

  /** 填充表单 */
  function fillForm() {
    const c = AppConfig.llm();

    // 服务商下拉
    inputProvider.innerHTML = AppConfig.PROVIDER_PRESETS.map(
      (p) => `<option value="${escapeHtml(p.id)}"${p.id === c.provider ? ' selected' : ''}>${escapeHtml(p.name)}</option>`,
    ).join('');
    const preset = AppConfig.getPreset(c.provider);
    providerHint.textContent = preset.hint || '';

    // 地址 / 模型回填（用户已保存的值优先，没有则用预设）
    inputBaseUrl.value = c.baseUrl || preset.baseUrl || '';
    inputModelVision.value = c.modelVision || preset.modelVision || '';
    inputModelText.value = c.modelText || preset.modelText || '';

    // 密钥只回填掩码，绝不显示明文
    const mask = AppConfig.maskKey(c.apiKey);
    inputApiKey.value = '';
    inputApiKey.placeholder = mask ? `已保存：${mask}（留空 = 不修改）` : 'sk-...';
    keyTag.textContent = mask ? `已保存 ${mask}` : '未填写';
    keyTag.className = `field-tag ${mask ? 'on' : ''}`;
    const clearBox = $('chkClearKey');
    if (clearBox) {
      clearBox.checked = false;
      // 没存过密钥时，"清空"没有意义，直接禁用避免误解
      const wrap = clearBox.closest('.field-inline');
      if (wrap) wrap.hidden = !mask;
    }
    providerTag.textContent = preset.baseUrl ? '已带出地址' : '需手填';

    // 中转后端
    inputRelayUrl.value = AppConfig.base() || '';
  }

  /** 渲染语音音色信息 */
  function renderVoiceInfo() {
    const provider = Speech.getProvider();
    const cur = Speech.getCurrentVoice();
    const direct = typeof EdgeTts !== 'undefined' && !API.useBackend();
    const rows = [
      ['当前音色', cur ? cur.name : '未选择'],
      ['音色来源', provider === 'edge' ? (API.useBackend() ? '高清音色（经后端）' : '高清音色（直连）') : '设备自带'],
      ['播放方式', provider === 'edge' ? (direct ? '浏览器原生直连，无需后端' : '后端代理合成') : '设备离线合成'],
    ];
    voiceInfoList.innerHTML = rows
      .map(
        ([k, v]) =>
          `<div class="kv-item"><span class="kv-k">${escapeHtml(k)}</span><span class="kv-v">${escapeHtml(String(v))}</span></div>`,
      )
      .join('');
  }

  function openSettingsPanel() {
    settingsOverlay.classList.add('is-open');
    serverResult.hidden = true;
    probeResult.hidden = true;
    fillForm();
    refreshConnCard();
    renderVoiceInfo();
  }

  // 切换服务商 → 自动带出地址与模型（用户已填过的值不覆盖）
  inputProvider.addEventListener('change', () => {
    const p = AppConfig.getPreset(inputProvider.value);
    providerHint.textContent = p.hint || '';
    providerTag.textContent = p.baseUrl ? '已带出地址' : '需手填';
    if (p.baseUrl) inputBaseUrl.value = p.baseUrl;
    if (p.modelVision) inputModelVision.value = p.modelVision;
    if (p.modelText) inputModelText.value = p.modelText;
    if (p.hint) showProbe(serverResult, p.hint, 'info');
  });

  // 测试连接
  $('btnServerTest').addEventListener('click', async () => {
    // 先临时用表单里的值做一次自检（不保存）
    const probeCfg = {
      provider: inputProvider.value,
      baseUrl: inputBaseUrl.value.trim(),
      apiKey: inputApiKey.value.trim() || AppConfig.llm().apiKey,
      modelVision: inputModelVision.value.trim(),
      modelText: inputModelText.value.trim(),
    };
    if (!probeCfg.apiKey) {
      showProbe(serverResult, '✗ 请先填写 API 密钥', 'bad');
      return;
    }
    if (!probeCfg.baseUrl) {
      showProbe(serverResult, '✗ 请先填写接口地址', 'bad');
      return;
    }
    showProbe(serverResult, '正在测试…（首次连接可能需要几秒）', 'info');

    const saved = AppConfig.llm();
    // 临时把表单值落到存储里，让 Engine 用最新的配置去测
    AppConfig.saveLlm(probeCfg);
    try {
      const r = await Engine.selfTest();
      if (r.ok) {
        const parts = [`✓ 连接成功（${r.ms}ms）`];
        if (r.modelCount) parts.push(`可用模型 ${r.modelCount} 个`);
        const c = AppConfig.llm();
        if (r.modelCount && !r.hasVisionModel) {
          parts.push(`⚠ 列表里没看到「${c.modelVision}」，确认下模型名对不对`);
        }
        showProbe(serverResult, parts.join('｜'), r.hasVisionModel || !r.modelCount ? 'ok' : 'info');
      } else {
        showProbe(serverResult, `✗ 连接失败：${r.error}`, 'bad');
      }
    } catch (e) {
      showProbe(serverResult, `✗ 测试出错：${e.message}`, 'bad');
    } finally {
      // 若用户只是"测试连接"而没点保存，要把密钥还原回去。
      // 原来用 saveLlm({apiKey: 旧值})，但空密钥会被当成"不改"而跳过，
      // 导致"本来没配密钥 → 测试时临时填了 → 测试完没保存"的场景下
      // 临时密钥被永久留下。这里改用显式语义。
      if (!inputApiKey.value.trim()) {
        if (saved.apiKey) AppConfig.saveLlm({ apiKey: saved.apiKey });
        else AppConfig.saveLlm({ clearApiKey: true });
      }
      refreshConnCard();
    }
  });

  // 保存并生效
  $('btnServerSave').addEventListener('click', () => {
    const clearKey = Boolean($('chkClearKey') && $('chkClearKey').checked);
    const payload = {
      provider: inputProvider.value,
      apiKey: inputApiKey.value.trim(), // 空 = 不改
      baseUrl: inputBaseUrl.value.trim(),
      modelVision: inputModelVision.value.trim(),
      modelText: inputModelText.value.trim(),
    };
    if (clearKey) payload.clearApiKey = true;
    if (!payload.baseUrl) {
      showProbe(serverResult, '✗ 接口地址不能为空', 'bad');
      return;
    }
    if (/\/chat\/completions\/?$/i.test(payload.baseUrl)) {
      showProbe(serverResult, '✗ 地址不要带 /chat/completions，填到 /v1 即可', 'bad');
      return;
    }
    if (!payload.modelVision || !payload.modelText) {
      showProbe(serverResult, '✗ 识别模型与生成模型都不能为空', 'bad');
      return;
    }
    if (!AppConfig.saveLlm(payload)) {
      showProbe(serverResult, '✗ 保存失败，本机存储权限异常', 'bad');
      return;
    }

    const c = AppConfig.llm();
    if (!c.apiKey) {
      showProbe(serverResult, '⚠ 已保存，但还没填 API 密钥，无法调用', 'info');
    } else {
      showProbe(serverResult, '✓ 已保存，立即生效（无需重装）', 'ok');
    }
    fillForm();
    refreshConnCard();
    showToast('模型设置已保存');
  });

  // 去换音色
  $('btnGoVoice').addEventListener('click', () => {
    settingsOverlay.classList.remove('is-open');
    setTimeout(() => openVoicePanel(), 220);
  });

  // 高级面板展开
  $('btnAdvToggle').addEventListener('click', () => {
    advBody.hidden = !advBody.hidden;
    $('btnAdvToggle').classList.toggle('is-open', !advBody.hidden);
  });

  // 测试中转后端地址
  $('btnTestBase').addEventListener('click', async () => {
    const v = inputRelayUrl.value.trim();
    if (!v) {
      showProbe(probeResult, '留空即直连模式，不需要后端', 'info');
      return;
    }
    showProbe(probeResult, '正在测试…', 'info');
    const r = await AppConfig.probe(v);
    if (r.ok) {
      const d = r.info || {};
      showProbe(probeResult, `✓ 连接成功（${r.ms}ms）｜${d.provider || '-'} / ${d.modelVision || '-'}`, 'ok');
    } else {
      showProbe(probeResult, `✗ 连接失败：${r.error}`, 'bad');
    }
  });

  // 保存中转后端地址
  $('btnSaveBase').addEventListener('click', async () => {
    const v = inputRelayUrl.value.trim();
    if (!v) {
      AppConfig.clearBase();
      showProbe(probeResult, '✓ 已切回直连模式（不用后端）', 'ok');
      refreshConnCard();
      showToast('已切回直连模式');
      return;
    }
    showProbe(probeResult, '正在验证…', 'info');
    const r = await AppConfig.testAndSave(v);
    if (!r.ok) {
      showProbe(probeResult, `✗ 地址不可用，未保存：${r.error}`, 'bad');
      return;
    }
    inputRelayUrl.value = AppConfig.base();
    showProbe(probeResult, `✓ 已保存，之后由后端代管密钥（${r.ms}ms）`, 'ok');
    refreshConnCard();
    showToast('已切换为中转后端模式');
  });

  $('btnSettingsClose').addEventListener('click', () => {
    settingsOverlay.classList.remove('is-open');
    Speech.stop();
    if (Speech.getSentenceCount() > 0 && screens.guide.classList.contains('is-active')) {
      setTimeout(() => Speech.play(), 200);
    }
  });

  $('btnSettings').addEventListener('click', openSettingsPanel);
  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) settingsOverlay.classList.remove('is-open');
  });

  // ---------- 播放器 UI 同步 ----------

  function setPlayIcon(playing) {
    if (playing) {
      playIcon.innerHTML = '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>';
      btnPlay.setAttribute('aria-label', '暂停');
    } else {
      playIcon.innerHTML = '<path d="M8 5.5v13l11-6.5z"/>';
      btnPlay.setAttribute('aria-label', '播放');
    }
  }

  function highlightSection(index) {
    state.sections.forEach((el, i) => {
      el.classList.toggle('is-speaking', i === index);
    });
    if (index >= 0 && state.sections[index]) {
      const el = state.sections[index];
      const scroll = $('guideScroll');
      const elTop = el.offsetTop;
      const scrollTop = scroll.scrollTop;
      const viewH = scroll.clientHeight;
      // 当前段落不在视口舒适区时自动滚动
      if (elTop < scrollTop + 80 || elTop > scrollTop + viewH - 160) {
        scroll.scrollTo({ top: elTop - 110, behavior: 'smooth' });
      }
    }
  }

  // 注册语音回调
  Speech.on({
    notice: (msg) => {
      showToast(msg);
    },
    sentenceChange: (idx) => {
      highlightSection(idx);
    },
    stateChange: (st) => {
      setPlayIcon(st === 'playing');
      playerLabel.textContent =
        st === 'playing' ? '讲解中' : st === 'paused' ? '已暂停' : '讲解完毕';
      if (st === 'idle') {
        highlightSection(-1);
        progressFill.style.width = '0%';
        timeCurrent.textContent = '0:00';
      }
    },
    progress: (idx, ratio) => {
      if (idx < 0) {
        progressFill.style.width = '0%';
        return;
      }
      const total = Speech.getSentenceCount() || 1;
      const overall = (idx + ratio) / total;
      progressFill.style.width = `${Math.min(100, overall * 100)}%`;
      const totalSeconds = estimateTotalDuration(
        state.sections.map((el) => el.querySelector('p').textContent)
      );
      timeCurrent.textContent = formatTime(overall * totalSeconds);
    },
  });

  // ---------- 事件绑定 ----------

  // 拍照（单张）
  $('btnCapture').addEventListener('click', () => cameraInput.click());
  // 相册（支持多选）
  $('btnGallery').addEventListener('click', () => galleryInput.click());
  // 手动输入名字
  $('btnManual').addEventListener('click', () => {
    state.currentImages = [];
    confirmImage.src = '';
    confirmOverlay.classList.add('is-open');
    goManualMode('说说你想了解哪里', '');
  });

  cameraInput.addEventListener('change', (e) => {
    // FileList 是活引用：必须先拷贝成数组再清空 input，否则拿到空列表
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    const append = pendingAppend;
    pendingAppend = false;
    handleFiles(files, append);
  });

  galleryInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    const append = pendingAppend;
    pendingAppend = false;
    handleFiles(files, append);
  });

  // 确认弹层里的"再加一张照片" → 追加模式重新识别
  btnAddPhoto.addEventListener('click', () => {
    if (state.currentImages.length >= MAX_IMAGES) {
      showToast(`最多 ${MAX_IMAGES} 张照片了`);
      return;
    }
    addPhotoHint.hidden = false;
    pendingAppend = true;
    setTimeout(() => galleryInput.click(), 160);
  });

  // 示例引导
  $('hintsRow').addEventListener('click', (e) => {
    const chip = e.target.closest('.hint-chip');
    if (!chip) return;
    const name = chip.dataset.hint;
    state.currentImages = [];
    generateGuide(name, '');
  });

  // 确认弹层
  $('btnConfirmOk').addEventListener('click', () => {
    const r = state.currentRecognition;
    if (!r) return;

    // 识别失败态：这个按钮是"重新拍一张"，回到首页重新选图（全新识别）
    if (!r.recognized || (!r.name && !r.spot)) {
      closeConfirm();
      // 重置识别结果，避免下一次又被旧结果干扰
      state.currentRecognition = null;
      state.currentImages = [];
      pendingAppend = false;
      showToast('换个角度，把主体拍清楚一点再试');
      setTimeout(() => galleryInput.click(), 220);
      return;
    }

    // 点位名优先，没有则用景区名；景区作为位置提示传给生成
    const point = r.name || r.spot;
    const hint = r.spot && r.spot !== point ? r.spot : r.city ? `${r.city}${r.spot || ''}` : '';
    generateGuide(point, hint, r.plaqueText || '');
  });

  $('btnCorrect').addEventListener('click', () => {
    const r = state.currentRecognition;
    goManualMode('那你说说这是哪儿', '');
    manualInput.placeholder = '例如：寒山寺 / 平江路 24 号';
    if (r && r.spot) manualInput.placeholder = `例如：${r.spot}里的某个点位`;
    else if (r && r.name) manualInput.placeholder = `例如：${r.name}附近的其他建筑`;
  });

  $('btnManualSubmit').addEventListener('click', () => {
    const val = manualInput.value.trim();
    if (!val) {
      showToast('请输入地点名称');
      return;
    }
    generateGuide(val, '');
  });

  manualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('btnManualSubmit').click();
    }
  });

  // 点击遮罩关闭
  confirmOverlay.addEventListener('click', (e) => {
    if (e.target === confirmOverlay) closeConfirm();
  });

  // 返回首页
  $('btnBackHome').addEventListener('click', () => {
    Speech.stop();
    showScreen('home');
  });

  // 再拍一处
  function rescan() {
    Speech.stop();
    setTimeout(() => cameraInput.click(), 200);
  }
  $('btnRescan').addEventListener('click', rescan);
  $('btnBottomRescan').addEventListener('click', rescan);

  // 播放 / 暂停
  btnPlay.addEventListener('click', () => {
    if (!Speech.isSupported()) {
      showToast('当前浏览器不支持语音播报，可阅读文字讲解');
      return;
    }
    if (Speech.getState() === 'playing') {
      Speech.pause();
    } else {
      Speech.play();
    }
  });

  // 进度条点击跳转
  progressTrack.addEventListener('click', (e) => {
    if (!Speech.isSupported()) return;
    const rect = progressTrack.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const idx = Math.min(
      Speech.getSentenceCount() - 1,
      Math.floor(ratio * Speech.getSentenceCount())
    );
    Speech.jumpTo(idx);
  });

  // 来源展开
  sourcesToggle.addEventListener('click', () => {
    const open = !sourcesDetail.hidden;
    sourcesDetail.hidden = open;
    sourcesToggle.classList.toggle('is-open', !open);
  });

  // 历史（完整足迹页）
  $('btnHistory').addEventListener('click', openHistory);
  $('btnHistoryBack').addEventListener('click', () => {
    Speech.stop();
    showScreen('home');
  });

  // 音色设置
  $('btnVoice').addEventListener('click', openVoicePanel);  $('btnVoiceClose').addEventListener('click', () => {
    voiceOverlay.classList.remove('is-open');
    Speech.stop();
    if (Speech.getSentenceCount() > 0 && screens.guide.classList.contains('is-active')) {
      setTimeout(() => Speech.play(), 200);
    }
  });
  voiceOverlay.addEventListener('click', (e) => {
    if (e.target === voiceOverlay) voiceOverlay.classList.remove('is-open');
  });

  // 点赞
  btnLike.addEventListener('click', handleLike);

  // 页面卸载时停止播报，避免残留
  window.addEventListener('beforeunload', () => {
    try {
      Speech.stop();
    } catch (e) {
      /* ignore */
    }
  });

  // ---------- 启动自检 ----------
  (async function bootstrap() {
    // 调试模式：?demo=1 直接渲染讲解页（用于截图验收，不走真实 API）
    const params = new URLSearchParams(location.search);
    if (params.get('demo')) {
      demoRender(params);
      return;
    }

    // 首次使用：还没填模型设置 → 自动引导（否则拍照后一无所获）
    const configured = API.useBackend() || AppConfig.llmReady();
    if (!configured && !AppConfig.firstRunDone() && !params.get('skipintro')) {
      AppConfig.markFirstRunDone();
      showScreen('home');
      openSettingsPanel();
      showToast('首次使用：先填一下模型设置，之后就能拍照讲解了', 5600);
      return;
    }

    // 已配置过但这次发现不完整：温和提示，不打断
    if (!configured) {
      showToast('模型设置还不完整，点右上角齿轮补上', 5200);
      return;
    }

    if (API.useBackend()) {
      // 中转模式：确认后端在线
      try {
        const h = await API.health();
        if (!h.hasKey) {
          showToast('后端还没配置 API 密钥，请打开「模型设置」填写', 6000);
          setTimeout(() => {
            if (!settingsOverlay.classList.contains('is-open')) openSettingsPanel();
          }, 700);
        }
      } catch (e) {
        showToast('连不上中转后端，请检查「模型设置」里的地址', 6000);
        setTimeout(() => {
          if (!settingsOverlay.classList.contains('is-open')) openSettingsPanel();
        }, 700);
      }
    }
  })();

  /** 演示数据渲染（截图/调试用） */
  function demoRender(params = new URLSearchParams()) {
    const demo = {
      title: '金銮殿不止叫太和殿',
      script:
        '你抬头看，这座殿的屋顶几乎要够到天了。整个紫禁城里，没有哪座建筑敢比它更大、更高。你现在站的地方，就是太和殿。它还有个更响亮的名字，叫金銮殿。明永乐十八年，也就是一四二零年，它第一次出现在这里，那时候还不叫太和殿，叫奉天殿。后来几百年里，它遭过灾，被毁过，又重建过。明朝嘉靖年间，名字改成了皇极殿。到了清朝建都北京以后，才改成我们今天叫的太和殿。你眼前看到的这座，主要是在清康熙三十四年开始重建，两年后完工的。几百年里，它一次次被毁掉，又一次次在原处站起来。皇帝在这里举行最盛大的典礼，文武百官跪在下面，山呼万岁。你仔细看殿内的皇帝宝座，那是整个空间里唯一有资格坐在高处的位置。还有一个东西，叫龙门宝匣，也是太和殿里有名的物件。最后说个小细节，太和殿的屋顶脊兽有十个，是全国独一份，连皇帝都得让它三分。',
      sections: [
        { text: '你抬头看，这座殿的屋顶几乎要够到天了。整个紫禁城里，没有哪座建筑敢比它更大、更高。你现在站的地方，就是太和殿。它还有个更响亮的名字，叫金銮殿。', type: 'hook' },
        { text: '明永乐十八年，也就是一四二零年，它第一次出现在这里，那时候还不叫太和殿，叫奉天殿。后来几百年里，它遭过灾，被毁过，又重建过。明朝嘉靖年间，名字改成了皇极殿。到了清朝建都北京以后，才改成我们今天叫的太和殿。', type: 'history' },
        { text: '你眼前看到的这座，主要是在清康熙三十四年开始重建，两年后完工的。几百年里，它一次次被毁掉，又一次次在原处站起来。皇帝在这里举行最盛大的典礼，文武百官跪在下面，山呼万岁。', type: 'story' },
        { text: '最后说个小细节，太和殿的屋顶脊兽有十个，是全国独一份，连皇帝都得让它三分。', type: 'trivia' },
      ],
      keywords: ['太和殿', '金銮殿', '奉天殿'],
      sources: [
        { name: '百度百科「太和殿」', url: 'https://baike.baidu.com/item/%E5%A4%AA%E5%92%8C%E6%AE%BF' },
        { name: '现场说明牌（由你拍摄）', url: '' },
        { name: '部分内容基于 AI 知识整理（建议实地核对说明牌）', url: '' },
      ],
      nearby: [
        { name: '中和殿', intro: '太和殿身后的小型方殿' },
        { name: '保和殿', intro: '三大殿中最后一座' },
        { name: '太和殿广场的日晷', intro: '殿前计时礼仪器具' },
      ],
      insufficient: false,
    };

    // 生成占位图（模拟实拍）
    function makeImage(label, hueA, hueB) {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      const grad = ctx.createLinearGradient(0, 0, 640, 360);
      grad.addColorStop(0, hueA);
      grad.addColorStop(1, hueB);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.font = '40px serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, 320, 190);
      return canvas.toDataURL('image/jpeg', 0.8);
    }

    state.currentImages = [makeImage('太 和 殿', '#3a5a58', '#1c2f31')];
    state.currentRecognition = { spot: '北京故宫', name: '太和殿', city: '北京市', plaqueText: '', confidence: 0.92 };
    // ?demo=1&noimg=1 → 模拟"说个名字"进来的无照片场景（调试用）
    if (params.get('noimg')) state.currentImages = [];

    renderGuide(demo, '太和殿', '北京故宫');
    showScreen('guide');

    // ?demo=1&view=confirm → 打开确认弹层
    if (params.get('view') === 'confirm') {
      state.currentImages = [
        makeImage('太 和 殿', '#3a5a58', '#1c2f31'),
        makeImage('说 明 牌', '#5a4a3a', '#2f2318'),
      ];
      state.currentRecognition = {
        spot: '北京故宫',
        name: '太和殿',
        city: '北京市',
        confidence: 0.92,
        plaqueText: '太和殿，俗称金銮殿，明永乐十八年建成，现存建筑为清康熙三十四年重建。',
        reason: '重檐庑殿顶，三层汉白玉基座，前有宽阔广场',
        recognized: true,
      };
      showScreen('home');
      confirmImage.src = state.currentImages[0];
      confirmNormal.hidden = false;
      confirmManual.hidden = true;
      recogThumbs.hidden = false;
      recogThumbs.innerHTML = state.currentImages.map((s) => `<img src="${s}" alt="" />`).join('');
      spotLayer.hidden = false;
      spotName.textContent = '北京故宫';
      confirmQuestion.hidden = false;
      confirmQuestion.textContent = '这处是';
      confirmName.textContent = '太和殿';
      confirmName.hidden = false;
      confirmReason.textContent = state.currentRecognition.reason;
      confirmReason.hidden = false;
      plaqueChip.hidden = false;
      recogBadge.classList.remove('is-low');
      recogBadgeText.textContent = '识别完成';
      confirmOverlay.classList.add('is-open');
    }

    // ?demo=1&view=confirmfail → 打开"识别失败"确认弹层（验证失败态文案与按钮）
    if (params.get('view') === 'confirmfail') {
      state.currentImages = [makeImage('未 能 识 别', '#6b625a', '#2b2723')];
      state.currentRecognition = {
        recognized: false,
        spot: '',
        name: '',
        city: '',
        plaqueText: '',
        confidence: 0.2,
        reason: '画面里没有可辨认的标志性建筑',
      };
      showScreen('home');
      openConfirm(state.currentRecognition);
    }

    // ?demo=1&view=bottom → 滚动到底部（来源+附近推荐）+ 点赞态
    if (params.get('view') === 'bottom') {
      setTimeout(() => {
        const sc = $('guideScroll');
        sc.scrollTop = sc.scrollHeight;
        highlightSection(1);
        progressFill.style.width = '42%';
        timeCurrent.textContent = '0:28';
        setPlayIcon(true);
        playerLabel.textContent = '讲解中';
        syncLikeUI(true);
      }, 350);
    }

    // ?demo=1&view=history → 足迹页
    if (params.get('view') === 'history') {
      // 造几条演示记录
      Storage.clear();
      const seeds = [
        { pointName: '太和殿', spot: '北京故宫', location: '北京故宫', title: '金銮殿不止叫太和殿', liked: true },
        { pointName: '枫桥夜泊诗碑', spot: '寒山寺', location: '苏州市寒山寺', title: '一块诗碑，千年回响', liked: true },
        { pointName: '黄鹤楼', spot: '黄鹤楼公园', location: '武汉市黄鹤楼', title: '一座楼，半部江城史', liked: false },
      ];
      seeds.forEach((s, i) => {
        const rec = Storage.add({
          ...s,
          script: '这里是一段讲解的文字节选，用于展示历史记录的摘要显示效果。走过的每一处都会留在这里，随时可以重听。',
          sections: [],
          sources: [],
          nearby: [],
          thumb: makeImage(s.pointName.slice(0, 3), '#3a5a58', '#1c2f31'),
        });
        if (s.liked) Storage.update(rec.id, { liked: true });
        // 错开时间
        Storage.update(rec.id, { createdAt: Date.now() - (i + 1) * 3600000 * 5 });
      });
      openHistory();
    }

    // ?demo=1&view=voice → 音色面板
    if (params.get('view') === 'voice') {
      showScreen('home');
      openVoicePanel();
    }

    // ?demo=1&view=settings → 模型设置面板
    if (params.get('view') === 'settings') {
      showScreen('home');
      settingsOverlay.classList.add('is-open');
      fillForm();
      Promise.resolve().then(() => {
        refreshConnCard();
        renderVoiceInfo();
      });
    }
  }
})();
