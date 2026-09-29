// Small WebGL2 helpers shared by every GPU pass.

export class GLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GLError";
  }
}

export function getWebGL2(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  attributes?: WebGLContextAttributes,
): WebGL2RenderingContext {
  const gl = canvas.getContext("webgl2", attributes) as WebGL2RenderingContext | null;
  if (!gl) throw new GLError("This browser doesn't support WebGL2, which Photo Inker needs.");
  return gl;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new GLError("Couldn't create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new GLError(`Shader compile failed: ${log}`);
  }
  return shader;
}

export function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new GLError("Couldn't create program");
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new GLError(`Program link failed: ${log}`);
  }
  return program;
}

export function uniformLocations<N extends string>(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: readonly N[],
): Record<N, WebGLUniformLocation | null> {
  const out = {} as Record<N, WebGLUniformLocation | null>;
  for (const name of names) out[name] = gl.getUniformLocation(program, name);
  return out;
}

/** Vertex shader for a full-screen triangle; no vertex buffers needed (draw 3 vertices). */
export const FULLSCREEN_VERTEX = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** GLSL: linear light to sRGB transfer (shared by every display pass). */
export const GLSL_LINEAR_TO_SRGB = /* glsl */ `
vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.0031308))));
}
`;

/** GLSL: sRGB to linear light. */
export const GLSL_SRGB_TO_LINEAR = /* glsl */ `
vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.04045))));
}
`;

/** Lightness sources, in the order the GLSL lightness() function numbers them. */
export const LIGHTNESS_SOURCES = ["luma", "lstar", "red", "green", "blue", "max", "min"] as const;
export type LightnessSource = (typeof LIGHTNESS_SOURCES)[number];

/** GLSL: lightness (0 = black, 1 = white) of a linear-light color. Needs GLSL_LINEAR_TO_SRGB. */
export const GLSL_LIGHTNESS = /* glsl */ `
float lightness(vec3 lin, int source) {
  vec3 s = linearToSrgb(lin);
  if (source == 1) {
    float y = dot(clamp(lin, 0.0, 1.0), vec3(0.2126, 0.7152, 0.0722));
    return (y > 0.008856 ? 116.0 * pow(y, 1.0 / 3.0) - 16.0 : 903.3 * y) / 100.0;
  }
  if (source == 2) return s.r;
  if (source == 3) return s.g;
  if (source == 4) return s.b;
  if (source == 5) return max(s.r, max(s.g, s.b));
  if (source == 6) return min(s.r, min(s.g, s.b));
  return dot(s, vec3(0.2126, 0.7152, 0.0722)); // luma (gamma-encoded)
}
`;
