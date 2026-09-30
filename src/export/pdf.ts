// Minimal PDF writer: one full-page image per page, at the page's physical
// size (pixels ÷ DPI). Images are 8-bit gray (riso layers) or RGB (standard
// printer), stored zlib-compressed (FlateDecode), which is exactly what
// DeflateStream produces from raw rows. RGB pages can be tagged with the
// sRGB ICC profile.

export interface PdfImagePage {
  width: number;
  height: number;
  dpi: number;
  color: "gray" | "rgb";
  /** zlib-compressed raw pixel rows (no PNG filter bytes). */
  data: Uint8Array;
}

export function buildPdf(pages: readonly PdfImagePage[], icc?: Uint8Array): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (p: Uint8Array | string) => {
    const bytes = typeof p === "string" ? enc.encode(p) : p;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, body: string, stream?: Uint8Array) => {
    offsets[id] = length;
    push(`${id} 0 obj\n${body}\n`);
    if (stream) {
      push("stream\n");
      push(stream);
      push("\nendstream\n");
    }
    push("endobj\n");
  };

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  // 1 = catalog, 2 = page tree, 3 = ICC profile (if any), then 3 objects per page.
  const iccId = icc ? 3 : 0;
  const first = icc ? 4 : 3;
  const pageIds = pages.map((_, i) => first + i * 3);
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  if (icc) object(3, `<< /N 3 /Length ${icc.length} >>`, icc);

  pages.forEach((p, i) => {
    const pageId = pageIds[i]!;
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const w = (p.width / p.dpi) * 72;
    const h = (p.height / p.dpi) * 72;
    const size = `${w.toFixed(3)} ${h.toFixed(3)}`;
    object(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    const content = enc.encode(`q ${w.toFixed(3)} 0 0 ${h.toFixed(3)} 0 0 cm /Im0 Do Q`);
    object(contentId, `<< /Length ${content.length} >>`, content);
    const colorSpace = p.color === "gray" ? "/DeviceGray" : iccId ? `[/ICCBased ${iccId} 0 R]` : "/DeviceRGB";
    object(
      imageId,
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /FlateDecode /Length ${p.data.length} >>`,
      p.data,
    );
  });

  const count = first + pages.length * 3;
  const xref = length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) table += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}

