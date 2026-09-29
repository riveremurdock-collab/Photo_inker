// Draws the image into the preview canvas with the current zoom and pan.
// The canvas is only as big as the preview area; zoom and pan are shader
// uniforms, so moving around a large image costs one small draw.
//
// The image texture is sRGB (SRGB8_ALPHA8), so the GPU decodes to linear light
// before filtering. Mipmaps and zoomed-out sampling therefore average in
// linear light, which keeps tones consistent at every zoom level.

import {
  createProgram,
  FULLSCREEN_VERTEX,
  getWebGL2,
  GLSL_LINEAR_TO_SRGB,
  uniformLocations,
} from "../../engine/gl/program";
import { linearToSrgbChannel } from "../../util/color";

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec2 uViewSize;   // device px
uniform vec2 uImageSize;  // image px
uniform vec2 uOrigin;     // device px position of the image's top-left corner
uniform float uScale;     // device px per image px
uniform vec3 uBackground; // linear
uniform vec3 uPaper;      // linear
out vec4 outColor;
${GLSL_LINEAR_TO_SRGB}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uViewSize.y - gl_FragCoord.y);
  vec2 uv = (p - uOrigin) / uScale / uImageSize;
  // Sample outside the branch so mip selection has valid derivatives at the image edge.
  vec4 t = texture(uImage, uv);
  vec3 c = uBackground;
  if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) {
    c = mix(uPaper, t.rgb, t.a); // transparent areas show the paper
  }
  outColor = vec4(linearToSrgb(c), 1.0);
}
`;

/** Longest texture edge used for display. Larger images are downscaled once for the screen. */
const DISPLAY_TEXTURE_CAP = 8192;

export interface ViewTransform {
  /** Device px per image px (1 = 100%). */
  scale: number;
  /** Device px position of the image's top-left corner. */
  originX: number;
  originY: number;
}

const UNIFORMS = ["uImage", "uViewSize", "uImageSize", "uOrigin", "uScale", "uBackground", "uPaper"] as const;

export class ViewRenderer {
  readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private uniforms: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  private texture: WebGLTexture | null = null;
  private textureWidth = 0;
  private imageWidth = 0;
  private imageHeight = 0;
  private magNearest = false;
  private paper: [number, number, number] = [1, 1, 1];

  constructor(
    private canvas: HTMLCanvasElement,
    private background: [number, number, number],
  ) {
    this.gl = getWebGL2(canvas, {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
    });
    this.program = createProgram(this.gl, FULLSCREEN_VERTEX, FRAGMENT);
    this.uniforms = uniformLocations(this.gl, this.program, UNIFORMS);
  }

  /** Paper color (linear RGB), shown through transparent parts of the image. */
  setPaper(paper: [number, number, number]): void {
    this.paper = paper;
  }

  setImage(bitmap: ImageBitmap): void {
    const gl = this.gl;
    const cap = Math.min(DISPLAY_TEXTURE_CAP, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    const source = fitWithin(bitmap, cap);

    if (this.texture) gl.deleteTexture(this.texture);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, source.width, source.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.magNearest = false;

    this.textureWidth = source.width;
    this.imageWidth = bitmap.width;
    this.imageHeight = bitmap.height;
    if (source !== bitmap) source.close();
  }

  render(view: ViewTransform): void {
    const gl = this.gl;
    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);

    if (!this.texture) {
      const [r, g, b] = this.background.map(linearToSrgbChannel) as [number, number, number];
      gl.clearColor(r, g, b, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    // Crisp pixels once each texel covers 2+ screen pixels, smooth below that.
    const texelScale = (view.scale * this.imageWidth) / this.textureWidth;
    const wantNearest = texelScale >= 2;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (wantNearest !== this.magNearest) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, wantNearest ? gl.NEAREST : gl.LINEAR);
      this.magNearest = wantNearest;
    }

    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.uniforms.uImage, 0);
    gl.uniform2f(this.uniforms.uViewSize, width, height);
    gl.uniform2f(this.uniforms.uImageSize, this.imageWidth, this.imageHeight);
    gl.uniform2f(this.uniforms.uOrigin, view.originX, view.originY);
    gl.uniform1f(this.uniforms.uScale, view.scale);
    gl.uniform3f(this.uniforms.uBackground, ...this.background);
    gl.uniform3f(this.uniforms.uPaper, ...this.paper);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

/** Returns the bitmap unchanged if it fits, otherwise a downscaled copy (the caller closes it). */
function fitWithin(bitmap: ImageBitmap, cap: number): ImageBitmap {
  const longEdge = Math.max(bitmap.width, bitmap.height);
  if (longEdge <= cap) return bitmap;
  const k = cap / longEdge;
  const w = Math.max(1, Math.round(bitmap.width * k));
  const h = Math.max(1, Math.round(bitmap.height * k));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.transferToImageBitmap();
}
