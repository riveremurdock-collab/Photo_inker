// Decodes an uploaded file into an oriented ImageBitmap, with clear messages
// for unsupported or oversized files.

export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const ACCEPT_ATTRIBUTE = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";

/** Largest file accepted before decoding (decoding bigger files risks running out of memory). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/**
 * Largest image accepted, in pixels. 50 MP covers phone and most camera photos
 * (e.g. 8688 × 5792) while keeping full-resolution processing within memory.
 */
export const MAX_PIXELS = 50_000_000;

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

const EXTENSION_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function fileType(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TYPES[ext] ?? "";
}

function formatMegapixels(pixels: number): string {
  return `${(pixels / 1_000_000).toFixed(1)} MP`;
}

/** Decodes with EXIF orientation applied. Falls back to an <img> element for browsers whose createImageBitmap rejects options. */
async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image", premultiplyAlpha: "none" });
  } catch {
    // <img> applies EXIF orientation in all current browsers.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return await createImageBitmap(img);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

export async function loadImageFile(file: File): Promise<ImageBitmap> {
  const type = fileType(file);
  if (type === "image/heic" || type === "image/heif" || /\.hei[cf]$/i.test(file.name)) {
    throw new UploadError("HEIC photos can't be opened in the browser. Export the photo as JPG first, then upload it.");
  }
  if (!(ACCEPTED_TYPES as readonly string[]).includes(type)) {
    throw new UploadError(`"${file.name}" isn't a supported image. Use a JPG, PNG, or WebP file.`);
  }
  if (file.size > MAX_FILE_BYTES) {
    const mb = Math.round(file.size / (1024 * 1024));
    throw new UploadError(`This file is ${mb} MB. The maximum is ${MAX_FILE_BYTES / (1024 * 1024)} MB.`);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await decode(file);
  } catch {
    throw new UploadError(`"${file.name}" couldn't be opened. The file may be damaged.`);
  }

  const pixels = bitmap.width * bitmap.height;
  if (pixels > MAX_PIXELS) {
    const { width, height } = bitmap;
    bitmap.close();
    throw new UploadError(
      `This image is ${width} × ${height} (${formatMegapixels(pixels)}). ` +
        `The maximum is ${formatMegapixels(MAX_PIXELS)}. Resize it and try again.`,
    );
  }
  return bitmap;
}

/** "holiday photo.final.jpg" → "holiday photo.final" */
export function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}
