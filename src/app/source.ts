// The uploaded base image. Kept outside ProjectSettings because it isn't a
// setting: it isn't saved in presets and has no schema.

export interface SourceImage {
  fileName: string;
  /** Oriented (EXIF applied), full resolution. */
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** Bumps on every new upload so caches can tell images apart. */
  version: number;
}

export type SourceListener = (image: SourceImage | null) => void;

export class SourceStore {
  private image: SourceImage | null = null;
  private version = 0;
  private listeners = new Set<SourceListener>();

  get(): SourceImage | null {
    return this.image;
  }

  set(fileName: string, bitmap: ImageBitmap): SourceImage {
    this.image?.bitmap.close();
    this.image = { fileName, bitmap, width: bitmap.width, height: bitmap.height, version: ++this.version };
    for (const listener of this.listeners) listener(this.image);
    return this.image;
  }

  subscribe(listener: SourceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
