// Streaming PNG encoder: rows are compressed as they arrive, so a huge image
// (e.g. an A3 layer at 600 DPI) never has to exist uncompressed in memory.
// Writes the resolution (pHYs) so print layers open at the right DPI, and
// marks RGB images as sRGB.
//
// Compression uses the browser's own CompressionStream("deflate") (zlib format).
// fflate's streaming Zlib (0.8.3) produced corrupt streams for hard-to-compress
// data pushed in many pieces ("invalid distance too far back").

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

export type PngColor = "gray" | "rgb";

export class PngEncoder {
  private compressed: Uint8Array[] = [];
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private reading: Promise<void>;
  private channels: number;
  private rowsWritten = 0;
  private done = false;

  constructor(
    readonly width: number,
    readonly height: number,
    private color: PngColor,
    private dpi?: number,
  ) {
    this.channels = color === "gray" ? 1 : 3;
    const stream = new CompressionStream("deflate");
    this.writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    this.reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        this.compressed.push(value);
      }
    })();
  }

  /**
   * Adds rows (tightly packed, `channels` bytes per pixel, no filter byte).
   * Each row is stored with the PNG filter that usually compresses it best:
   * none for flat black-and-white layers, "sub" for photos.
   * Resolves once the compressor is ready for more (backpressure).
   */
  async writeRows(pixels: Uint8Array, rowCount: number): Promise<void> {
    const stride = this.width * this.channels;
    const filtered = new Uint8Array(rowCount * (stride + 1));
    for (let r = 0; r < rowCount; r++) {
      const row = pixels.subarray(r * stride, (r + 1) * stride);
      const o = r * (stride + 1);
      if (this.color === "gray") {
        filtered[o] = 0;
        filtered.set(row, o + 1);
      } else {
        filtered[o] = 1; // Sub: difference from the pixel to the left
        for (let i = 0; i < stride; i++) {
          filtered[o + 1 + i] = (row[i]! - (i >= this.channels ? row[i - this.channels]! : 0)) & 0xff;
        }
      }
    }
    this.rowsWritten += rowCount;
    await this.writer.ready;
    void this.writer.write(filtered);
  }

  async finish(): Promise<Blob> {
    if (this.done) throw new Error("PNG already finished");
    if (this.rowsWritten !== this.height) throw new Error(`PNG got ${this.rowsWritten} of ${this.height} rows`);
    this.done = true;
    await this.writer.close();
    await this.reading;

    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, this.width);
    v.setUint32(4, this.height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = this.color === "gray" ? 0 : 2; // color type
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter method
    ihdr[12] = 0; // no interlace

    const parts: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
    if (this.color === "rgb") parts.push(chunk("sRGB", new Uint8Array([0]))); // perceptual intent
    if (this.dpi) {
      const phys = new Uint8Array(9);
      const pv = new DataView(phys.buffer);
      const ppm = Math.round(this.dpi / 0.0254);
      pv.setUint32(0, ppm);
      pv.setUint32(4, ppm);
      phys[8] = 1; // unit: meter
      parts.push(chunk("pHYs", phys));
    }
    // Split the compressed data into IDAT chunks of up to 1 MB.
    const all = concat(this.compressed);
    for (let i = 0; i < all.length; i += 1 << 20) parts.push(chunk("IDAT", all.subarray(i, Math.min(all.length, i + (1 << 20)))));
    if (all.length === 0) parts.push(chunk("IDAT", all));
    parts.push(chunk("IEND", new Uint8Array(0)));
    this.compressed = [];
    return new Blob(parts as BlobPart[], { type: "image/png" });
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
