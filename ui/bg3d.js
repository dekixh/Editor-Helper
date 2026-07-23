// ui/bg3d.js — premium WebGL2 cosmic background (Apple / Arc / ChatGPT tier).
//
// A dark, minimal, depth-driven particle field rendered in a small GPU pipeline:
//   1. GRADIENT   fullscreen pass — black → deep blue → faint purple, soft broad
//                 center glow + a mild center darken (seats UI content) + vignette.
//   2. STARS      single gl.POINTS pass into an HDR FBO — three depth layers:
//                    far  : almost static, dim, tiny, minimal parallax
//                    mid  : slow drift, medium
//                    near : cursor-reactive (parallax + gentle repulsion), accent
//                 Each particle is a soft plasma core (radial glow + bright core,
//                 no white blowout), "breathing" twinkle, value-noise micro-drift,
//                 distance fog + DOF softness. Cold-blue palette with soft purple.
//   3. BLOOM      star FBO → half-res bright pass → separable Gaussian blur
//                 (ping-pong, 2 iterations) → soft additive composite. Cheap.
//
// Everything is deltaTime-driven and eased (mouse target → current via a
// frame-rate-independent lerp). The star buffer is static — zero per-frame JS
// uploads. Falls back to a single direct pass (in-shader glow, no FBO bloom) if
// float framebuffers are unavailable, and to the CSS gradient if WebGL2 is gone.
//
// Public API (unchanged): window.bg { apply, setTheme, setSpeed, setStarCount,
// setMouseIntensity, get, pause, resume }.

(function () {
  const canvas = document.getElementById('bg3d');
  if (!canvas) return;
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ──────────────────────────────────────────────────────────────────────────
  // 0. Theme palettes — two backgrounds: pure black, and a lifted dark charcoal.
  // ──────────────────────────────────────────────────────────────────────────
  const THEMES = {
    black: {
      // Pure black background, bright white stars.
      top: [0.0, 0.0, 0.0], mid: [0.0, 0.0, 0.0], bottom: [0.0, 0.0, 0.0],
      glow: [0.0, 0.0, 0.0],
      colNear: [1.0, 1.0, 1.0],
      colFar:  [0.58, 0.62, 0.70],
      colPurple: [1.0, 1.0, 1.0],
    },
    dark: {
      // Dark charcoal background (slightly lifted from pure black) with a faint
      // center glow and slightly softer stars.
      top: [0.05, 0.05, 0.058], mid: [0.04, 0.04, 0.048], bottom: [0.03, 0.03, 0.038],
      glow: [0.03, 0.03, 0.04],
      colNear: [0.90, 0.91, 0.95],
      colFar:  [0.50, 0.52, 0.57],
      colPurple: [0.94, 0.94, 0.98],
    },
  };

  // ──────────────────────────────────────────────────────────────────────────
  // 1. INIT — WebGL2 context, shader helpers, programs
  // ──────────────────────────────────────────────────────────────────────────
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false });
  if (!gl) { /* graceful: leave the CSS gradient on .bg */ return; }

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[bg3d] shader error:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }
  function program(vsSrc, fsSrc) {
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('[bg3d] link error:', gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  }

  // Shared fullscreen triangle (covers clip space) — used by every fullscreen pass.
  const quadVAO = gl.createVertexArray();
  const quadBuf = gl.createBuffer();
  gl.bindVertexArray(quadVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // --- Gradient pass ---
  const GRAD_VS = `#version 300 es
  layout(location=0) in vec2 aPos; out vec2 vUv;
  void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const GRAD_FS = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform vec3 uTop, uMid, uBottom, uGlow; uniform float uAspect;
  void main(){
    float t = vUv.y;
    vec3 col = mix(uBottom, uMid, smoothstep(0.0, 0.5, t));
    col = mix(col, uTop, smoothstep(0.5, 1.0, t));
    vec2 c = vUv - 0.5; c.x *= uAspect;
    float r2 = dot(c, c);
    // Edge vignette (subtle) + a broad soft center glow + a mild center darken
    // so UI content seated in the middle reads cleanly.
    col *= clamp(1.0 - r2 * 0.45, 0.46, 1.0);
    col += uGlow * exp(-r2 * 2.2);
    col *= 1.0 - exp(-r2 * 1.3) * 0.12;
    o = vec4(col, 1.0);
  }`;
  const gradProg = program(GRAD_VS, GRAD_FS);

  // --- Star points pass ---
  // aPos is a screen-space fraction in [-MARGIN, MARGIN]; the vertex shader scales
  // it by (uFar/depth) so the field fills the viewport at every depth and particles
  // stream outward as they approach the camera → a filled 3D volume, not a line.
  const STAR_VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec2 aPos;      // screen fraction in [-MARGIN, MARGIN]
  layout(location=1) in float aZ0;      // base depth offset
  layout(location=2) in float aSize;    // base point size
  layout(location=3) in float aBright;  // base brightness 0..1
  layout(location=4) in float aTwPhase; // twinkle phase
  layout(location=5) in float aTwSpeed; // breathe speed (0 = steady)
  layout(location=6) in float aLayer;   // 0 far, 1 mid, 2 near
  layout(location=7) in float aHue;     // 0..1 color variety

  uniform float uTime, uSpeed, uNear, uRange, uFar, uAspect;
  uniform vec2  uMouse;            // smoothed mouse, -1..1 (NDC, Y already flipped)
  uniform float uMouseInt;         // mouse intensity 0..2
  uniform float uSizeScale, uPixelRatio, uFogDensity;

  out float vBright, vSoft, vDepthN;
  out vec3  vTintMix;
  out float vHue;

  // Cheap value noise for gentle, non-chaotic micro-drift ("плавание").
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main(){
    float layer = aLayer;
    // Per-layer flight speed: far ≈ static, mid slow, near faster.
    float sp = uSpeed * (layer < 0.5 ? 0.04 : layer < 1.5 ? 0.45 : 1.05);
    float z = mod(aZ0 + uTime * sp, uRange);
    float depth = z + uNear;
    float depthF = 1.0 - z / uRange;     // 1 near → 0 far
    float stream = uFar / depth;

    // Micro-drift via smooth noise — amplitude grows for nearer layers.
    float driftAmp = (layer < 0.5 ? 0.004 : layer < 1.5 ? 0.012 : 0.026);
    vec2 n = vec2(noise(aPos * 1.7 + uTime * 0.030), noise(aPos * 1.7 - uTime * 0.027)) - 0.5;
    vec2 pos = aPos + n * driftAmp;

    // Perspective projection (aspect in-shader → resize never distorts).
    vec2 ndc = vec2(pos.x * stream / uAspect, pos.y * stream);

    // Depth parallax — nearer layers react more to the cursor.
    float par = (layer < 0.5 ? 0.020 : layer < 1.5 ? 0.050 : 0.105);
    ndc += uMouse * uMouseInt * par;

    // Gentle cursor repulsion — near (and a touch of mid) particles ease away.
    float rep = (layer > 1.5 ? 0.090 : layer > 0.5 ? 0.025 : 0.0) * uMouseInt;
    if (rep > 0.0) {
      vec2 d = ndc - uMouse;
      float dist2 = dot(d, d);
      float push = rep / (dist2 * 4.5 + 1.0);
      ndc += d * push;
    }
    gl_Position = vec4(ndc, 0.0, 1.0);

    float psize = aSize * stream * uSizeScale * uPixelRatio * (0.55 + 0.45 * depthF);
    gl_PointSize = clamp(psize, 1.0, 72.0);

    // "Breathing light" — slow, low-amplitude, never blinking.
    float tw = 1.0;
    if (aTwSpeed > 0.001) tw = 0.80 + 0.20 * sin(uTime * aTwSpeed + aTwPhase);

    // Seamless recycle fade + distance fog (far particles dim into the gradient).
    float fade = smoothstep(0.0, 0.12, depthF) * smoothstep(1.0, 0.86, depthF);
    float fog = exp(-(1.0 - depthF) * uFogDensity);
    vBright = aBright * tw * (0.30 + 0.70 * depthF) * fade * fog;
    vSoft = mix(0.55, 1.8, 1.0 - depthF);   // far softer → fake DOF
    vDepthN = depthF;
    vTintMix = vec3(depthF, layer * 0.5, 0.0);
    vHue = aHue;
  }`;
  const STAR_FS = `#version 300 es
  precision highp float;
  in float vBright, vSoft, vDepthN; in vec3 vTintMix; in float vHue;
  out vec4 o;
  uniform vec3 uColNear, uColFar, uColPurple;
  void main(){
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p) * 2.0;                 // 0 center → 1 edge
    float glow = exp(-d * d * 3.0 / (vSoft * vSoft));   // soft plasma halo
    float core = smoothstep(1.0, 0.0, d * 2.6);          // bright core
    float a = (glow * 0.55 + core * 0.40) * vBright;
    if (a < 0.003) discard;
    // Cold-blue base mixed by depth, with a soft-purple variety by hue.
    vec3 col = mix(uColFar, uColNear, vDepthN);
    col = mix(col, uColPurple, vHue * 0.40);
    col = mix(col, vec3(1.0), core * 0.18);   // gentle hot core — no white blowout
    o = vec4(col * a, a);                      // premultiplied → additive via ONE,ONE
  }`;
  const starProg = program(STAR_VS, STAR_FS);

  // --- Blur pass (separable Gaussian, 9-tap) ---
  const BLUR_FS = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform sampler2D uTex; uniform vec2 uStep;
  void main(){
    vec3 sum = texture(uTex, vUv).rgb * 0.227027;
    sum += texture(uTex, vUv + uStep * 1.0).rgb * 0.1945946;
    sum += texture(uTex, vUv - uStep * 1.0).rgb * 0.1945946;
    sum += texture(uTex, vUv + uStep * 2.0).rgb * 0.1216216;
    sum += texture(uTex, vUv - uStep * 2.0).rgb * 0.1216216;
    sum += texture(uTex, vUv + uStep * 3.0).rgb * 0.054054;
    sum += texture(uTex, vUv - uStep * 3.0).rgb * 0.054054;
    sum += texture(uTex, vUv + uStep * 4.0).rgb * 0.016216;
    sum += texture(uTex, vUv - uStep * 4.0).rgb * 0.016216;
    o = vec4(sum, 1.0);
  }`;
  const blurProg = program(GRAD_VS, BLUR_FS);

  // --- Composite pass (additive texture blit) ---
  const COMP_FS = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform sampler2D uTex; uniform float uIntensity;
  void main(){
    vec3 c = texture(uTex, vUv).rgb;
    o = vec4(c * uIntensity, 1.0);
  }`;
  const compProg = program(GRAD_VS, COMP_FS);

  if (!gradProg || !starProg) return; // shaders failed → leave CSS gradient

  // Bloom available only if we can render + blur offscreen. The blur/composite
  // programs are optional; if they failed we keep the direct-render fallback.
  const bloomOK = !!(blurProg && compProg);

  // Uniform locations (cached once).
  const GU = {};
  ['uTop', 'uMid', 'uBottom', 'uGlow', 'uAspect'].forEach((n) => GU[n] = gl.getUniformLocation(gradProg, n));
  const U = {};
  ['uTime', 'uSpeed', 'uNear', 'uRange', 'uFar', 'uAspect', 'uMouse', 'uMouseInt',
   'uSizeScale', 'uPixelRatio', 'uFogDensity', 'uColNear', 'uColFar', 'uColPurple'].forEach((n) => U[n] = gl.getUniformLocation(starProg, n));
  const blurU = blurProg ? { uTex: gl.getUniformLocation(blurProg, 'uTex'), uStep: gl.getUniformLocation(blurProg, 'uStep') } : null;
  const compU = compProg ? { uTex: gl.getUniformLocation(compProg, 'uTex'), uIntensity: gl.getUniformLocation(compProg, 'uIntensity') } : null;

  // ──────────────────────────────────────────────────────────────────────────
  // 2. PARTICLES — generate the (static) star buffer
  // ──────────────────────────────────────────────────────────────────────────
  // Interleaved per star: [x, y, z0, size, bright, twPhase, twSpeed, layer, hue] (9 f).
  // Three depth layers: far (~70%, almost static), mid (~22%, slow drift),
  // near (~8%, accent — cursor-reactive). 90% small / 10% accent by size.
  const STRIDE = 9;
  const MARGIN = 1.18;
  const NEAR = 0.5, RANGE = 14.0, FAR = NEAR + RANGE;

  let starVAO = null, starBuf = null, starCount = 0;
  function buildStars(n) {
    const data = new Float32Array(n * STRIDE);
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      // Layer assignment — most stars are distant → premium, minimal, calm.
      const lr = Math.random();
      const layer = lr < 0.70 ? 0 : lr < 0.92 ? 1 : 2;
      // Depth banding per layer (far stays far, near stays near).
      let z0;
      if (layer === 0) z0 = RANGE * 0.55 + Math.random() * RANGE * 0.45;
      else if (layer === 1) z0 = RANGE * 0.20 + Math.random() * RANGE * 0.55;
      else z0 = Math.random() * RANGE * 0.45;

      data[o] = (Math.random() * 2 - 1) * MARGIN;
      data[o + 1] = (Math.random() * 2 - 1) * MARGIN;
      data[o + 2] = z0;

      // Size: 90% small, 10% accent (the near layer carries the accent weight).
      const accent = Math.random() < 0.10 || layer === 2;
      data[o + 3] = accent ? 2.2 + Math.random() * 2.2 : 0.7 + Math.random() * 0.9;
      // Brightness by layer — far dim, near brighter.
      data[o + 4] = layer === 0 ? 0.42 + Math.random() * 0.25
                  : layer === 1 ? 0.55 + Math.random() * 0.30
                                : 0.72 + Math.random() * 0.30;
      data[o + 5] = Math.random() * Math.PI * 2;                 // twinkle phase
      data[o + 6] = Math.random() < 0.65 ? 0.25 + Math.random() * 0.55 : 0.0; // slow breathe
      data[o + 7] = layer;                                        // layer
      data[o + 8] = Math.random();                                // hue variety
    }
    if (!starVAO) { starVAO = gl.createVertexArray(); starBuf = gl.createBuffer(); }
    gl.bindVertexArray(starVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, starBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE * 4, 0);
    // aPos is a vec2 (2 floats), so scalar attributes start at float index 2 →
    // byte offset for location L (L≥1) is (L + 1) * 4.
    for (let a = 1; a <= 7; a++) {
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 1, gl.FLOAT, false, STRIDE * 4, (a + 1) * 4);
    }
    starCount = n;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Framebuffers for the bloom pipeline (rebuilt on resize).
  // ──────────────────────────────────────────────────────────────────────────
  const floatExt = gl.getExtension('EXT_color_buffer_float');
  const STAR_FMT = floatExt ? [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT] : [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE];

  function createFBO(w, h, internalFmt, fmt, type) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFmt, w, h, 0, fmt, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    return { fbo, tex, w, h, ok };
  }

  let starFBO = null, bloomA = null, bloomB = null, bloomReady = false;
  function rebuildFBOs() {
    const fw = Math.max(1, canvas.width), fh = Math.max(1, canvas.height);
    const bw = Math.max(1, Math.floor(fw / 2)), bh = Math.max(1, Math.floor(fh / 2));
    // Star FBO: prefer half-float to avoid clipping on additive overlap.
    let sf = createFBO(fw, fh, STAR_FMT[0], STAR_FMT[1], STAR_FMT[2]);
    if (!sf.ok && STAR_FMT[0] !== gl.RGBA8) sf = createFBO(fw, fh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    const ba = createFBO(bw, bh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    const bb = createFBO(bw, bh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    starFBO = sf; bloomA = ba; bloomB = bb;
    bloomReady = bloomOK && sf.ok && ba.ok && bb.ok;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3 + 4. State, sizing, mouse, animation loop
  // ──────────────────────────────────────────────────────────────────────────
  let W = 0, H = 0, DPR = 1, aspect = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.max(1, Math.floor(W * DPR));
    canvas.height = Math.max(1, Math.floor(H * DPR));
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    aspect = W / Math.max(1, H);
    gl.viewport(0, 0, canvas.width, canvas.height);
    rebuildFBOs();
  }
  window.addEventListener('resize', resize, { passive: true });
  resize();

  // Mouse — target → current via a frame-rate-independent lerp (eased, no snaps).
  let mx = 0, my = 0, cmx = 0, cmy = 0;
  window.addEventListener('mousemove', (e) => {
    mx = (e.clientX / W) * 2 - 1;
    my = (e.clientY / H) * 2 - 1;
  }, { passive: true });

  const cfg = { theme: 'black', speed: 1.0, starCount: 1600, mouseIntensity: 1.0 };
  function applyTheme(name) {
    const t = THEMES[name] || THEMES.black;
    cfg.theme = name;
    curTheme = t;
  }
  let curTheme = THEMES.black;

  let raf = 0, last = 0, running = false, t = 0;

  // --- fullscreen pass helpers ---
  function blurPass(srcTex, dst, stepX, stepY) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.disable(gl.BLEND);
    gl.useProgram(blurProg);
    gl.bindVertexArray(quadVAO);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(blurU.uTex, 0);
    gl.uniform2f(blurU.uStep, stepX, stepY);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function composite(tex, intensity) {
    gl.useProgram(compProg);
    gl.bindVertexArray(quadVAO);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(compU.uTex, 0);
    gl.uniform1f(compU.uIntensity, intensity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function uploadStarUniforms() {
    gl.uniform1f(U.uTime, t * 0.001);
    gl.uniform1f(U.uSpeed, cfg.speed);
    gl.uniform1f(U.uNear, NEAR);
    gl.uniform1f(U.uRange, RANGE);
    gl.uniform1f(U.uFar, FAR);
    gl.uniform1f(U.uAspect, aspect);
    gl.uniform1f(U.uMouseInt, cfg.mouseIntensity);
    gl.uniform1f(U.uSizeScale, 2.7);
    gl.uniform1f(U.uPixelRatio, DPR);
    gl.uniform1f(U.uFogDensity, 0.95);
    gl.uniform3fv(U.uColNear, curTheme.colNear);
    gl.uniform3fv(U.uColFar, curTheme.colFar);
    gl.uniform3fv(U.uColPurple, curTheme.colPurple);
  }

  function render(now) {
    if (!running) return;
    const dt = Math.min(50, now - last) || 16;
    last = now;
    t += dt;

    // Eased mouse (frame-rate-independent lerp — converges over ~1s).
    const ease = 1 - Math.pow(0.001, dt / 1000);
    cmx += (mx - cmx) * ease;
    cmy += (my - cmy) * ease;
    // GL Y is up; screen Y is down → flip into NDC for the shader.
    const mY = -cmy;

    gl.bindVertexArray(quadVAO);

    // 1) Gradient → screen.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.useProgram(gradProg);
    gl.uniform3fv(GU.uTop, curTheme.top);
    gl.uniform3fv(GU.uMid, curTheme.mid);
    gl.uniform3fv(GU.uBottom, curTheme.bottom);
    gl.uniform3fv(GU.uGlow, curTheme.glow);
    gl.uniform1f(GU.uAspect, aspect);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Stars are drawn additively (premultiplied output → ONE, ONE blending).
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(starProg);
    gl.bindVertexArray(starVAO);
    uploadStarUniforms();
    // uMouse expects NDC with Y up (screen Y is down → flip).
    gl.uniform2f(U.uMouse, cmx, mY);

    if (bloomReady) {
      // 2) Stars → starFBO (HDR).
      gl.bindFramebuffer(gl.FRAMEBUFFER, starFBO.fbo);
      gl.viewport(0, 0, starFBO.w, starFBO.h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.POINTS, 0, starCount);

      // 3) Downsample + H blur: starFBO → bloomA.
      blurPass(starFBO.tex, bloomA, 1 / starFBO.w, 0);
      // 4) V: bloomA → bloomB.  5) H: bloomB → bloomA.  6) V: bloomA → bloomB.
      blurPass(bloomA.tex, bloomB, 0, 1 / bloomA.h);
      blurPass(bloomB.tex, bloomA, 1 / bloomB.w, 0);
      blurPass(bloomA.tex, bloomB, 0, 1 / bloomA.h);

      // 7) Composite crisp stars → screen (additive).
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      composite(starFBO.tex, 1.0);
      // 8) Composite soft bloom → screen (additive, toned down).
      composite(bloomB.tex, 0.8);
    } else {
      // Fallback: draw stars directly to screen (in-shader glow acts as bloom).
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.POINTS, 0, starCount);
    }

    raf = requestAnimationFrame(render);
  }

  function start() { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(render); }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); }

  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. SETTINGS API — window.bg
  // ──────────────────────────────────────────────────────────────────────────
  window.bg = {
    version: '2.0-premium',
    apply(s) {
      if (!s) return;
      if (THEMES[s.theme]) applyTheme(s.theme);
      if (typeof s.speed === 'number') cfg.speed = s.speed;
      if (typeof s.mouseIntensity === 'number') cfg.mouseIntensity = s.mouseIntensity;
      if (typeof s.starCount === 'number') {
        const n = Math.max(50, Math.min(3000, Math.round(s.starCount)));
        cfg.starCount = n;
        if (n !== starCount) buildStars(n);
      }
    },
    setTheme(name) { if (THEMES[name]) applyTheme(name); },
    setSpeed(v) { cfg.speed = v; },
    setMouseIntensity(v) { cfg.mouseIntensity = v; },
    setStarCount(n) { n = Math.max(50, Math.min(3000, Math.round(n))); cfg.starCount = n; if (n !== starCount) buildStars(n); },
    get() { return Object.assign({}, cfg); },
    pause: stop, resume: start,
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Boot
  // ──────────────────────────────────────────────────────────────────────────
  buildStars(cfg.starCount);
  if (REDUCED_MOTION) {
    running = true; render(performance.now()); running = false;
  } else {
    start();
  }

  // Re-init on context loss (GPU reset / sleep).
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); }, false);
  canvas.addEventListener('webglcontextrestored', () => { buildStars(cfg.starCount); rebuildFBOs(); start(); }, false);
})();