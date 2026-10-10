/**
 * 本地存储 —— 讲解历史记录（我的足迹）
 * 使用 localStorage，原型阶段够用；App 阶段可换 IndexedDB 或云端同步
 */

const Storage = (() => {
  const KEY = 'private_guide_history_v1';
  const MAX_ITEMS = 50;

  function readAll() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.warn('[storage] 读取失败：', e.message);
      return [];
    }
  }

  function writeAll(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_ITEMS)));
      return true;
    } catch (e) {
      // 图片 base64 可能撑爆配额，降级为不存图
      try {
        const slim = list.slice(0, MAX_ITEMS).map((it) => ({ ...it, thumb: '' }));
        localStorage.setItem(KEY, JSON.stringify(slim));
        return true;
      } catch (e2) {
        console.warn('[storage] 写入失败：', e2.message);
        return false;
      }
    }
  }

  /**
   * 新增一条记录
   * @param {Object} item { pointName, spot, location, title, script, sections, sources, nearby, thumb, images }
   */
  function add(item) {
    const list = readAll();
    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      liked: false,
      ...item,
    };
    // 去重：同一点位只保留最新一条（但保留原有点赞状态）
    const old = list.find((it) => it.pointName === item.pointName);
    if (old && old.liked) record.liked = true;
    const filtered = list.filter((it) => it.pointName !== item.pointName);
    filtered.unshift(record);
    writeAll(filtered);
    return record;
  }

  /** 更新某条记录（如点赞） */
  function update(id, patch) {
    const list = readAll();
    const idx = list.findIndex((it) => it.id === id);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...patch };
    writeAll(list);
    return list[idx];
  }

  /** 切换点赞状态 */
  function toggleLike(id) {
    const list = readAll();
    const item = list.find((it) => it.id === id);
    if (!item) return false;
    item.liked = !item.liked;
    writeAll(list);
    return item.liked;
  }

  /** 查找某点位最新一条记录 */
  function findLatestByPoint(pointName) {
    return readAll().find((it) => it.pointName === pointName) || null;
  }

  function getAll() {
    return readAll();
  }

  function remove(id) {
    const list = readAll().filter((it) => it.id !== id);
    writeAll(list);
  }

  function clear() {
    try {
      localStorage.removeItem(KEY);
    } catch (e) {
      /* ignore */
    }
  }

  return { add, getAll, update, toggleLike, findLatestByPoint, remove, clear };
})();
