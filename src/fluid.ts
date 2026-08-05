/**
 * Real fluid ink under glass.
 *
 * A GPU Navier–Stokes solver (stable fluids): semi-Lagrangian advection,
 * Jacobi pressure projection, and vorticity confinement, with an ink dye
 * field advected through the velocity field. The classic real-time fluid
 * formulation (Stam; popularized on the web by Pavel Dobryakov's WebGL
 * fluid), implemented here from scratch for a paper-white page:
 *
 *  · Dye is stored as pigment absorption, and the display shader resolves
 *    `paper − pigment`, so the canvas multiplies onto the page like real
 *    ink rather than glowing like neon on black.
 *  · The display pass computes a surface normal from the pigment gradient
 *    and adds diffuse + specular lighting — the liquid reads as glossy,
 *    sitting under the CSS glass layer above it.
 *
 * The cursor stirs the liquid; clicking splashes. Ambient droplets keep it
 * alive. Pigment uses discrete jewel inks; the current one is published as
 * `--live-ink` for the rest of the page. Removed under reduced motion, and
 * degrades to nothing if WebGL2 float rendering is unavailable.
 */

interface RGB {
  r: number;
  g: number;
  b: number;
}

/* ---------- tuning ---------- */
const SIM_RES = 144; // velocity grid (longest edge)
const DYE_RES = 760; // pigment grid (longest edge)
const PRESSURE_ITERATIONS = 20;
const CURL = 26; // vorticity confinement strength
const DENSITY_DISSIPATION = 0.32; // how fast pigment clears (per second)
const VELOCITY_DISSIPATION = 0.28;
const SPLAT_FORCE = 5200;
const SPLAT_RADIUS = 0.0032;
const IDLE_SLEEP_MS = 14000; // stop rendering this long after the last splat

/* Jewel inks (sRGB). One true pigment at a time, like real suminagashi. */
const INKS: readonly { rgb: RGB; css: string }[] = [
  { rgb: hsl(233, 66, 46), css: "hsl(233, 66%, 46%)" }, // ultramarine
  { rgb: hsl(187, 70, 33), css: "hsl(187, 70%, 33%)" }, // teal
  { rgb: hsl(318, 62, 42), css: "hsl(318, 62%, 42%)" }, // plum
  { rgb: hsl(205, 72, 42), css: "hsl(205, 72%, 42%)" }, // cerulean
  { rgb: hsl(352, 64, 44), css: "hsl(352, 64%, 44%)" }, // crimson
  { rgb: hsl(155, 50, 32), css: "hsl(155, 50%, 32%)" }, // jade
  { rgb: hsl(262, 62, 47), css: "hsl(262, 62%, 47%)" }, // violet
];

function hsl(h: number, s: number, l: number): RGB {
  const sn = s / 100;
  const ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return ln - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return { r: f(0), g: f(8), b: f(4) };
}

/* ---------- shaders ---------- */

const VERT = `#version 300 es
precision highp float;
in vec2 aPos;
out vec2 vUv;
out vec2 vL; out vec2 vR; out vec2 vT; out vec2 vB;
uniform vec2 texelSize;
void main () {
  vUv = aPos * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_SPLAT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform float radius;
void main () {
  vec2 p = vUv - point;
  p.x *= aspectRatio;
  vec3 splat = exp(-dot(p, p) / radius) * color;
  o = vec4(texture(uTarget, vUv).xyz + splat, 1.0);
}`;

const FRAG_ADVECTION = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform float dt;
uniform float dissipation;
void main () {
  vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
  vec4 result = texture(uSource, coord);
  float decay = 1.0 + dissipation * dt;
  o = result / decay;
}`;

const FRAG_DIVERGENCE = `#version 300 es
precision highp float;
in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
out vec4 o;
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).x;
  float R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y;
  float B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vL.x < 0.0) { L = -C.x; }
  if (vR.x > 1.0) { R = -C.x; }
  if (vT.y > 1.0) { T = -C.y; }
  if (vB.y < 0.0) { B = -C.y; }
  o = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;

const FRAG_CURL = `#version 300 es
precision highp float;
in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
out vec4 o;
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).y;
  float R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x;
  float B = texture(uVelocity, vB).x;
  o = vec4(R - L - T + B, 0.0, 0.0, 1.0);
}`;

const FRAG_VORTICITY = `#version 300 es
precision highp float;
in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
out vec4 o;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main () {
  float L = texture(uCurl, vL).x;
  float R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x;
  float B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 velocity = texture(uVelocity, vUv).xy + force * dt;
  velocity = clamp(velocity, vec2(-1000.0), vec2(1000.0));
  o = vec4(velocity, 0.0, 1.0);
}`;

const FRAG_PRESSURE = `#version 300 es
precision highp float;
in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
out vec4 o;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main () {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  float divergence = texture(uDivergence, vUv).x;
  o = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
}`;

const FRAG_GRADIENT = `#version 300 es
precision highp float;
in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
out vec4 o;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main () {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  vec2 velocity = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
  o = vec4(velocity, 0.0, 1.0);
}`;

/* Pigment on paper, lit like a glossy liquid surface. */
const FRAG_DISPLAY = `#version 300 es
precision highp float;
in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
out vec4 o;
uniform sampler2D uTexture;
void main () {
  vec3 P  = texture(uTexture, vUv).rgb;   // pigment absorption
  float cC = dot(P, vec3(0.299, 0.587, 0.114));
  float cL = dot(texture(uTexture, vL).rgb, vec3(0.299, 0.587, 0.114));
  float cR = dot(texture(uTexture, vR).rgb, vec3(0.299, 0.587, 0.114));
  float cT = dot(texture(uTexture, vT).rgb, vec3(0.299, 0.587, 0.114));
  float cB = dot(texture(uTexture, vB).rgb, vec3(0.299, 0.587, 0.114));

  vec3 n = normalize(vec3(cL - cR, cB - cT, 0.35));
  vec3 lightDir = normalize(vec3(-0.4, 0.65, 0.65));
  float diffuse = clamp(dot(n, lightDir) + 0.72, 0.72, 1.0);

  vec3 halfDir = normalize(lightDir + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, halfDir), 0.0), 48.0) * smoothstep(0.02, 0.35, cC) * 0.55;

  vec3 paper = vec3(1.0);
  vec3 color = clamp(paper - P, 0.0, 1.0) * diffuse + spec;
  o = vec4(color, 1.0);
}`;

/* ---------- tiny GL plumbing ---------- */

interface FBO {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
  texelX: number;
  texelY: number;
  attach(unit: number): number;
}

interface DoubleFBO {
  read: FBO;
  write: FBO;
  swap(): void;
  texelX: number;
  texelY: number;
}

class Program {
  prog: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation> = {};
  constructor(gl: WebGL2RenderingContext, vs: WebGLShader, fsSource: string) {
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource);
    const p = gl.createProgram()!;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(String(gl.getProgramInfoLog(p)));
    }
    this.prog = p;
    const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(p, i);
      if (info) this.uniforms[info.name] = gl.getUniformLocation(p, info.name)!;
    }
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(String(gl.getShaderInfoLog(s)));
  }
  return s;
}

export function initFluid(canvas: HTMLCanvasElement): void {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion) {
    canvas.remove();
    return;
  }

  const gl = canvas.getContext("webgl2", {
    alpha: false,
    depth: false,
    stencil: false,
    antialias: false,
    preserveDrawingBuffer: false,
  });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
    canvas.remove(); // no float render targets: quietly keep the plain page
    return;
  }
  gl.getExtension("OES_texture_float_linear");

  /* fullscreen triangle */
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const pSplat = new Program(gl, vs, FRAG_SPLAT);
  const pAdvect = new Program(gl, vs, FRAG_ADVECTION);
  const pDiverge = new Program(gl, vs, FRAG_DIVERGENCE);
  const pCurl = new Program(gl, vs, FRAG_CURL);
  const pVort = new Program(gl, vs, FRAG_VORTICITY);
  const pPress = new Program(gl, vs, FRAG_PRESSURE);
  const pGrad = new Program(gl, vs, FRAG_GRADIENT);
  const pDisplay = new Program(gl, vs, FRAG_DISPLAY);

  function createFBO(w: number, h: number, internal: number, format: number, filter: number): FBO {
    const tex = gl!.createTexture()!;
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, filter);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, filter);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, internal, w, h, 0, format, gl!.HALF_FLOAT, null);
    const fb = gl!.createFramebuffer()!;
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fb);
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, tex, 0);
    gl!.viewport(0, 0, w, h);
    gl!.clearColor(0, 0, 0, 1);
    gl!.clear(gl!.COLOR_BUFFER_BIT);
    return {
      fb,
      tex,
      w,
      h,
      texelX: 1 / w,
      texelY: 1 / h,
      attach(unit: number) {
        gl!.activeTexture(gl!.TEXTURE0 + unit);
        gl!.bindTexture(gl!.TEXTURE_2D, tex);
        return unit;
      },
    };
  }

  function createDouble(w: number, h: number, internal: number, format: number, filter: number): DoubleFBO {
    let a = createFBO(w, h, internal, format, filter);
    let b = createFBO(w, h, internal, format, filter);
    return {
      get read() {
        return a;
      },
      get write() {
        return b;
      },
      swap() {
        const t = a;
        a = b;
        b = t;
      },
      texelX: 1 / w,
      texelY: 1 / h,
    } as DoubleFBO;
  }

  function simSize(longest: number): { w: number; h: number } {
    const aspect = window.innerWidth / window.innerHeight;
    return aspect > 1
      ? { w: longest, h: Math.round(longest / aspect) }
      : { w: Math.round(longest * aspect), h: longest };
  }

  let velocity!: DoubleFBO;
  let dye!: DoubleFBO;
  let pressure!: DoubleFBO;
  let divergence!: FBO;
  let curl!: FBO;

  function initTargets(): void {
    const sim = simSize(SIM_RES);
    const dyeS = simSize(DYE_RES);
    velocity = createDouble(sim.w, sim.h, gl!.RG16F, gl!.RG, gl!.LINEAR);
    pressure = createDouble(sim.w, sim.h, gl!.R16F, gl!.RED, gl!.NEAREST);
    divergence = createFBO(sim.w, sim.h, gl!.R16F, gl!.RED, gl!.NEAREST);
    curl = createFBO(sim.w, sim.h, gl!.R16F, gl!.RED, gl!.NEAREST);
    dye = createDouble(dyeS.w, dyeS.h, gl!.RGBA16F, gl!.RGBA, gl!.LINEAR);
  }

  function resizeCanvas(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  }

  function blit(target: FBO | null): void {
    if (target) {
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, target.fb);
      gl!.viewport(0, 0, target.w, target.h);
    } else {
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
      gl!.viewport(0, 0, canvas.width, canvas.height);
    }
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
  }

  function use(p: Program, texelX: number, texelY: number): void {
    gl!.useProgram(p.prog);
    if (p.uniforms.texelSize) gl!.uniform2f(p.uniforms.texelSize, texelX, texelY);
  }

  /* ---------- ink state ---------- */

  let inkIndex = Math.floor(Math.random() * INKS.length);
  let inkSpent = 0; // pigment laid down with the current ink
  let lastSplatAt = performance.now();

  function currentInk(): { rgb: RGB; css: string } {
    return INKS[inkIndex];
  }
  function advanceInk(): void {
    inkIndex = (inkIndex + 1) % INKS.length;
    inkSpent = 0;
    document.documentElement.style.setProperty("--live-ink", currentInk().css);
  }

  /** absorption = 1 − ink color, scaled: what the pigment takes from paper */
  function absorption(rgb: RGB, strength: number): [number, number, number] {
    return [(1 - rgb.r) * strength, (1 - rgb.g) * strength, (1 - rgb.b) * strength];
  }

  function splat(x: number, y: number, dx: number, dy: number, strength: number): void {
    const aspect = canvas.width / canvas.height;

    use(pSplat, velocity.texelX, velocity.texelY);
    gl!.uniform1i(pSplat.uniforms.uTarget, velocity.read.attach(0));
    gl!.uniform1f(pSplat.uniforms.aspectRatio, aspect);
    gl!.uniform2f(pSplat.uniforms.point, x, y);
    gl!.uniform3f(pSplat.uniforms.color, dx, dy, 0);
    gl!.uniform1f(pSplat.uniforms.radius, SPLAT_RADIUS);
    blit(velocity.write);
    velocity.swap();

    const [a, b, c] = absorption(currentInk().rgb, strength);
    gl!.uniform1i(pSplat.uniforms.uTarget, dye.read.attach(0));
    gl!.uniform3f(pSplat.uniforms.color, a, b, c);
    blit(dye.write);
    dye.swap();

    inkSpent += strength;
    if (inkSpent > 6) advanceInk(); // the brush runs dry, dip into the next ink
    lastSplatAt = performance.now();
    wake();
  }

  /* ---------- simulation step ---------- */

  let lastTime = performance.now();
  let running = false;

  function step(dt: number): void {
    gl!.disable(gl!.BLEND);

    use(pCurl, velocity.texelX, velocity.texelY);
    gl!.uniform1i(pCurl.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    use(pVort, velocity.texelX, velocity.texelY);
    gl!.uniform1i(pVort.uniforms.uVelocity, velocity.read.attach(0));
    gl!.uniform1i(pVort.uniforms.uCurl, curl.attach(1));
    gl!.uniform1f(pVort.uniforms.curl, CURL);
    gl!.uniform1f(pVort.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    use(pDiverge, velocity.texelX, velocity.texelY);
    gl!.uniform1i(pDiverge.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    use(pPress, velocity.texelX, velocity.texelY);
    gl!.uniform1i(pPress.uniforms.uDivergence, divergence.attach(1));
    for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
      gl!.uniform1i(pPress.uniforms.uPressure, pressure.read.attach(0));
      blit(pressure.write);
      pressure.swap();
    }

    use(pGrad, velocity.texelX, velocity.texelY);
    gl!.uniform1i(pGrad.uniforms.uPressure, pressure.read.attach(0));
    gl!.uniform1i(pGrad.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    use(pAdvect, velocity.texelX, velocity.texelY);
    gl!.uniform2f(pAdvect.uniforms.texelSize, velocity.texelX, velocity.texelY);
    gl!.uniform1i(pAdvect.uniforms.uVelocity, velocity.read.attach(0));
    gl!.uniform1i(pAdvect.uniforms.uSource, velocity.read.attach(0));
    gl!.uniform1f(pAdvect.uniforms.dt, dt);
    gl!.uniform1f(pAdvect.uniforms.dissipation, VELOCITY_DISSIPATION);
    blit(velocity.write);
    velocity.swap();

    gl!.uniform1i(pAdvect.uniforms.uVelocity, velocity.read.attach(0));
    gl!.uniform1i(pAdvect.uniforms.uSource, dye.read.attach(1));
    gl!.uniform1f(pAdvect.uniforms.dissipation, DENSITY_DISSIPATION);
    blit(dye.write);
    dye.swap();
  }

  function render(): void {
    use(pDisplay, dye.texelX, dye.texelY);
    gl!.uniform1i(pDisplay.uniforms.uTexture, dye.read.attach(0));
    blit(null);
  }

  function frame(): void {
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.033);
    lastTime = now;
    step(dt);
    render();
    if (!document.hidden && now - lastSplatAt < IDLE_SLEEP_MS) {
      requestAnimationFrame(frame);
    } else {
      running = false; // liquid has settled; sleep until the next splat
    }
  }

  function wake(): void {
    if (!running && !document.hidden) {
      running = true;
      lastTime = performance.now();
      requestAnimationFrame(frame);
    }
  }

  /* ---------- interaction ---------- */

  let pointer: { x: number; y: number } | null = null;

  window.addEventListener(
    "pointermove",
    (e: PointerEvent) => {
      const x = e.clientX / window.innerWidth;
      const y = 1 - e.clientY / window.innerHeight;
      if (pointer) {
        const dx = (x - pointer.x) * SPLAT_FORCE;
        const dy = (y - pointer.y) * SPLAT_FORCE;
        if (Math.abs(dx) + Math.abs(dy) > 2) {
          splat(x, y, dx, dy, 0.055);
        }
      }
      pointer = { x, y };
    },
    { passive: true },
  );

  window.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      const x = e.clientX / window.innerWidth;
      const y = 1 - e.clientY / window.innerHeight;
      advanceInk();
      // a splash: one heavy drop plus a radial crown
      splat(x, y, 0, 0, 0.75);
      const n = 8 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
        splat(
          x + Math.cos(a) * 0.015,
          y + Math.sin(a) * 0.015,
          Math.cos(a) * SPLAT_FORCE * 0.12,
          Math.sin(a) * SPLAT_FORCE * 0.12,
          0.1,
        );
      }
    },
    { passive: true },
  );

  /** Ambient droplets: the ink keeps moving under the glass on its own. */
  function ambient(): void {
    if (!document.hidden) {
      const x = 0.1 + Math.random() * 0.8;
      const y = 0.1 + Math.random() * 0.8;
      const a = Math.random() * Math.PI * 2;
      const f = SPLAT_FORCE * (0.05 + Math.random() * 0.1);
      if (Math.random() < 0.35) advanceInk();
      splat(x, y, Math.cos(a) * f, Math.sin(a) * f, 0.24 + Math.random() * 0.28);
    }
    setTimeout(ambient, 4500 + Math.random() * 5500);
  }

  /* ---------- boot ---------- */

  resizeCanvas();
  initTargets();
  window.addEventListener(
    "resize",
    () => {
      resizeCanvas();
      initTargets(); // fresh bath at the new size
    },
    { passive: true },
  );
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) wake();
  });
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    canvas.remove();
  });

  // opening pour: a few drops swirled along a diagonal, like fresh ink settling
  document.documentElement.style.setProperty("--live-ink", currentInk().css);
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const x = 0.62 + t * 0.28;
    const y = 0.75 - t * 0.45;
    const a = t * Math.PI * 1.6 + 0.4;
    if (i === 2) advanceInk();
    splat(x, y, Math.cos(a) * SPLAT_FORCE * 0.14, Math.sin(a) * SPLAT_FORCE * 0.14, 0.65);
  }
  splat(0.16, 0.2, SPLAT_FORCE * 0.06, -SPLAT_FORCE * 0.05, 0.45);

  setTimeout(ambient, 6000);
  wake();
}
