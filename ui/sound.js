// ui/sound.js — soft, modern UI sound engine (Web Audio API, synthesized).
//
// No audio files: every cue is generated procedurally so playback is instant
// (zero decode latency), CSP-safe, and stylistically consistent — one "soft
// sci-fi" theme. A DynamicsCompressor acts as a gentle limiter so overlaps never
// get harsh, and a master gain gives the global volume / mute control.
//
// Cues:   hover  — very short soft high tick
//         click  — soft tap (sine body + tiny filtered noise)
//         install — soft upward whoosh (filtered noise + sine swell)
//         success — pleasant major-chime arpeggio with a soft tail
//         error  — muted, low, slow detuned tone (never aggressive)
//         delete — downward fade-out (pitch drop + noise fade)
//
// UX guards (so it never irritates):
//   • AudioContext is created lazily on the first user gesture (autoplay policy)
//     and resumed on visibility regain.
//   • Hover is throttled globally (min interval), delayed per-element (30ms) and
//     cancelled if the pointer leaves before it fires, and suppressed entirely
//     while the mouse is moving fast across the UI.
//   • Everything routes through one limiter → no clipping, no sharp transients.
//
// Public API (window.sfx): apply, play, setEnabled, setVolume, get, bind, resume.

(function () {
  const SELECTOR = 'button, [data-action], .cat-btn, .set-btn, .bg-theme, .fav-btn, .ghost-btn, .card-remove, .ver-select, input[type="range"], .tab-btn, .nav-btn';

  const state = { enabled: true, volume: 0.7 };
  let ctx = null, master = null, bus = null, comp = null, noiseBuf = null;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    // bus → compressor (soft limiter) → master gain → destination
    bus = ctx.createGain(); bus.gain.value = 1.0;
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 14; comp.ratio.value = 3;
    comp.attack.value = 0.005; comp.release.value = 0.12;
    master = ctx.createGain(); master.gain.value = state.enabled ? state.volume : 0;
    bus.connect(comp); comp.connect(master); master.connect(ctx.destination);
    // Pre-bake ~1.5s of white noise for whoosh / click / delete transients.
    const len = Math.floor(ctx.sampleRate * 1.5);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }

  function resume() {
    if (!ctx) ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  function v() { return state.enabled ? state.volume : 0; }

  function noise(dur, when) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    // random offset for variety
    const off = Math.random() * Math.max(0, (noiseBuf.duration - dur));
    s.loop = false;
    s.start(when, off, dur);
    return s;
  }

  // ── Cues ──────────────────────────────────────────────────────────────────
  function hover() {
    const c = ensure(); if (!c) return;
    const t = c.currentTime, vol = v();
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(1520, t);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05 * vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g); g.connect(bus); o.start(t); o.stop(t + 0.06);
  }

  function click() {
    const c = ensure(); if (!c) return;
    const t = c.currentTime, vol = v();
    const o = c.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(440, t);
    o.frequency.exponentialRampToValueAtTime(300, t + 0.08);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16 * vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    const nf = c.createBiquadFilter(); nf.type = 'highpass'; nf.frequency.value = 1800;
    const ng = c.createGain(); ng.gain.setValueAtTime(0.07 * vol, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    o.connect(g); g.connect(bus); const n = noise(0.04, t); n.connect(nf); nf.connect(ng); ng.connect(bus);
    o.start(t); o.stop(t + 0.1);
  }

  function install() {
    const c = ensure(); if (!c) return;
    const t = c.currentTime, dur = 0.45, vol = v();
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.15 * vol, t + 0.05);
    g.gain.linearRampToValueAtTime(0.10 * vol, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(200, t);
    o.frequency.exponentialRampToValueAtTime(560, t + dur);
    const og = c.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(0.07 * vol, t + 0.06);
    og.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const n = noise(dur, t); n.connect(bp); bp.connect(g); g.connect(bus);
    o.connect(og); og.connect(bus);
    o.start(t); o.stop(t + dur);
  }

  function success() {
    const c = ensure(); if (!c) return;
    const t = c.currentTime, vol = v();
    const notes = [523.25, 659.25, 783.99]; // C5 E5 G5
    notes.forEach((f, i) => {
      const st = t + i * 0.07;
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = c.createGain();
      g.gain.setValueAtTime(0, st);
      g.gain.linearRampToValueAtTime(0.13 * vol, st + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.5);
      o.connect(g); g.connect(bus); o.start(st); o.stop(st + 0.55);
    });
    // soft tail shimmer
    const st = t + 0.2;
    const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = 1046.5;
    const g2 = c.createGain();
    g2.gain.setValueAtTime(0, st);
    g2.gain.linearRampToValueAtTime(0.06 * vol, st + 0.03);
    g2.gain.exponentialRampToValueAtTime(0.0001, st + 0.6);
    o2.connect(g2); g2.connect(bus); o2.start(st); o2.stop(st + 0.65);
  }

  function error() {
    const c = ensure(); if (!c) return;
    const t = c.currentTime, dur = 0.34, vol = v();
    [180, 190].forEach((f) => {
      const o = c.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(f, t);
      o.frequency.linearRampToValueAtTime(f * 0.78, t + dur);
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 620;
      const g = c.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.13 * vol, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(lp); lp.connect(g); g.connect(bus); o.start(t); o.stop(t + dur);
    });
  }

  function del() {
    const c = ensure(); if (!c) return;
    const t = c.currentTime, dur = 0.4, vol = v();
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(440, t);
    o.frequency.exponentialRampToValueAtTime(120, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.13 * vol, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const nf = c.createBiquadFilter(); nf.type = 'lowpass';
    nf.frequency.setValueAtTime(1200, t);
    nf.frequency.exponentialRampToValueAtTime(300, t + dur);
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.07 * vol, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const n = noise(dur, t);
    o.connect(g); g.connect(bus); n.connect(nf); nf.connect(ng); ng.connect(bus);
    o.start(t); o.stop(t + dur);
  }

  const CUES = { hover, click, install, success, error, delete: del };

  function play(name) {
    if (!state.enabled) return;
    const fn = CUES[name];
    if (!fn) return;
    try { fn(); } catch (_) {}
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  function apply(s) {
    if (!s) return;
    if (typeof s.enabled === 'boolean') state.enabled = s.enabled;
    if (typeof s.volume === 'number') state.volume = Math.max(0, Math.min(1, s.volume));
    if (master) master.gain.value = state.enabled ? state.volume : 0;
  }
  function setEnabled(on) { state.enabled = !!on; if (master) master.gain.value = state.enabled ? state.volume : 0; }
  function setVolume(vol) { state.volume = Math.max(0, Math.min(1, vol)); if (master && state.enabled) master.gain.value = state.volume; }
  function get() { return { enabled: state.enabled, volume: state.volume }; }

  // ── Global interaction wiring (delegated hover + click) ────────────────────
  // Hover is throttled, per-element delayed (30ms, cancelled on early leave),
  // and suppressed while the pointer moves fast — so quick sweeps stay silent.
  let lastHover = 0, lastMoveT = 0, lastMoveX = 0, lastMoveY = 0, fastUntil = 0;
  const HOVER_MIN_INTERVAL = 42;   // ms between hover ticks
  const HOVER_DELAY = 30;          // ms per-element delay
  const pending = new WeakMap();   // element -> timeout id

  function matchForHover(el) { return el && el.closest && el.closest(SELECTOR); }

  function onMove(e) {
    const now = performance.now();
    const dt = Math.max(1, now - lastMoveT);
    const dx = e.clientX - lastMoveX, dy = e.clientY - lastMoveY;
    const speed = Math.hypot(dx, dy) / dt; // px/ms
    if (speed > 2.2) fastUntil = now + 140;
    lastMoveT = now; lastMoveX = e.clientX; lastMoveY = e.clientY;
  }

  function onOver(e) {
    const target = matchForHover(e.target);
    if (!target) return;
    const id = setTimeout(() => {
      pending.delete(target);
      const now = performance.now();
      if (now < fastUntil) return;             // moving fast → skip
      if (now - lastHover < HOVER_MIN_INTERVAL) return; // throttled
      lastHover = now;
      resume(); play('hover');
    }, HOVER_DELAY);
    pending.set(target, id);
  }

  function onOut(e) {
    const target = matchForHover(e.target);
    if (!target) return;
    const id = pending.get(target);
    if (id) { clearTimeout(id); pending.delete(target); }
  }

  function onClick(e) {
    const target = matchForHover(e.target);
    if (!target) return;
    resume(); play('click');
  }

  function bind() {
    // Unlock audio on the first gesture (autoplay policy).
    const unlock = () => { ensure(); resume(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    document.addEventListener('click', onClick);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
  }

  window.sfx = {
    version: '1.0',
    apply, play, setEnabled, setVolume, get, bind, resume,
  };
})();