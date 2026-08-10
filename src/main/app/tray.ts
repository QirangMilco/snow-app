import {
  app,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
  type NativeImage,
} from "electron";
import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import type { NativeBridge } from "../native/types";
import {
  APP_FAVICON_16_PATH,
  APP_FAVICON_32_PATH,
  APP_ICON_PATH,
} from "./constants";
import { createWindow, getMainWindow, markCloseConfirmed } from "./mainWindow";
import { getActivePtyCount } from "../pty/ptyManager";
import { snowLog } from "../../utils/snowLogger";

/**
 * 系统托盘模块。
 *
 * 图标：
 * - macOS：从应用 LOGO 抠出的雪花模板图（纯黑 + alpha，系统按菜单栏背景
 *   即壁纸明暗自动反色，不受系统深浅色模式影响）。LOGO 是"白色圆角方形底
 *   + 蓝色雪花"，直接提取 alpha 会把白底带上、缩到 16px 糊成实心方块，故
 *   反解蓝色雪花覆盖度抠出雪花造型并去色，与 LOGO 完全统一。
 *   活动态（有会话进行中）：雪花右侧绘制活跃会话数（5x7 点阵数字），同为
 *   模板图，跟随壁纸整体反色，彻底避免待机/活动切换时的黑白跳变。
 * - Windows/Linux：LOGO 彩色 favicon 小图，活动态右下角叠加绿色圆点。
 *
 * 悬停 tooltip 展示快速信息（原生纯文本，无图标）：
 * 进行中会话 / 活跃终端 / 项目 / 待办备忘录 / 今日 Token 用量。
 *
 * 数据来源：进行中会话由渲染进程 IPC 推送；其余指标由主进程定时
 * 通过 Rust 后端异步查询（native bridge 已做 storageReady 门控，不阻塞）。
 */

// ─── 最小 PNG 编解码器（nativeImage 只可靠支持 PNG/JPEG）─────────────────

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buf: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
};

/** 将 RGBA 像素编码为标准 PNG（8bit、非隔行），供 nativeImage.createFromBuffer 使用。 */
const encodePng = (rgba: Uint8Array, width: number, height: number): Buffer => {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // 其余（压缩/滤波/隔行）保持 0

  // 每行前加 1 字节滤波类型（0 = None），行内为 RGBA 像素
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (1 + stride) + 1
    );
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

const paethPredictor = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
};

/**
 * 解码标准 PNG（8bit、非隔行，RGB/RGBA）为 RGBA 像素数组。
 * 仅用于解码托盘 favicon 以叠加活动角标；其他格式返回 null。
 */
const decodePng = (
  buffer: Buffer
): { width: number; height: number; rgba: Uint8Array } | null => {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) {
    return null;
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR" && data.length >= 13) {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idatChunks.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  // 仅支持 8bit、非隔行（interlace 字段为 0）、RGB(2)/RGBA(6)
  if (
    width === 0 ||
    height === 0 ||
    bitDepth !== 8 ||
    (colorType !== 2 && colorType !== 6)
  ) {
    return null;
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idatChunks));
  const rgba = new Uint8Array(width * height * 4);

  // 逐行还原滤波：up/upLeft 必须取上一行"还原后"的像素，
  // 而非原始压缩行数据（否则 Up/Average/Paeth 滤波行会解出错误颜色）。
  let prevLine = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (1 + stride)];
    const rowStart = y * (1 + stride) + 1;
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rowStart + x];
      const left = x >= channels ? line[x - channels] : 0;
      const up = prevLine[x];
      const upLeft = x >= channels ? prevLine[x - channels] : 0;
      let value = rawByte;
      switch (filter) {
        case 1:
          value = (rawByte + left) & 0xff;
          break;
        case 2:
          value = (rawByte + up) & 0xff;
          break;
        case 3:
          value = (rawByte + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          value = (rawByte + paethPredictor(left, up, upLeft)) & 0xff;
          break;
        default:
          break;
      }
      line[x] = value;
    }
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      rgba[out] = line[x * channels];
      rgba[out + 1] = line[x * channels + 1];
      rgba[out + 2] = line[x * channels + 2];
      rgba[out + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    prevLine = line;
  }

  return { width, height, rgba };
};

/** 在 RGBA 像素右下角叠加一个实心圆点（活动指示）。 */
const overlayActivityDot = (
  rgba: Uint8Array,
  width: number,
  height: number,
  color: [number, number, number, number]
): void => {
  const cx = width - 3.6;
  const cy = height - 3.6;
  const radius = 3.1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= radius) {
        const idx = (y * width + x) * 4;
        rgba[idx] = color[0];
        rgba[idx + 1] = color[1];
        rgba[idx + 2] = color[2];
        rgba[idx + 3] = color[3];
      }
    }
  }
};

// ─── 图标生成 ─────────────────────────────────────────────────────────────

// 活动态圆点颜色（仅 Windows/Linux）：绿色（与主题 accentGreen #22c55e 一致）。
// macOS 活动态改用模板图点阵数字，跟随菜单栏背景反色，不使用彩色圆点。
const GREEN_DOT: [number, number, number, number] = [34, 197, 94, 255];

/**
 * 从 LOGO 中抠出雪花图形，返回雪花覆盖度 mask（0~1 的 Float32Array）。
 *
 * LOGO 是"白色圆角方形底 + 蓝色雪花"。直接提取 alpha 会把白底一起带上，
 * 缩到 16px 糊成实心方块（即此前的"方块"图标）。这里反解蓝色雪花在白底
 * 上的覆盖度：雪花纯色的 r 通道（动态检测）与白底 r=255 差距最大，用 r
 * 通道线性反推每个像素属于雪花的比例 t = (255 - r) / (255 - snowR)，
 * 白底 t≈0 自动变透明，只留下与 LOGO 完全统一的雪花造型。
 *
 * LOGO 雪花线条较细，缩到托盘尺寸会过淡，故对 mask 做适度膨胀加粗。
 */
const extractSnowflakeMask = (
  rgba: Uint8Array,
  width: number,
  height: number
): Float32Array => {
  // 动态检测雪花纯色的 r 基准：取最蓝像素（b - max(r,g) 最大者）的 r 均值
  let bestBlue = -1;
  let rSum = 0;
  let rCount = 0;
  for (let i = 0; i < width * height; i++) {
    if (rgba[i * 4 + 3] < 128) {
      continue;
    }
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const blue = b - Math.max(r, g);
    if (blue > bestBlue) {
      bestBlue = blue;
      rSum = r;
      rCount = 1;
    } else if (blue === bestBlue) {
      rSum += r;
      rCount++;
    }
  }
  const snowR = rCount > 0 ? rSum / rCount : 114;

  // 反解雪花覆盖度：白底 r≈255 → 0，雪花纯色 r≈snowR → 1
  const cover = new Float32Array(width * height);
  const span = 255 - snowR;
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3] / 255;
    if (a <= 0) {
      continue;
    }
    const t = (255 - rgba[i * 4]) / span;
    cover[i] = Math.max(0, Math.min(1, t)) * a;
  }

  // 可分离膨胀（max filter）轻微加粗线条以改善小尺寸下的抗锯齿。
  // LOGO 雪花本身较粗，膨胀过大会粘连分支糊成一团，故半径取很小值（256px 下约 2px）。
  const radius = Math.max(1, Math.round(width * 0.008));
  const tmp = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let m = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= width) {
          continue;
        }
        const v = cover[y * width + xx];
        if (v > m) {
          m = v;
        }
      }
      tmp[y * width + x] = m;
    }
  }
  const dilated = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let m = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= height) {
          continue;
        }
        const v = tmp[yy * width + x];
        if (v > m) {
          m = v;
        }
      }
      dilated[y * width + x] = m;
    }
  }
  return dilated;
};

/**
 * 计算雪花内容的正方形裁剪区。LOGO 画布四周有较大透明边距（雪花仅占约
 * 59%），若不裁剪直接缩放，托盘图标会比其他应用小一圈。这里取内容边界框
 * 的长边扩展为正方形，让雪花占满目标图标（不留边距，最大化显示尺寸）。
 */
const computeContentCrop = (
  mask: Float32Array,
  width: number,
  height: number
): { x: number; y: number; side: number } => {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] > 0.15) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    // 无内容兜底：用整个画布的居中正方形
    const side = Math.min(width, height);
    return {
      x: Math.floor((width - side) / 2),
      y: Math.floor((height - side) / 2),
      side,
    };
  }
  const side = Math.max(maxX - minX + 1, maxY - minY + 1);
  const cropSide = side;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    x: Math.round(cx - cropSide / 2),
    y: Math.round(cy - cropSide / 2),
    side: cropSide,
  };
};

/**
 * 从裁剪区面积平均缩放雪花 mask 到目标尺寸，输出纯黑模板 RGBA
 *（RGB 全 0，alpha 为覆盖度）。裁剪区外的像素按透明处理。
 */
const maskToTemplateRgba = (
  mask: Float32Array,
  srcWidth: number,
  srcHeight: number,
  crop: { x: number; y: number; side: number },
  targetWidth: number,
  targetHeight: number
): Uint8Array => {
  const out = new Uint8Array(targetWidth * targetHeight * 4);
  const sample = (sx: number, sy: number): number => {
    if (sx < 0 || sx >= srcWidth || sy < 0 || sy >= srcHeight) {
      return 0;
    }
    return mask[sy * srcWidth + sx];
  };
  for (let ty = 0; ty < targetHeight; ty++) {
    const sy0 = Math.floor(crop.y + (ty * crop.side) / targetHeight);
    const sy1 = Math.max(
      sy0 + 1,
      Math.floor(crop.y + ((ty + 1) * crop.side) / targetHeight)
    );
    for (let tx = 0; tx < targetWidth; tx++) {
      const sx0 = Math.floor(crop.x + (tx * crop.side) / targetWidth);
      const sx1 = Math.max(
        sx0 + 1,
        Math.floor(crop.x + ((tx + 1) * crop.side) / targetWidth)
      );
      let sum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          sum += sample(sx, sy);
          n++;
        }
      }
      const idx = (ty * targetWidth + tx) * 4;
      out[idx + 3] = Math.round((sum / n) * 255); // RGB 保持 0（纯黑模板）
    }
  }
  return out;
};

/**
 * 5x7 点阵数字字模（行优先，每行 5 位，bit4..bit0 对应左→右 5 列）。
 * 用于 macOS 活动态在雪花右侧绘制活跃会话数，同为模板图，跟随菜单栏
 * 背景自动反色。
 */
const DIGIT_GLYPHS: Record<string, number[]> = {
  "0": [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  "3": [0b01110, 0b10001, 0b00001, 0b00110, 0b00001, 0b10001, 0b01110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
};

/**
 * 点阵数字的单格边长（@1x 16px→1，@2x 32px→2）。
 * 必须保证 @2x 恰为 @1x 的 2 倍，否则活动图 @1x/@2x 宽高比不一致，
 * 系统渲染时会把雪花横向拉伸变形。系数取 snowSize/16，数字高 7*cell
 * 约占画布 44%，比雪花略小不会喧宾夺主；最小取 1 保证 @1x 可见。
 */
const digitCell = (snowSize: number): number =>
  Math.max(1, Math.round(snowSize / 16));

/**
 * 在 RGBA 模板画布（纯黑 + alpha）上绘制活跃会话数点阵数字。
 * 数字置于雪花右侧（originX = snowSize + 间距），不与雪花重叠；垂直居中。
 * 每个点为 cell×cell 的实心方块，alpha=255，与雪花模板同为纯黑遮罩。
 */
const drawCountDigits = (
  rgba: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  snowSize: number,
  count: number
): void => {
  const text = count > 99 ? "99" : String(count);
  const cell = digitCell(snowSize);
  const glyphW = 5;
  const glyphH = 7;
  const charGap = cell;
  const originX = snowSize + cell;
  const originY = Math.floor((canvasHeight - glyphH * cell) / 2);
  for (let i = 0; i < text.length; i++) {
    const glyph = DIGIT_GLYPHS[text[i]];
    if (!glyph) {
      continue;
    }
    const charX = originX + i * (glyphW * cell + charGap);
    for (let row = 0; row < glyphH; row++) {
      const bits = glyph[row];
      for (let col = 0; col < glyphW; col++) {
        if (((bits >> (glyphW - 1 - col)) & 1) === 0) {
          continue;
        }
        const px = charX + col * cell;
        const py = originY + row * cell;
        for (let dy = 0; dy < cell; dy++) {
          for (let dx = 0; dx < cell; dx++) {
            const x = px + dx;
            const y = py + dy;
            if (x < 0 || x >= canvasWidth || y < 0 || y >= canvasHeight) {
              continue;
            }
            const idx = (y * canvasWidth + x) * 4;
            rgba[idx] = 0;
            rgba[idx + 1] = 0;
            rgba[idx + 2] = 0;
            rgba[idx + 3] = 255;
          }
        }
      }
    }
  }
};

/**
 * macOS 图标：普通态与活动态均使用模板图（纯黑 + alpha），由系统按菜单栏
 * 背景（壁纸明暗）自动反色，不受系统深浅色模式影响，彻底避免待机/活动
 * 切换时的黑白跳变。
 * - 普通态：雪花模板，占满图标画布；
 * - 活动态：雪花右侧绘制活跃会话数（5x7 点阵数字），与雪花同为纯黑遮罩，
 *   整张图设为模板图，数字与雪花一起跟随壁纸反色。
 *
 * 活动态数字会随会话数变化，故活动图标按会话数缓存（命中即复用，未命中才
 * 重新合成）。画布宽度按数字位数扩展（两位数需更宽画布），含 @1x/@2x 双表示。
 */
const createMacTemplateIcons = (): TrayIcons => {
  // 活动态画布宽度：雪花占左侧 snowSize，右侧数字区 = 起始间距 cell
  // + 每字符 5*cell 宽 + 字符间距 cell。即 snowSize + 6*cell*位数。
  const activeCanvasWidth = (snowSize: number, count: number): number => {
    const cell = digitCell(snowSize);
    const digits = count > 99 ? 2 : String(count).length;
    return snowSize + 6 * cell * digits;
  };

  // 将雪花 mask 按 crop 区域缩放绘制到画布左侧 snowSize×snowSize 区域，
  // 输出纯黑模板 RGBA（RGB 全 0，alpha 为覆盖度）。
  const drawSnowflake = (
    mask: Float32Array,
    srcWidth: number,
    srcHeight: number,
    crop: { x: number; y: number; side: number },
    rgba: Uint8Array,
    canvasW: number,
    snowSize: number
  ): void => {
    const sample = (sx: number, sy: number): number => {
      if (sx < 0 || sx >= srcWidth || sy < 0 || sy >= srcHeight) {
        return 0;
      }
      return mask[sy * srcWidth + sx];
    };
    for (let ty = 0; ty < snowSize; ty++) {
      const sy0 = Math.floor(crop.y + (ty * crop.side) / snowSize);
      const sy1 = Math.max(
        sy0 + 1,
        Math.floor(crop.y + ((ty + 1) * crop.side) / snowSize)
      );
      for (let tx = 0; tx < snowSize; tx++) {
        const sx0 = Math.floor(crop.x + (tx * crop.side) / snowSize);
        const sx1 = Math.max(
          sx0 + 1,
          Math.floor(crop.x + ((tx + 1) * crop.side) / snowSize)
        );
        let sum = 0;
        let n = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          for (let sx = sx0; sx < sx1; sx++) {
            sum += sample(sx, sy);
            n++;
          }
        }
        const idx = (ty * canvasW + tx) * 4;
        rgba[idx + 3] = Math.round((sum / n) * 255);
      }
    }
  };

  // 合成指定会话数的活动态 PNG（@1x + @2x）。
  const buildActivePngs = (
    mask: Float32Array,
    srcWidth: number,
    srcHeight: number,
    crop: { x: number; y: number; side: number },
    count: number
  ): { png16: Buffer; png32: Buffer } => {
    const build1x = buildActiveRgba(mask, srcWidth, srcHeight, crop, 16, count);
    const build2x = buildActiveRgba(mask, srcWidth, srcHeight, crop, 32, count);
    return {
      png16: encodePng(build1x.rgba, build1x.width, build1x.height),
      png32: encodePng(build2x.rgba, build2x.width, build2x.height),
    };
  };

  // 合成单尺寸活动态 RGBA。画布宽度按数字位数扩展。
  const buildActiveRgba = (
    mask: Float32Array,
    srcWidth: number,
    srcHeight: number,
    crop: { x: number; y: number; side: number },
    snowSize: number,
    count: number
  ): { width: number; height: number; rgba: Uint8Array } => {
    const canvasW = activeCanvasWidth(snowSize, count);
    const canvasH = snowSize;
    const rgba = new Uint8Array(canvasW * canvasH * 4);
    drawSnowflake(mask, srcWidth, srcHeight, crop, rgba, canvasW, snowSize);
    drawCountDigits(rgba, canvasW, canvasH, snowSize, count);
    return { width: canvasW, height: canvasH, rgba };
  };

  try {
    const decoded = decodePng(readFileSync(APP_ICON_PATH));
    if (decoded) {
      const mask = extractSnowflakeMask(
        decoded.rgba,
        decoded.width,
        decoded.height
      );
      const crop = computeContentCrop(mask, decoded.width, decoded.height);

      // 普通态：雪花占满 16×16 画布（@1x + @2x）。
      const normal16 = nativeImage.createFromBuffer(
        encodePng(
          maskToTemplateRgba(mask, decoded.width, decoded.height, crop, 16, 16),
          16,
          16
        )
      );
      normal16.addRepresentation({
        scaleFactor: 2,
        width: 32,
        height: 32,
        buffer: encodePng(
          maskToTemplateRgba(mask, decoded.width, decoded.height, crop, 32, 32),
          32,
          32
        ),
      });
      normal16.setTemplateImage(true);

      // 活动态：按会话数缓存 nativeImage，未命中才重新合成。
      const cache = new Map<number, NativeImage>();
      const getActive = (count: number): NativeImage => {
        const key = count > 99 ? 99 : Math.max(1, Math.floor(count));
        const cached = cache.get(key);
        if (cached) {
          return cached;
        }
        const { png16, png32 } = buildActivePngs(
          mask,
          decoded.width,
          decoded.height,
          crop,
          key
        );
        const img = nativeImage.createFromBuffer(png16);
        // @2x 表示需按实际画布尺寸（位数不同宽度不同）注册。
        img.addRepresentation({
          scaleFactor: 2,
          width: activeCanvasWidth(32, key),
          height: 32,
          buffer: png32,
        });
        img.setTemplateImage(true);
        cache.set(key, img);
        return img;
      };

      return { normal: normal16, getActive };
    }
  } catch {
    // fallthrough to colored fallback below
  }
  // 解码失败保底：直接用彩色 LOGO（非模板，菜单栏显示原色）。
  const fallback = nativeImage.createFromPath(APP_ICON_PATH);
  return { normal: fallback, getActive: () => fallback };
};

/** 构建 Windows 双表示图标：16px @1x + 32px @2x，DPI 精确匹配。 */
const buildDualRepIcon = (
  icon16: NativeImage,
  icon32: NativeImage
): NativeImage => {
  icon16.addRepresentation({
    scaleFactor: 2,
    width: 32,
    height: 32,
    buffer: icon32.toPNG(),
  });
  return icon16;
};

/** 从 PNG 文件叠加活动圆点（解码 → 画点 → 重编码）。直接读磁盘原始 PNG，避免 toPNG() 的预乘 alpha。 */
const withActivityDot = (pngPath: string): NativeImage => {
  try {
    const decoded = decodePng(readFileSync(pngPath));
    if (!decoded) {
      return nativeImage.createFromPath(pngPath);
    }
    overlayActivityDot(decoded.rgba, decoded.width, decoded.height, GREEN_DOT);
    return nativeImage.createFromBuffer(
      encodePng(decoded.rgba, decoded.width, decoded.height)
    );
  } catch {
    return nativeImage.createFromPath(pngPath);
  }
};

/**
 * 托盘图标集。
 * - normal：普通态图标（无会话进行时）。
 * - getActive(count)：活动态图标工厂（有会话进行时），按会话数返回对应图标。
 *   macOS 会按数字位数/数值返回不同模板图；Windows/Linux 忽略 count 返回
 *   固定的带绿色圆点彩色图。
 */
type TrayIcons = {
  normal: NativeImage;
  getActive: (count: number) => NativeImage;
};

/** Windows/Linux 彩色图标（正常 + 活动两套），使用设计好的 favicon 小图。 */
const createColorIcons = (): TrayIcons => {
  if (process.platform === "win32") {
    const icon16 = nativeImage.createFromPath(APP_FAVICON_16_PATH);
    const icon32 = nativeImage.createFromPath(APP_FAVICON_32_PATH);
    if (!icon16.isEmpty() && !icon32.isEmpty()) {
      const active = buildDualRepIcon(
        withActivityDot(APP_FAVICON_16_PATH),
        withActivityDot(APP_FAVICON_32_PATH)
      );
      return {
        normal: buildDualRepIcon(icon16, icon32),
        getActive: () => active,
      };
    }
  }

  // Linux（托盘惯例 22px）与回退路径：从 32px 源缩放，比从 256px 缩放更清晰。
  const icon32 = nativeImage.createFromPath(APP_FAVICON_32_PATH);
  const base = icon32.isEmpty()
    ? nativeImage.createFromPath(APP_ICON_PATH)
    : icon32;
  const target = process.platform === "linux" ? 22 : 16;
  const normal = base.resize({ width: target, height: target });
  const active = withActivityDot(APP_FAVICON_32_PATH).resize({
    width: target,
    height: target,
  });
  const resolvedActive = active.isEmpty() ? normal : active;
  return { normal, getActive: () => resolvedActive };
};

// ─── 托盘状态 ─────────────────────────────────────────────────────────────

const STATS_REFRESH_MS = 15_000;

type TrayStats = {
  activeSessions: number;
  activeTerminals: number;
  projects: number;
  pendingMemos: number;
  todayTokens: number;
};

let tray: Tray | null = null;
let nativeBridge: NativeBridge | null = null;
let icons: TrayIcons | null = null;
let stats: TrayStats = {
  activeSessions: 0,
  activeTerminals: 0,
  projects: 0,
  pendingMemos: 0,
  todayTokens: 0,
};

const formatTokens = (count: number): string => {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return String(count);
};

// 显示主窗口：恢复最小化 / 隐藏（托盘）状态并聚焦；窗口已全部关闭（macOS）时重建。
const showMainWindow = (): void => {
  // macOS 从菜单栏托盘恢复时，重新显示 Dock 图标。
  if (process.platform === "darwin") {
    app.dock?.show();
  }
  // 使用 getMainWindow() 精确获取主窗口，避免 getAllWindows()[0] 误选宠物窗口。
  const win = getMainWindow();
  if (win) {
    if (win.isMinimized()) {
      win.restore();
    }
    // 处理 hide-to-tray 隐藏状态：show() 对已显示的窗口无副作用。
    if (!win.isVisible()) {
      win.show();
    }
    win.focus();
    return;
  }
  // macOS 上关闭 Dock 图标后窗口可能已全部销毁，此时从托盘重建窗口。
  createWindow();
};

const applyTooltip = (): void => {
  if (!tray) {
    return;
  }
  // 托盘 tooltip 是主进程原生纯文本，无法渲染 lucide 图标，保持简洁文本。
  const lines = [
    "Snow App",
    `会话进行中 ${stats.activeSessions}`,
    `活跃终端 ${stats.activeTerminals}`,
    `项目 ${stats.projects}`,
    `待办备忘录 ${stats.pendingMemos}`,
    `今日用量 ${formatTokens(stats.todayTokens)}`,
  ];
  tray.setToolTip(lines.join("\n"));
};

/**
 * 根据是否有进行中会话切换托盘图标。
 * - 有会话：活动态图标（macOS 为雪花+数字模板图，Windows/Linux 为彩色图+绿点）。
 * - 无会话：普通态图标（macOS 为纯雪花模板图）。
 * macOS 两者均为模板图，由系统按菜单栏背景自动反色，无需手动切换黑白。
 */
const applyActiveVisual = (): void => {
  if (!tray || !icons) {
    return;
  }
  if (stats.activeSessions > 0) {
    tray.setImage(icons.getActive(stats.activeSessions));
  } else {
    tray.setImage(icons.normal);
  }
};

// 通过 Rust 后端异步聚合全部指标（目录、备忘录、用量均走 native bridge）。
const refreshAllStats = (native: NativeBridge): void => {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(
    today.getMonth() + 1
  ).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  // Rust 端对 usage 使用 SQLite datetime 字符串比较，需带时间部分，
  // 否则 "YYYY-MM-DD HH:MM:SS" 格式的 created_at 无法匹配纯日期边界。
  const dayStart = `${dateStr} 00:00:00`;
  const dayEnd = `${dateStr} 23:59:59`;

  void (async () => {
    try {
      const [directories, usage] = await Promise.all([
        native.listWorkspaceDirectories(),
        native.getUsageSummary(dayStart, dayEnd),
      ]);
      const memoResults = await Promise.allSettled(
        directories.map((d) => native.getMemoCountSummary(d.directoryId))
      );
      stats = {
        activeSessions: stats.activeSessions,
        activeTerminals: getActivePtyCount(),
        projects: directories.length,
        pendingMemos: memoResults.reduce(
          (sum, r) => sum + (r.status === "fulfilled" ? r.value.pending : 0),
          0
        ),
        todayTokens: usage?.totalTokens ?? 0,
      };
      applyTooltip();
      applyActiveVisual();
    } catch (error) {
      snowLog.warn({
        module: "app/tray",
        func: "refreshAllStats",
        message: "Failed to refresh tray tooltip stats",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};

/** 供其他模块（如隐藏到托盘时）触发一次立即刷新。 */
export const refreshTrayStats = (): void => {
  if (nativeBridge) {
    refreshAllStats(nativeBridge);
  }
};

const buildContextMenu = (): Menu => {
  return Menu.buildFromTemplate([
    { label: "打开 Snow App", click: showMainWindow },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        markCloseConfirmed();
        app.quit();
      },
    },
  ]);
};

export const initTray = (native: NativeBridge): void => {
  try {
    nativeBridge = native;
    const isMacOS = process.platform === "darwin";
    icons = isMacOS ? createMacTemplateIcons() : createColorIcons();

    tray = new Tray(icons.normal);
    tray.setToolTip("Snow App");
    tray.on("click", showMainWindow);

    if (isMacOS) {
      // macOS 左键点击恢复窗口，右键弹出菜单（避免左键被菜单吞掉）。
      tray.on("right-click", () => {
        tray?.popUpContextMenu(buildContextMenu());
      });
    } else {
      // Windows/Linux：右键默认弹出菜单。
      tray.setContextMenu(buildContextMenu());
    }

    // 渲染进程推送进行中会话数（渲染层是流式状态的唯一持有者）。
    ipcMain.handle("tray:set-active-sessions", (_event, count: unknown) => {
      if (typeof count === "number" && Number.isFinite(count)) {
        stats = { ...stats, activeSessions: Math.max(0, Math.floor(count)) };
        applyTooltip();
        applyActiveVisual();
      }
    });

    refreshAllStats(native);
    // 定时刷新指标（进程生命周期内常驻，随进程退出自动清理）。
    setInterval(() => refreshAllStats(native), STATS_REFRESH_MS);

    snowLog.info({
      module: "app/tray",
      func: "initTray",
      message: "System tray initialized",
      context: `platform=${process.platform}`,
    });
  } catch (error) {
    snowLog.warn({
      module: "app/tray",
      func: "initTray",
      message: "Failed to initialize system tray",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
