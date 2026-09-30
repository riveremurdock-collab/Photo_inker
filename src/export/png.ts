// Streaming PNG encoder: rows are compressed as they arrive, so a huge image
// (e.g. an A3 layer at 600 DPI) never has to exist uncompressed in memory.
// Writes the resolution (pHYs) so print layers open at the right DPI, and
// can mark color images as sRGB. Compression: see deflate.ts.

import { DeflateStream } from "./deflate";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  const typeBytes = new TextEncoder().encode(type);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32([typeBytes, data]));
  return out;
}

export type PngColor = "gray" | "rgb" | "rgba";

const CHANNELS: Record<PngColor, number> = { gray: 1, rgb: 3, rgba: 4 };
const COLOR_TYPE: Record<PngColor, number> = { gray: 0, rgb: 2, rgba: 6 };

export interface PngOptions {
  /** Resolution to record (pHYs). */
  dpi?: number;
  /** Mark a color image as sRGB (sRGB chunk). */
  srgb?: boolean;
}

export class PngEncoder {
  private deflate = new DeflateStream();
  private channels: number;
  private rowsWritten = 0;
  private done = false;

  constructor(
    readonly width: number,
    readonly height: number,
    private color: PngColor,
    private options: PngOptions = {},
  ) {
    this.channels = CHANNELS[color];
  }

  /**
   * Adds rows (tightly packed, `channels` bytes per pixel, no filter byte).
   * Each row is stored with the PNG filter that usually compresses it best:
   * none for flat black-and-white layers, "sub" for color.
   * Resolves once the compressor is ready for more (backpressure).
   */
  async writeRows(pixels: Uint8Array, rowCount: number): Promise<void> {
    const stride = this.width * this.channels;
    const ch = this.channels;
    const filtered = new Uint8Array(rowCount * (stride + 1));
    for (let r = 0; r < rowCount; r++) {
      const row = pixels.subarray(r * stride, (r + 1) * stride);
      const o = r * (stride + 1);
      if (this.color === "gray") {
        filtered[o] = 0;
        filtered.set(row, o + 1);
      } else {
        filtered[o] = 1; // Sub: difference from the pixel to the left
        for (let i = 0; i < stride; i++) filtered[o + 1 + i] = (row[i]! - (i >= ch ? row[i - ch]! : 0)) & 0xff;
      }
    }
    this.rowsWritten += rowCount;
    await this.deflate.write(filtered);
  }

  async finish(): Promise<Blob> {
    if (this.done) throw new Error("PNG already finished");
    if (this.rowsWritten !== this.height) throw new Error(`PNG got ${this.rowsWritten} of ${this.height} rows`);
    this.done = true;
    const data = await this.deflate.finish();

    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, this.width);
    v.setUint32(4, this.height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = COLOR_TYPE[this.color];
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter method
    ihdr[12] = 0; // no interlace

    const parts: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
    if (this.options.srgb && this.color !== "gray") parts.push(chunk("sRGB", new Uint8Array([0]))); // perceptual intent
    if (this.options.dpi) {
      const phys = new Uint8Array(9);
      const pv = new DataView(phys.buffer);
      const ppm = Math.round(this.options.dpi / 0.0254);
      pv.setUint32(0, ppm);
      pv.setUint32(4, ppm);
      phys[8] = 1; // unit: meter
      parts.push(chunk("pHYs", phys));
    }
    // Split the compressed data into IDAT chunks of up to 1 MB.
    for (let i = 0; i < data.length; i += 1 << 20) parts.push(chunk("IDAT", data.subarray(i, Math.min(data.length, i + (1 << 20)))));
    if (data.length === 0) parts.push(chunk("IDAT", data));
    parts.push(chunk("IEND", new Uint8Array(0)));
    return new Blob(parts as BlobPart[], { type: "image/png" });
  }
}
