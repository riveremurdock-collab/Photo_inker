// Draws a display texture into the preview canvas with the current zoom and pan.
// The canvas is only as big as the preview area; zoom and pan are shader
// uniforms, so moving around a large image costs one small draw.
//
// Display textures are sRGB (SRGB8_ALPHA8) with mipmaps, so the GPU decodes to
// linear light before filtering. Zoomed-out views therefore average in linear
// light, which keeps tones the same at every zoom level.

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

export interface ViewTransform {
  /** Device px per image px (1 = 100%). */
  scale: number;
  /** Device px position of the image's top-left corner. */
  originX: number;
  originY: number;
}

/** A texture to show, and how big the image it represents is. */
export interface DisplaySource {
  /** sRGB texture with mipmaps; row 0 = image top. */
  texture: WebGLTexture;
  /** Texture width in texels (may be smaller than the image, e.g. a preview-resolution render). */
  textureWidth: number;
}

const UNIFORMS = ["uImage", "uViewSize", "uImageSize", "uOrigin", "uScale", "uBackground", "uPaper"] as const;

export class ViewRenderer {
  readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private uniforms: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  private source: DisplaySource | null = null;
  private magNearest = new WeakMap<WebGLTexture, boolean>();
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

  setSource(source: DisplaySource | null): void {
    this.source = source;
  }

  render(view: ViewTransform, imageWidth: number, imageHeight: number): void {
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

    // Crisp pixels once each texel covers 2+ screen pixels, smooth below that.
    const texelScale = (view.scale * imageWidth) / this.source.textureWidth;
    const wantNearest = texelScale >= 2;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.source.texture);
    if (wantNearest !== (this.magNearest.get(this.source.texture) ?? false)) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, wantNearest ? gl.NEAREST : gl.LINEAR);
      this.magNearest.set(this.source.texture, wantNearest);
    }

    gl.useProgram(this.program);
    gl.uniform1i(this.uniforms.uImage, 0);
    gl.uniform2f(this.uniforms.uViewSize, width, height);
    gl.uniform2f(this.uniforms.uImageSize, imageWidth, imageHeight);
    gl.uniform2f(this.uniforms.uOrigin, view.originX, view.originY);
    gl.uniform1f(this.uniforms.uScale, view.scale);
    gl.uniform3f(this.uniforms.uBackground, ...this.background);
    gl.uniform3f(this.uniforms.uPaper, ...this.paper);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
