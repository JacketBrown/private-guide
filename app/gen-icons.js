/**
 * 生成 App 图标与启动图（纯 Node，无外部依赖）
 *
 * 输出到 android/app/src/main/res/ 的各个 mipmap 目录。
 * 图形：深青绿底 + 白色相机轮廓 + 一点金色点缀，与网页主题一致。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- 极简 PNG 编码器 ----------
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // 逐行加 filter byte
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 绘制 ----------
function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/**
 * 画图标：圆角矩形底 + 相机轮廓
 * @param {number} size 边长
 * @param {boolean} round 是否圆形（部分启动图标用圆）
 */
function drawIcon(size, round = false) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const cx = size / 2;

  const [bgR, bgG, bgB] = hex('#2b4444');       // 深青绿（主题色）
  const [acR, acG, acB] = hex('#c9a227');       // 金色点缀
  const white = [255, 255, 255];

  const set = (x, y, rgb, alpha = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = alpha;
  };

  // 圆角半径
  const radius = round ? size / 2 : size * 0.22;

  const inRoundRect = (x, y) => {
    if (round) {
      const dx = x - cx + 0.5, dy = y - cx + 0.5;
      return dx * dx + dy * dy <= (cx - 1) * (cx - 1);
    }
    const r = radius;
    let px = x + 0.5, py = y + 0.5;
    if (px < r && py < r) return (px - r) ** 2 + (py - r) ** 2 <= r * r;
    if (px > size - r && py < r) return (px - (size - r)) ** 2 + (py - r) ** 2 <= r * r;
    if (px < r && py > size - r) return (px - r) ** 2 + (py - (size - r)) ** 2 <= r * r;
    if (px > size - r && py > size - r) return (px - (size - r)) ** 2 + (py - (size - r)) ** 2 <= r * r;
    return true;
  };

  // 底色
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inRoundRect(x, y)) set(x, y, [bgR, bgG, bgB], 255);
    }
  }

  // 相机主体（白色圆角矩形）
  const bw = size * 0.56, bh = size * 0.40;
  const bx = (size - bw) / 2, by = (size - bh) / 2 + size * 0.035;
  const br = size * 0.055;
  const inRound = (x, y, rx, ry, rw, rh, rr) => {
    if (x < rx || y < ry || x >= rx + rw || y >= ry + rh) return false;
    const px = x + 0.5, py = y + 0.5;
    if (px < rx + rr && py < ry + rr) return (px - rx - rr) ** 2 + (py - ry - rr) ** 2 <= rr * rr;
    if (px > rx + rw - rr && py < ry + rr) return (px - rx - rw + rr) ** 2 + (py - ry - rr) ** 2 <= rr * rr;
    if (px < rx + rr && py > ry + rh - rr) return (px - rx - rr) ** 2 + (py - ry - rh + rr) ** 2 <= rr * rr;
    if (px > rx + rw - rr && py > ry + rh - rr) return (px - rx - rw + rr) ** 2 + (py - ry - rh + rr) ** 2 <= rr * rr;
    return true;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inRound(x, y, bx, by, bw, bh, br)) set(x, y, white, 255);
    }
  }

  // 顶部取景凸起
  const tx = size / 2 - size * 0.09, ty = by - size * 0.055;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inRound(x, y, tx, ty, size * 0.18, size * 0.07, size * 0.025)) set(x, y, white, 255);
    }
  }

  // 镜头圆环（用底色抠出）
  const lensR = size * 0.115;
  const lensCx = size / 2, lensCy = by + bh / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - lensCx, dy = y + 0.5 - lensCy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= lensR) {
        const t = d / lensR;
        // 内圈金色渐变 → 深底
        if (t > 0.72) set(x, y, [bgR, bgG, bgB], 255);
        else set(x, y, [acR, acG, acB], 255);
      }
    }
  }

  return buf;
}

// ---------- 输出 ----------
const ANDROID_RES = path.join(__dirname, 'android', 'app', 'src', 'main', 'res');

const SIZES = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
};

function main() {
  if (!fs.existsSync(path.join(__dirname, 'android'))) {
    console.log('  ⚠ android/ 目录还不存在，先运行 npx cap add android');
    return;
  }

  console.log('  生成应用图标…');
  for (const [dir, size] of Object.entries(SIZES)) {
    const out = path.join(ANDROID_RES, dir);
    if (!fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });

    // 普通图标（圆角方形）
    fs.writeFileSync(path.join(out, 'ic_launcher.png'), encodePNG(size, size, drawIcon(size, false)));
    // 圆形图标
    fs.writeFileSync(path.join(out, 'ic_launcher_round.png'), encodePNG(size, size, drawIcon(size, true)));
    // 前景（自适应图标用，留安全边距）
    const fg = Math.round(size * 1.35);
    const fgBuf = Buffer.alloc(fg * fg * 4, 0);
    const inner = drawIcon(Math.round(fg * 0.66), false);
    const off = Math.round((fg - fg * 0.66) / 2);
    const iw = Math.round(fg * 0.66);
    for (let y = 0; y < iw; y++) {
      inner.copy(fgBuf, ((y + off) * fg + off) * 4, y * iw * 4, (y + 1) * iw * 4);
    }
    fs.writeFileSync(path.join(out, 'ic_launcher_foreground.png'), encodePNG(fg, fg, fgBuf));

    console.log(`    ${dir}: ${size}px`);
  }

  console.log('  ✓ 图标生成完成');
}

main();
