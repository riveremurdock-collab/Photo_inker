// Streaming zlib ("deflate" format) compression with the browser's own
// CompressionStream, for PNG image data and PDF streams. Chunks are
// compressed as they arrive, so big images never sit uncompressed in memory.
// (fflate's streaming Zlib wrote corrupt data for hard-to-compress input.)

export class DeflateStream {
  private chunks: Uint8Array[] = [];
  private writer: WritableStreamDefaultWriter<BufferSource>;
  private reading: Promise<void>;
  private done = false;

  constructor() {
    const stream = new CompressionStream("deflate");
    this.writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    this.reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        this.chunks.push(value);
      }
    })();
  }

  /** Adds data. Resolves once the compressor is ready for more (backpressure). */
  async write(data: Uint8Array): Promise<void> {
    await this.writer.ready;
    void this.writer.write(data as Uint8Array<ArrayBuffer>);
  }

  /** Ends the stream and returns the compressed bytes. */
  async finish(): Promise<Uint8Array> {
    if (this.done) throw new Error("Stream already finished");
    this.done = true;
    await this.writer.close();
    await this.reading;
    const out = concatBytes(this.chunks);
    this.chunks = [];
    return out;
  }
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
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
