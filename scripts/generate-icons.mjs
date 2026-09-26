import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const ROOT = resolve(process.cwd());
const OUT = resolve(ROOT, "apps/extension/public/icons");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function iconPixels(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const margin = Math.max(1, Math.round(size * 0.12));
  const stroke = Math.max(1, Math.round(size * 0.09));

  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = a;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      set(x, y, 20, 24, 33, 255);
    }
  }

  // Temporary BrowserCrew mark: a high-contrast browser frame + two crew panes.
  for (let y = margin; y < size - margin; y += 1) {
    for (let x = margin; x < size - margin; x += 1) {
      const border =
        x < margin + stroke ||
        x >= size - margin - stroke ||
        y < margin + stroke ||
        y >= size - margin - stroke;
      if (border) set(x, y, 245, 245, 245, 255);
    }
  }

  const top = margin + stroke * 2;
  const bottom = size - margin - stroke * 2;
  const left = margin + stroke * 2;
  const right = size - margin - stroke * 2;
  const gap = Math.max(1, Math.round(size * 0.05));
  const mid = Math.floor((left + right) / 2);

  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < mid - gap; x += 1) {
      set(x, y, 120, 170, 255, 255);
    }
    for (let x = mid + gap; x < right; x += 1) {
      set(x, y, 170, 130, 255, 255);
    }
  }

  return pixels;
}

function encodePng(size) {
  const pixels = iconPixels(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(
      raw,
      rowStart + 1,
      y * size * 4,
      (y + 1) * size * 4
    );
  }

  const signature = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10
  ]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

await mkdir(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(resolve(OUT, `icon${size}.png`), encodePng(size));
}

console.log("Generated temporary BrowserCrew extension icons.");
