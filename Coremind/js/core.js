/* Coremind — shared helpers: RNG, noise, math, formatting, event bus.
 *
 * The world is regenerated from a seed (see world.js), so anything here that
 * touches world generation must be deterministic given the same seed.
 */
(function (CM) {
  'use strict';

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const clamp01 = v => clamp(v, 0, 1);
  const lerp = (a, b, t) => a + (b - a) * t;
  const invLerp = (a, b, v) => (b === a ? 0 : clamp01((v - a) / (b - a)));
  const rndInt = (rng, a, b) => Math.floor(a + rng() * (b - a + 1));
  const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
  const chance = (rng, p) => rng() < p;
  const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
  const dist = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));

  /* Angle helpers for steering. */
  function angDelta(a, b) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
  function turnToward(a, b, maxStep) {
    return a + clamp(angDelta(a, b), -maxStep, maxStep);
  }

  /* Seeded RNG (mulberry32). Every stream that must be reproducible from the
   * world seed uses one of these — never Math.random(). */
  function rngFrom(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hash2(seed, x, y) {
    let h = (seed * 374761393 + x * 668265263 + y * 2147483647) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /* Smooth value noise — good enough for biome blotches and temperature
   * fields, cheap enough to sample 65k times at world-gen. */
  function noise2(seed, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(seed, xi, yi), b = hash2(seed, xi + 1, yi);
    const c = hash2(seed, xi, yi + 1), d = hash2(seed, xi + 1, yi + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }

  function fbm(seed, x, y, octaves) {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let i = 0; i < (octaves || 4); i++) {
      sum += amp * noise2(seed + i * 7919, x * f, y * f);
      norm += amp;
      amp *= 0.52; f *= 2.1;
    }
    return sum / norm;
  }

  // --- formatting ----------------------------------------------------------
  function fmt(n) {
    n = Math.floor(n);
    if (Math.abs(n) < 1000) return String(n);
    if (Math.abs(n) < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'k';
    return (n / 1e6).toFixed(2).replace(/\.0+$/, '') + 'M';
  }
  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
    return m + ':' + String(s).padStart(2, '0');
  }

  // --- tiny pub/sub used to decouple simulation, discovery and UI ----------
  function makeBus() {
    const listeners = {};
    return {
      on(kind, fn) {
        (listeners[kind] || (listeners[kind] = [])).push(fn);
        return () => { const a = listeners[kind]; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
      },
      emit(kind, payload) {
        const a = listeners[kind];
        if (!a) return;
        for (let i = 0; i < a.length; i++) {
          try { a[i](payload); } catch (e) { console.error('[coremind] listener error for', kind, e); }
        }
      }
    };
  }

  /* Monotonically increasing ids, namespaced by prefix so debug output stays
   * readable ("org_42", "sample_7"). */
  function makeIdGen() {
    const counters = {};
    return prefix => {
      counters[prefix] = (counters[prefix] || 0) + 1;
      return prefix + '_' + counters[prefix];
    };
  }

  CM.core = {
    clamp, clamp01, lerp, invLerp, rndInt, pick, chance, dist, dist2,
    angDelta, turnToward, rngFrom, hash2, noise2, fbm,
    fmt, fmtClock, makeBus, makeIdGen
  };
})(window.CM = window.CM || {});
