/**
 * 5×7 点阵字模 + 画布绘制原语（零依赖）
 *
 * 为什么自带字模：三视图拼版上必须能画「视图名 + 数字刻度」——
 * 调研结论里"图上的数字标签比纯网格重要得多"（VLM 会读数字，不擅长从像素间距推长度）。
 * 只覆盖工程图需要的字符集：数字、大写字母、少量符号。
 */

/* 每个字形 7 行，每行低 5 位有效（左起 bit4..bit0） */
export const GLYPHS = {
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 0b01100, 0b01100],
  ',': [0, 0, 0, 0, 0b01100, 0b00100, 0b01000],
  '-': [0, 0, 0, 0b11111, 0, 0, 0],
  '+': [0, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0],
  ':': [0, 0b01100, 0b01100, 0, 0b01100, 0b01100, 0],
  '/': [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000],
  '(': [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ')': [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
  '=': [0, 0, 0b11111, 0, 0b11111, 0, 0],
  '*': [0, 0b10101, 0b01110, 0b11111, 0b01110, 0b10101, 0],
  '#': [0b01010, 0b01010, 0b11111, 0b01010, 0b11111, 0b01010, 0b01010]
}

const CHAR_W = 5
const CHAR_H = 7
const SPACING = 1

export const textWidth = (text, scale = 1) => text.length * (CHAR_W + SPACING) * scale - SPACING * scale
export const textHeight = (scale = 1) => CHAR_H * scale

/** 在 RGB Buffer（3 字节/像素）上画一个像素，带边界检查与颜色混合 */
export function putPixel(rgb, W, H, x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const i = (y * W + x) * 3
  for (let c = 0; c < 3; c += 1) {
    const v = rgb[i + c]
    rgb[i + c] = Math.max(0, Math.min(255, Math.round(v * (1 - alpha) + color[c] * alpha)))
  }
}

export function fillRect(rgb, W, H, x0, y0, w, h, color, alpha = 1) {
  for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) putPixel(rgb, W, H, x, y, color, alpha)
}

export function strokeRect(rgb, W, H, x0, y0, w, h, color, thickness = 1) {
  fillRect(rgb, W, H, x0, y0, w, thickness, color)
  fillRect(rgb, W, H, x0, y0 + h - thickness, w, thickness, color)
  fillRect(rgb, W, H, x0, y0, thickness, h, color)
  fillRect(rgb, W, H, x0 + w - thickness, y0, thickness, h, color)
}

export function drawLine(rgb, W, H, x0, y0, x1, y1, color, thickness = 1) {
  let x = Math.round(x0)
  let y = Math.round(y0)
  const ex = Math.round(x1)
  const ey = Math.round(y1)
  const dx = Math.abs(ex - x)
  const dy = Math.abs(ey - y)
  const sx = x < ex ? 1 : -1
  const sy = y < ey ? 1 : -1
  let err = dx - dy
  for (let guard = 0; guard < 100000; guard += 1) {
    for (let ty = 0; ty < thickness; ty += 1) for (let tx = 0; tx < thickness; tx += 1) putPixel(rgb, W, H, x + tx, y + ty, color)
    if (x === ex && y === ey) break
    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      x += sx
    }
    if (e2 < dx) {
      err += dx
      y += sy
    }
  }
}

export function drawText(rgb, W, H, text, x, y, scale, color) {
  let cx = x
  for (const ch of String(text).toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS['?'] ?? GLYPHS[' ']
    for (let row = 0; row < CHAR_H; row += 1) {
      const bits = glyph[row]
      for (let col = 0; col < CHAR_W; col += 1) {
        if (!(bits & (1 << (CHAR_W - 1 - col)))) continue
        fillRect(rgb, W, H, cx + col * scale, y + row * scale, scale, scale, color)
      }
    }
    cx += (CHAR_W + SPACING) * scale
  }
  return cx
}
