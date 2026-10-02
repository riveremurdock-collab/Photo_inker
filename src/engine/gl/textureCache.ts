// GPU textures made from data objects (usually worker results: point sets,
// noise fields, lookup tables). Only the last few are kept; older ones are
// deleted, so tweaking a setting many times doesn't pile up GPU memory.
//
// Two entries are enough: the one in use, plus one made for an export (which
// deletes its own) or the one being replaced.

export class TextureCache<K extends object> {
  private entries: { key: K; gl: WebGL2RenderingContext; texture: WebGLTexture }[] = [];

  constructor(private capacity = 2) {}

  /** The texture for `key`, made with `create` the first time. */
  get(gl: WebGL2RenderingContext, key: K, create: () => WebGLTexture): WebGLTexture {
    const i = this.entries.findIndex((e) => e.key === key && e.gl === gl);
    if (i >= 0) {
      const [entry] = this.entries.splice(i, 1);
      this.entries.push(entry!);
      return entry!.texture;
    }
    const texture = create();
    this.entries.push({ key, gl, texture });
    while (this.entries.length > this.capacity) {
      const old = this.entries.shift()!;
      old.gl.deleteTexture(old.texture);
    }
    return texture;
  }
}
