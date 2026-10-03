// The image everything works on: the uploaded photo, cropped and rotated
// (app/crop.ts). Kept outside ProjectSettings because it isn't a
// setting: it isn't saved in presets and has no schema.

export interface SourceImage {
  fileName: string;
  /** Oriented (EXIF applied), full resolution. */
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** Bumps on every new image (an upload, or a new crop) so caches can tell images apart. */
  version: number;
}

export type SourceListener = (image: SourceImage | null) => void;

export class SourceStore {
  private image: SourceImage | null = null;
  /** Whether the store closes the current bitmap when it is replaced (not when it is the uploaded original). */
  private owned = false;
  private version = 0;
  private listeners = new Set<SourceListener>();

  get(): SourceImage | null {
    return this.image;
  }

  /**
   * Sets the image everything works on. `owned`: this store may close the
   * bitmap when it is replaced (an edited copy); the uploaded original
   * (used as is when nothing is cropped or rotated) is closed by its owner.
   */
  set(fileName: string, bitmap: ImageBitmap, owned = true): SourceImage {
    if (this.owned && this.image && this.image.bitmap !== bitmap) this.image.bitmap.close();
    this.owned = owned;
    this.image = { fileName, bitmap, width: bitmap.width, height: bitmap.height, version: ++this.version };
    for (const listener of this.listeners) listener(this.image);
    return this.image;
  }

  subscribe(listener: SourceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
