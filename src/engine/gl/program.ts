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
