// Draws the current display source into the preview canvas with the current
// zoom and pan. The canvas is only as big as the preview area; zoom and pan
// are shader uniforms, so moving around a large image costs one small draw.
//
// Two kinds of source:
// - A texture (sRGB, with mipmaps): the GPU decodes to linear light before
//   filtering, so zoomed-out views average in linear light and keep their
//   tone at every zoom level. An optional "detail" texture holds a sharper
//   render of the visible area and is drawn over the base texture.
// - A procedural source that draws the view itself (the halftone compositor).

import {
  createProgram,
  FULLSCREEN_VERTEX,
  getWebGL2,
  GLSL_LINEAR_TO_SRGB,
  uniformLocations,
} from "../../engine/gl/program";
import { GLSL_ROUNDED_RECT, type BorderGeometry } from "../../app/border";
import { linearToSrgbChannel } from "../../util/color";

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform sampler2D uDetail;
uniform vec4 uDetailRect; // image px: x, y, width, height (width 0 = no detail)
uniform vec2 uViewSize;   // device px
uniform vec2 uImageSize;  // image px
uniform vec2 uOrigin;     // device px position of the image's top-left corner
uniform float uScale;     // device px per image px
uniform vec3 uBackground; // linear
uniform vec3 uPaper;      // linear
uniform int uFrameMode;   // 0 = no border
uniform vec4 uFrameCanvas;
uniform vec4 uFrameInner;
uniform float uFrameRadius;
uniform vec3 uFrameColor; // linear
out vec4 outColor;
${GLSL_LINEAR_TO_SRGB}
${GLSL_ROUNDED_RECT}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uViewSize.y - gl_FragCoord.y);
  vec2 ip = (p - uOrigin) / uScale;
  vec2 uv = ip / uImageSize;
  // Sample outside the branches so mip selection has valid derivatives at edges.
  vec4 t = texture(uImage, uv);
  vec2 duv = (ip - uDetailRect.xy) / max(uDetailRect.zw, vec2(1e-6));
  vec4 d = texture(uDetail, duv);
  if (uDetailRect.z > 0.0 && all(greaterThanEqual(duv, vec2(0.0))) && all(lessThan(duv, vec2(1.0)))) t = d;
  vec3 c = uBackground;
  if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) {
    c = mix(uPaper, t.rgb, t.a); // transparent areas show the paper
  }
  if (uFrameMode != 0 && all(greaterThanEqual(ip, uFrameCanvas.xy)) && all(lessThan(ip, uFrameCanvas.zw))) {
    // Around the image (a border that grows the canvas) there is only border.
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) c = uFrameColor;
    // Anti-aliased edge: blend over about one screen pixel.
    float d = roundedRectSdf(ip, uFrameInner, uFrameRadius) * uScale;
    c = mix(c, uFrameColor, clamp(d + 0.5, 0.0, 1.0));
  }
  outColor = vec4(linearToSrgb(c), 1.0);
}
`;

export interface ViewTransform {
  /** Device px per image px (1 = 100%). */
  scale: number;
  /** Device px position of the image's top-left corner. */
  originX: number;
  originY: number;
}

/** A solid ink / paper border to draw around (or over the edge of) the image. */
export interface FrameDisplay {
  geometry: BorderGeometry;
  /** Linear RGB. */
  color: [number, number, number];
}

export interface DetailTexture {
  texture: WebGLTexture;
  /** Area of the image it covers, in image px. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A texture to show, and how big the image it represents is. */
export interface TextureSource {
  kind: "texture";
  /** sRGB texture with mipmaps; row 0 = image top. */
  texture: WebGLTexture;
  /** Texture width in texels (may be smaller than the image, e.g. a reduced-resolution render). */
  textureWidth: number;
  /** Optional sharper render of part of the image, drawn over the base texture. */
  detail?: DetailTexture | null;
}

/** Something that draws the whole view itself (e.g. the halftone compositor). */
export interface ProceduralSource {
  kind: "procedural";
  /** "fast" while the user is zooming or panning, "full" once the view settles. */
  draw(view: ViewTransform, canvasWidth: number, canvasHeight: number, quality: "fast" | "full"): void;
}

export type DisplaySource = TextureSource | ProceduralSource;

const UNIFORMS = [
  "uImage",
  "uDetail",
  "uDetailRect",
  "uViewSize",
  "uImageSize",
  "uOrigin",
  "uScale",
  "uBackground",
  "uPaper",
  "uFrameMode",
  "uFrameCanvas",
  "uFrameInner",
  "uFrameRadius",
  "uFrameColor",
] as const;

export class ViewRenderer {
  readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private uniforms: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  private source: DisplaySource | null = null;
  private magNearest = new WeakMap<WebGLTexture, boolean>();
  private paper: [number, number, number] = [1, 1, 1];
  private frame: FrameDisplay | null = null;

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
      // Keeps the last frame readable for screenshots/tests; costs nothing noticeable here.
      preserveDrawingBuffer: true,
    });
    this.program = createProgram(this.gl, FULLSCREEN_VERTEX, FRAGMENT);
    this.uniforms = uniformLocations(this.gl, this.program, UNIFORMS);
  }

  /** Paper color (linear RGB), shown through transparent parts of the image. */
  setPaper(paper: [number, number, number]): void {
    this.paper = paper;
  }

  setFrame(frame: FrameDisplay | null): void {
    this.frame = frame;
  }

  setSource(source: DisplaySource | null): void {
    this.source = source;
  }

  render(view: ViewTransform, imageWidth: number, imageHeight: number, quality: "fast" | "full" = "full"): void {
    const gl = this.gl;
    const { width, height } = this.canvas;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);

    if (!this.source || imageWidth === 0) {
      const [r, g, b] = this.background.map(linearToSrgbChannel) as [number, number, number];
      gl.clearColor(r, g, b, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    if (this.source.kind === "procedural") {
      this.source.draw(view, width, height, quality);
      return;
    }

    // Crisp pixels only when zoomed past 200% of real image pixels, and only if
    // the texture has every image pixel (otherwise upscaling it blocky would
    // just show processing resolution, not the image).
    const fullResolution = this.source.textureWidth >= imageWidth;
    const wantNearest = fullResolution && view.scale >= 2;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.source.texture);
    if (wantNearest !== (this.magNearest.get(this.source.texture) ?? false)) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, wantNearest ? gl.NEAREST : gl.LINEAR);
      this.magNearest.set(this.source.texture, wantNearest);
    }
    const detail = this.source.detail;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, detail?.texture ?? this.source.texture);
    gl.activeTexture(gl.TEXTURE0);

    gl.useProgram(this.program);
    gl.uniform1i(this.uniforms.uImage, 0);
    gl.uniform1i(this.uniforms.uDetail, 1);
    gl.uniform4f(this.uniforms.uDetailRect, detail?.x ?? 0, detail?.y ?? 0, detail?.width ?? 0, detail?.height ?? 0);
    gl.uniform2f(this.uniforms.uViewSize, width, height);
    gl.uniform2f(this.uniforms.uImageSize, imageWidth, imageHeight);
    gl.uniform2f(this.uniforms.uOrigin, view.originX, view.originY);
    gl.uniform1f(this.uniforms.uScale, view.scale);
    gl.uniform3f(this.uniforms.uBackground, ...this.background);
    gl.uniform3f(this.uniforms.uPaper, ...this.paper);
    const f = this.frame?.geometry;
    gl.uniform1i(this.uniforms.uFrameMode, f?.mode ?? 0);
    if (f) {
      gl.uniform4f(this.uniforms.uFrameCanvas, ...f.canvas);
      gl.uniform4f(this.uniforms.uFrameInner, ...f.inner);
      gl.uniform1f(this.uniforms.uFrameRadius, f.radius);
      gl.uniform3f(this.uniforms.uFrameColor, ...this.frame!.color);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
