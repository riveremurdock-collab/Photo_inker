// Render targets and fullscreen passes for the GPU pipeline stages.
//
// Formats (all core WebGL2, no extensions needed):
// - "image": SRGB8_ALPHA8. Holds linear-light colors: the GPU encodes to sRGB
//   when writing and decodes when sampling, so 8 bits keep good precision in
//   the shadows, and filtering/mipmaps average in linear light.
// - "coverage": RGBA8. One ink per channel, 0 = no ink, 1 = full ink.

import { createProgram, FULLSCREEN_VERTEX } from "./program";

export type TargetFormat = "image" | "coverage";

export interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
  format: TargetFormat;
}

type UniformValue =
  | number
  | boolean
  | readonly number[]
  | Float32Array
  | Int32Array
  | { texture: WebGLTexture; target?: "2d" | "3d" };

export class Gpu {
  private programs = new Map<string, { program: WebGLProgram; uniforms: Map<string, WebGLUniformLocation | null> }>();
  private uniformTypes = new Map<WebGLProgram, Map<string, number>>();

  constructor(readonly gl: WebGL2RenderingContext) {}

  get maxTextureSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  createTarget(width: number, height: number, format: TargetFormat, options: { mipmaps?: boolean } = {}): Target {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const internal = format === "image" ? gl.SRGB8_ALPHA8 : gl.RGBA8;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, options.mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture, framebuffer, width, height, format };
  }

  /** Returns `existing` if it already has this size and format, otherwise a new target (deleting the old one). */
  ensureTarget(existing: Target | null, width: number, height: number, format: TargetFormat, options: { mipmaps?: boolean } = {}): Target {
    if (existing && existing.width === width && existing.height === height && existing.format === format) return existing;
    if (existing) this.deleteTarget(existing);
    return this.createTarget(width, height, format, options);
  }

  deleteTarget(target: Target): void {
    this.gl.deleteTexture(target.texture);
    this.gl.deleteFramebuffer(target.framebuffer);
  }

  /** Runs a fullscreen fragment shader into `target`. Textures are bound to units in the order they appear. */
  pass(fragmentSource: string, target: Target, uniforms: Record<string, UniformValue>): void {
    const gl = this.gl;
    const { program, uniforms: locations } = this.program(fragmentSource);
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.disable(gl.BLEND);

    let unit = 0;
    const types = this.uniformTypes.get(program)!;
    for (const [name, value] of Object.entries(uniforms)) {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
      const loc = locations.get(name) ?? null;
      if (loc === null) continue;
      const type = types.get(name);
      if (typeof value === "object" && value !== null && "texture" in value) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(value.target === "3d" ? gl.TEXTURE_3D : gl.TEXTURE_2D, value.texture);
        gl.uniform1i(loc, unit++);
      } else if (typeof value === "number" || typeof value === "boolean") {
        const v = Number(value);
        if (type === gl.INT || type === gl.BOOL) gl.uniform1i(loc, v);
        else gl.uniform1f(loc, v);
      } else {
        const arr = value as ArrayLike<number>;
        switch (type) {
          case gl.FLOAT_VEC2:
            gl.uniform2fv(loc, arr as Float32List);
            break;
          case gl.FLOAT_VEC3:
            gl.uniform3fv(loc, arr as Float32List);
            break;
          case gl.FLOAT_VEC4:
            gl.uniform4fv(loc, arr as Float32List);
            break;
          case gl.INT:
          case gl.BOOL:
            gl.uniform1iv(loc, arr as Int32List);
            break;
          case gl.INT_VEC4:
          case gl.BOOL_VEC4:
            gl.uniform4iv(loc, arr as Int32List);
            break;
          default:
            gl.uniform1fv(loc, arr as Float32List);
        }
      }
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  generateMipmaps(target: Target): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** Reads a target back as RGBA bytes (row 0 = first row rendered, i.e. the image's top). */
  read(target: Target): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(target.width * target.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  private program(fragmentSource: string) {
    let entry = this.programs.get(fragmentSource);
    if (!entry) {
      const program = createProgram(this.gl, FULLSCREEN_VERTEX, fragmentSource);
      entry = { program, uniforms: new Map() };
      this.programs.set(fragmentSource, entry);
      // Remember uniform types so pass() can pick the right gl.uniform* call.
      const gl = this.gl;
      const types = new Map<string, number>();
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(program, i);
        if (info) types.set(info.name.replace(/\[0\]$/, ""), info.type);
      }
      this.uniformTypes.set(program, types);
    }
    return entry;
  }
}

/**
 * GLSL helper: every pipeline texture stores row 0 at the image top, and
 * passes draw with gl_FragCoord.y = 0 at row 0, so uv needs no flipping.
 */
export const GLSL_UV = /* glsl */ `
uniform vec2 uSize;
vec2 pixelUv() { return gl_FragCoord.xy / uSize; }
`;
