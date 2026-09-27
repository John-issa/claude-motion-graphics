// A shared WebGL layer for full-screen fragment shaders. Scenes render a shader
// into this layer's canvas and composite it into the 2D frame with drawImage,
// so the reel stays a single 2D canvas that can be recorded or exported.

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/**
 * createGL() → { available, canvas, render(fragSource, { width, height, uniforms }) }
 *
 * Fragment shaders are GLSL ES 1.00 (WebGL 1) and receive `varying vec2 vUv`
 * (0..1, y up) plus `uniform vec2 uResolution` (render size in px).
 * Uniform values: number → float; [a, b], [a, b, c], [a, b, c, d] → vecN;
 * { v2 | v3 | v4 | f: flatArray } → arrays of vec2/vec3/vec4/float;
 * { int: n } → int; { tex: canvasOrImage } → sampler2D.
 * Output premultiplied colour; alpha 1 for opaque layers.
 */
export function createGL() {
  if (typeof document === 'undefined') return { available: false, render: () => null };
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  let gl = null;
  try {
    gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
  } catch {
    gl = null;
  }
  if (!gl) return { available: false, render: () => null };

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

  const programs = new Map();
  const textures = new Map();

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(`Shader compile failed:\n${log}`);
    }
    return s;
  }

  function program(frag) {
    let p = programs.get(frag);
    if (p) return p;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Shader link failed: ${gl.getProgramInfoLog(prog)}`);
    }
    p = { prog, locs: new Map() };
    programs.set(frag, p);
    return p;
  }

  function loc(p, name) {
    if (!p.locs.has(name)) p.locs.set(name, gl.getUniformLocation(p.prog, name));
    return p.locs.get(name);
  }

  function texture(source, unit) {
    let tex = textures.get(source);
    if (!tex) {
      tex = gl.createTexture();
      textures.set(source, tex);
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  function render(frag, { width, height, uniforms = {} } = {}) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const p = program(frag);
    gl.viewport(0, 0, w, h);
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    let unit = 0;
    const res = loc(p, 'uResolution');
    if (res) gl.uniform2f(res, w, h);
    for (const name in uniforms) {
      const l = loc(p, name);
      if (l === null) continue;
      const v = uniforms[name];
      if (typeof v === 'number') gl.uniform1f(l, v);
      else if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        if (v.length === 2) gl.uniform2fv(l, v);
        else if (v.length === 3) gl.uniform3fv(l, v);
        else if (v.length === 4) gl.uniform4fv(l, v);
        else gl.uniform1fv(l, v);
      } else if (v && typeof v === 'object') {
        if ('int' in v) gl.uniform1i(l, v.int);
        else if ('v2' in v) gl.uniform2fv(l, v.v2);
        else if ('v3' in v) gl.uniform3fv(l, v.v3);
        else if ('v4' in v) gl.uniform4fv(l, v.v4);
        else if ('f' in v) gl.uniform1fv(l, v.f);
        else if ('tex' in v) {
          texture(v.tex, unit);
          gl.uniform1i(l, unit);
          unit++;
        }
      }
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return canvas;
  }

  return { available: true, canvas, gl, render, program };
}
