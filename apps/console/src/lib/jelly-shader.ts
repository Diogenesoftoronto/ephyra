/** A texture-only refraction pass. The alpha silhouette is retained; nothing is drawn behind the specimen. */
const VERTEX = `
attribute vec2 position;
varying vec2 uv;
void main() {
  uv = position * .5 + .5;
  gl_Position = vec4(position, 0., 1.);
}`;

const FRAGMENT = `
precision mediump float;
uniform sampler2D artwork;
uniform float time;
uniform float energy;
uniform vec2 touch;
varying vec2 uv;
void main() {
  vec2 p = uv - .5;
  float radius = length(p);
  float phase = time * 6.283185;
  float bell = sin(phase) * .018 + sin(phase * 2.) * .006;
  vec2 toTouch = uv - touch;
  float distance = length(toTouch);
  float ripple = sin(distance * 32. - phase * 2.) * exp(-distance * 4.) * .009;
  vec2 warped = .5 + p * (1. + energy * bell);
  warped += energy * ripple * toTouch / max(distance, .02);
  warped.x += energy * .004 * sin(p.y * 15. + phase) * (1. - smoothstep(.1, .5, radius));
  vec4 gel = texture2D(artwork, warped);
  float light = sin(warped.x * 21. + warped.y * 17. - phase) * .035;
  float glint = pow(max(0., sin(distance * 22. - phase)), 12.) * .07;
  gl_FragColor = vec4(gel.rgb * (1. + energy * light) + energy * glint * gel.a, gel.a);
}`;

export type JellyRenderer = {
  /** time is a cycle fraction, energy is 0..1, touch uses image coordinates (origin at bottom left). */
  render: (time: number, energy: number, touch?: readonly [number, number]) => void;
  dispose: () => void;
};

/** No dependency, no framebuffer loop, no network. Null means the caller keeps its ordinary image. */
export function createJellyRenderer(canvas: HTMLCanvasElement, image: TexImageSource): JellyRenderer | null {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    powerPreference: "low-power",
  });
  if (!gl) return null;
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  const dispose = () => {
    for (const shader of shaders) gl.deleteShader(shader);
    gl.deleteProgram(program);
    gl.deleteBuffer(buffer);
    gl.deleteTexture(texture);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
  try {
    for (const [kind, source] of [
      [gl.VERTEX_SHADER, VERTEX],
      [gl.FRAGMENT_SHADER, FRAGMENT],
    ] as const) {
      const shader = gl.createShader(kind);
      if (!shader) throw new Error("Shader allocation unavailable");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("Shader compilation unavailable");
      gl.attachShader(program!, shader);
    }
    gl.linkProgram(program!);
    if (!gl.getProgramParameter(program!, gl.LINK_STATUS)) throw new Error("Shader link unavailable");
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program!, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    const time = gl.getUniformLocation(program!, "time");
    const energy = gl.getUniformLocation(program!, "energy");
    const touch = gl.getUniformLocation(program!, "touch");
    return {
      render: (t, e, point = [0.5, 0.5]) => {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform1f(time, t);
        gl.uniform1f(energy, Math.max(0, Math.min(1, e)));
        gl.uniform2f(touch, point[0], point[1]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      },
      dispose,
    };
  } catch {
    dispose();
    return null;
  }
}
