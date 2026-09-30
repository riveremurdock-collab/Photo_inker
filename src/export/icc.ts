// A small sRGB ICC profile (version 2, display class), built on first use:
// D50-adapted sRGB primaries (Bradford) and the sRGB tone curve sampled at
// 1024 points. Embedded in JPGs (APP2) and color PDFs (ICCBased) so other
// apps read the colors as sRGB. PNGs use the lighter sRGB chunk instead.

let cached: Uint8Array | null = null;

export function srgbIccProfile(): Uint8Array {
  if (cached) return cached;
  const enc = new TextEncoder();
  const fixed = (v: number) => Math.round(v * 65536) | 0;

  const xyz = (x: number, y: number, z: number) => {
    const b = new DataView(new ArrayBuffer(20));
    b.setUint32(0, 0x58595a20); // 'XYZ '
    b.setInt32(8, fixed(x));
    b.setInt32(12, fixed(y));
    b.setInt32(16, fixed(z));
    return new Uint8Array(b.buffer);
  };
  const curve = () => {
    const n = 1024;
    const b = new DataView(new ArrayBuffer(12 + n * 2));
    b.setUint32(0, 0x63757276); // 'curv'
    b.setUint32(8, n);
    for (let i = 0; i < n; i++) {
      const v = i / (n - 1);
      const lin = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      b.setUint16(12 + i * 2, Math.round(lin * 65535));
    }
    return new Uint8Array(b.buffer);
  };
  const desc = (text: string) => {
    const ascii = enc.encode(text);
    // sig, reserved, ASCII count + text + NUL, Unicode code/count, ScriptCode code/count + 67 bytes.
    const b = new DataView(new ArrayBuffer(12 + ascii.length + 1 + 4 + 4 + 2 + 1 + 67));
    b.setUint32(0, 0x64657363); // 'desc'
    b.setUint32(8, ascii.length + 1);
    new Uint8Array(b.buffer).set(ascii, 12);
    return new Uint8Array(b.buffer);
  };
  const text = (value: string) => {
    const ascii = enc.encode(value);
    const b = new Uint8Array(8 + ascii.length + 1);
    new DataView(b.buffer).setUint32(0, 0x74657874); // 'text'
    b.set(ascii, 8);
    return b;
  };

  const trc = curve();
  const tags: [string, Uint8Array][] = [
    ["desc", desc("sRGB (Photo Inker)")],
    ["cprt", text("No copyright, use freely")],
    ["wtpt", xyz(0.9642, 1.0, 0.8249)],
    ["rXYZ", xyz(0.4360747, 0.2225045, 0.0139322)],
    ["gXYZ", xyz(0.3850649, 0.7168786, 0.0971045)],
    ["bXYZ", xyz(0.1430804, 0.0606169, 0.7141733)],
    ["rTRC", trc],
    ["gTRC", trc],
    ["bTRC", trc],
  ];

  const align = (n: number) => (n + 3) & ~3;
  const tableSize = 4 + tags.length * 12;
  let offset = 128 + tableSize;
  const placed: { sig: string; offset: number; size: number; data: Uint8Array }[] = [];
  const shared = new Map<Uint8Array, number>();
  for (const [sig, data] of tags) {
    const at = shared.get(data);
    if (at !== undefined) {
      placed.push({ sig, offset: at, size: data.length, data });
      continue;
    }
    offset = align(offset);
    shared.set(data, offset);
    placed.push({ sig, offset, size: data.length, data });
    offset += data.length;
  }
  const size = align(offset);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  const sig = (at: number, s: string) => out.set(enc.encode(s), at);

  // Header.
  v.setUint32(0, size);
  v.setUint32(8, 0x02100000); // version 2.1
  sig(12, "mntr");
  sig(16, "RGB ");
  sig(20, "XYZ ");
  v.setUint16(24, 2026); // date: 2026-01-01
  v.setUint16(26, 1);
  v.setUint16(28, 1);
  sig(36, "acsp");
  v.setInt32(68, fixed(0.9642)); // PCS illuminant (D50)
  v.setInt32(72, fixed(1.0));
  v.setInt32(76, fixed(0.8249));

  // Tag table and data.
  v.setUint32(128, placed.length);
  placed.forEach((t, i) => {
    sig(132 + i * 12, t.sig);
    v.setUint32(136 + i * 12, t.offset);
    v.setUint32(140 + i * 12, t.size);
    out.set(t.data, t.offset);
  });
  cached = out;
  return out;
}

/**
 * Sets a JPG's color profile: removes any ICC profile already there (the
 * browser's encoder may add its own), then inserts ours as an APP2
 * ICC_PROFILE segment when `embed` is on.
 */
export async function jpegWithProfile(jpeg: Blob, embed: boolean): Promise<Blob> {
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return jpeg;
  const marker = new TextEncoder().encode("ICC_PROFILE\0");
  const isIcc = (at: number) => marker.every((b, i) => bytes[at + 4 + i] === b);
  // Walk the header segments (up to the start of scan), dropping ICC ones.
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let at = 2;
  let insertAt = 1; // after SOI, or after APP0 (JFIF) if present
  while (at + 4 <= bytes.length && bytes[at] === 0xff && bytes[at + 1] !== 0xda) {
    const len = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    const seg = bytes.subarray(at, at + 2 + len);
    if (!(bytes[at + 1] === 0xe2 && isIcc(at))) {
      kept.push(seg);
      if (bytes[at + 1] === 0xe0 && kept.length === 2) insertAt = 2;
    }
    at += 2 + len;
  }
  kept.push(bytes.subarray(at));
  if (embed) {
    const profile = srgbIccProfile();
    const length = 2 + marker.length + 2 + profile.length;
    const segment = new Uint8Array(2 + length);
    segment.set([0xff, 0xe2, length >> 8, length & 0xff]);
    segment.set(marker, 4);
    segment.set([1, 1], 4 + marker.length); // chunk 1 of 1
    segment.set(profile, 6 + marker.length);
    kept.splice(insertAt, 0, segment);
  }
  return new Blob(kept as BlobPart[], { type: "image/jpeg" });
}
