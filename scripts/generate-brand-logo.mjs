// 从 output/imagegen 的原始字标生成任务台内嵌的品牌资源。
//
//   node scripts/generate-brand-logo.mjs
//
// 输入：tmp/website-redesign/assets/werelay-lighter-transparent.png（黑字 + 绿弧）
// 输出：src/daemon/codex-mobile-brand.ts（亮色 / 暗色两份 data URI）
//
// 暗色版规则：所有非透明像素整体反相为浅色，再把绿弧像素按原色盖回，
// 保证深色底上字形可读、品牌绿不变。

import fs from "node:fs";
import zlib from "node:zlib";

function decodePng(buf) {
  let pos = 8, w=0, h=0, colorType=0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos+4, pos+8);
    const data = buf.subarray(pos+8, pos+8+len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9]; }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = colorType === 6 ? 4 : 3;
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const prev = y > 0 ? out.subarray((y-1)*stride, y*stride) : Buffer.alloc(stride);
    const cur = out.subarray(y*stride, (y+1)*stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x-ch] : 0, b = prev[x], c = x >= ch ? prev[x-ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b;
      else if (f === 3) v += Math.floor((a+b)/2);
      else if (f === 4) { const p=a+b-c, pa=Math.abs(p-a), pb=Math.abs(p-b), pc=Math.abs(p-c);
        v += (pa<=pb && pa<=pc) ? a : (pb<=pc ? b : c); }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, ch, px: out };
}

let CRC = null;
function crc32(b) {
  if (!CRC) { CRC=[]; for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;CRC[n]=c>>>0;} }
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c^x)&0xff]^(c>>>8);
  return (c^0xffffffff)>>>0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, ch, px) {
  const stride = w * ch;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y*(stride+1)] = 0;
    px.copy(raw, y*(stride+1)+1, y*stride, (y+1)*stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4);
  ihdr[8]=8; ihdr[9]= ch===4?6:2;
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw,{level:9})), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 盒式降采样：保持描边干净，避免振铃
function downscale(src, targetW) {
  const { w, h, ch, px } = src;
  const scale = targetW / w;
  const tw = targetW, th = Math.max(1, Math.round(h * scale));
  const out = Buffer.alloc(tw * th * ch);
  for (let y = 0; y < th; y++) {
    const sy0 = Math.floor(y / scale), sy1 = Math.min(h, Math.ceil((y+1) / scale));
    for (let x = 0; x < tw; x++) {
      const sx0 = Math.floor(x / scale), sx1 = Math.min(w, Math.ceil((x+1) / scale));
      let r=0,g=0,b=0,a=0,n=0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const i = (sy*w+sx)*ch;
        const alpha = ch===4 ? px[i+3] : 255;
        // 预乘 alpha 再平均，避免边缘发黑
        r += px[i]*alpha; g += px[i+1]*alpha; b += px[i+2]*alpha; a += alpha; n++;
      }
      const o = (y*tw+x)*ch;
      if (a > 0) { out[o] = Math.round(r/a); out[o+1] = Math.round(g/a); out[o+2] = Math.round(b/a); }
      out[o+3] = ch===4 ? Math.round(a/n) : 255;
    }
  }
  return { w: tw, h: th, ch, px: out };
}

const src = decodePng(fs.readFileSync("tmp/website-redesign/assets/werelay-lighter-transparent.png"));
const light = downscale(src, 384);

// 暗色版：先把所有非透明像素整体反相（字形变浅色、绿弧变紫），
// 再把原图中属于绿弧的像素按原始颜色盖回去。分层处理可以避免
// 绿/黑抗锯齿交界处留下噪点。
const W = light.w, H = light.h;
const darkPx = Buffer.from(light.px);
let flipped = 0;
for (let i = 0; i < W * H; i++) {
  const a = light.px[i*4+3];
  if (a < 8) continue;
  darkPx[i*4]   = 255 - light.px[i*4];
  darkPx[i*4+1] = 255 - light.px[i*4+1];
  darkPx[i*4+2] = 255 - light.px[i*4+2];
  flipped++;
}
// 绿弧遮罩：用较宽的色相范围覆盖整条弧线（含其抗锯齿边缘）
const greenMask = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  const r = light.px[i*4], g = light.px[i*4+1], b = light.px[i*4+2], a = light.px[i*4+3];
  if (a < 8) continue;
  if (g > r + 6 && g > b + 14) greenMask[i] = 1;
}
// 膨胀两圈，确保弧线边缘的混合像素也用原始绿色覆盖
const keepGreen = new Uint8Array(greenMask);
for (let pass = 0; pass < 2; pass++) {
  const snapshot = Uint8Array.from(keepGreen);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!snapshot[y*W+x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x+dx, ny = y+dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      keepGreen[ny*W+nx] = 1;
    }
  }
}
let restored = 0;
for (let i = 0; i < W * H; i++) {
  if (!keepGreen[i]) continue;
  // 用原始像素覆盖，保留真实绿色与透明度
  darkPx[i*4]   = light.px[i*4];
  darkPx[i*4+1] = light.px[i*4+1];
  darkPx[i*4+2] = light.px[i*4+2];
  restored++;
}
const dark = { w: light.w, h: light.h, ch: 4, px: darkPx };

const lightPng = encodePng(light.w, light.h, 4, light.px);
const darkPng = encodePng(dark.w, dark.h, 4, dark.px);
fs.writeFileSync("/tmp/brand-light.png", lightPng);
fs.writeFileSync("/tmp/brand-dark.png", darkPng);

// 直接写出 TypeScript 资源模块
const moduleBody = [
  "// WeRelay 品牌字标资源。",
  "//",
  "// 由 output/imagegen 的 werelay-lighter-transparent.png（黑字 + 绿弧）派生：",
  "// 亮色版保留原图；暗色版把所有非透明像素整体反相为浅色，再把绿弧的像素按",
  "// 原始颜色盖回，使字形在深色底上可读而品牌绿不变。两份都是 384x100 的",
  "// 透明 PNG，按 data URI 内嵌，避免为尚未连接电脑的启动页额外请求资源。",
  "//",
  "// 重新生成见 scripts/generate-brand-logo.mjs。",
  "",
  `export const WE_RELAY_LOGO_LIGHT_DATA_URI = "data:image/png;base64,${lightPng.toString("base64")}";`,
  "",
  `export const WE_RELAY_LOGO_DARK_DATA_URI = "data:image/png;base64,${darkPng.toString("base64")}";`,
  "",
].join("\n");
fs.writeFileSync("src/daemon/codex-mobile-brand.ts", moduleBody);
console.log("已写出 src/daemon/codex-mobile-brand.ts");

console.log(`尺寸: ${light.w}x${light.h} (比例 ${(light.w/light.h).toFixed(3)})`);
console.log(`亮色: ${(lightPng.length/1024).toFixed(1)} KB   暗色: ${(darkPng.length/1024).toFixed(1)} KB   反相 ${flipped} 像素, 盖回绿色 ${restored} 像素`);
console.log(`base64 合计: ${((lightPng.length+darkPng.length)*4/3/1024).toFixed(1)} KB`);
