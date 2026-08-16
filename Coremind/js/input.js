/* Coremind — touch input: one-finger drag to pan, two-finger pinch to zoom,
 * tap to select/inspect. Pointer Events unify mouse and touch so the same
 * code path is what gets exercised on desktop during development.
 */
(function (CM) {
  'use strict';
  const K = CM.core;
  const R = CM.render;

  const TAP_MOVE_THRESHOLD = 9;   // px
  const TAP_MAX_DURATION = 400;   // ms
  const HIT_RADIUS_PX = 22;

  function zoomBy(game, factor) {
    const c = game.camera;
    c.targetZoom = K.clamp((c.targetZoom || c.zoom) * factor, R.ZOOM_MIN, R.ZOOM_MAX);
  }
  function focusCore(game) { R.focusOn(game, game.core.x, game.core.y, 12); }

  /* Hit radii are in canvas pixels, so the finger-sized slop has to be scaled
   * by dpr as well — 22 device pixels is 7 CSS pixels on a modern phone, which
   * is far smaller than a fingertip. */
  function slop(canvas) { return HIT_RADIUS_PX * (canvas.__dpr || 1); }

  function hitTestOrganism(game, canvas, screenX, screenY) {
    const dpr = canvas.__dpr || 1;
    let best = null, bestD = slop(canvas);
    for (const org of game.organisms) {
      const p = R.worldToScreen(game, canvas, org.x, org.y);
      const d = Math.hypot(p.x - screenX, p.y - screenY);
      const r = Math.max(10 * dpr, org.stats.size * 0.11 * game.camera.zoom * dpr * 1.9);
      if (d < r + 6 * dpr && d < bestD) { bestD = d; best = org; }
    }
    return best;
  }
  function hitTestSample(game, canvas, screenX, screenY) {
    let best = null, bestD = slop(canvas);
    for (const s of game.discovery.samples) {
      const p = R.worldToScreen(game, canvas, s.x, s.y);
      const d = Math.hypot(p.x - screenX, p.y - screenY);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /* Chambers are only tappable in the underground view. On the surface they
   * are markers over ground the player needs to be able to tap through — a
   * developed network would otherwise swallow every tap in its own territory. */
  function hitTestStructure(game, canvas, screenX, screenY) {
    if (!game.viewDepth) return null;
    const dpr = canvas.__dpr || 1;
    let best = null, bestD = Infinity;
    for (const s of CM.structures.all(game)) {
      if (s.depth !== game.viewDepth) continue;
      const p = R.worldToScreen(game, canvas, s.x, s.y);
      const d = Math.hypot(p.x - screenX, p.y - screenY);
      const r = Math.max(slop(canvas), CM.structures.TYPES[s.type].radius * game.camera.zoom * dpr * 0.62);
      if (d < r && d < bestD) { bestD = d; best = s; }
    }
    return best;
  }
  function hitTestCore(game, canvas, screenX, screenY) {
    const p = R.worldToScreen(game, canvas, game.core.x, game.core.y);
    const r = Math.max(18, game.core.radius * game.camera.zoom * (canvas.__dpr || 1));
    return Math.hypot(p.x - screenX, p.y - screenY) < r ? game.core : null;
  }

  function attach(canvas, game, handlers) {
    handlers = handlers || {};
    const pointers = new Map();
    let mode = null; // 'pan' | 'pinch'
    let panLast = null;
    let pinchStartDist = 0, pinchStartZoom = 0;
    let tapStart = null; // {x,y,t,id}

    function dpr() { return canvas.__dpr || (window.devicePixelRatio || 1); }
    function toCanvasPx(evt) {
      const rect = canvas.getBoundingClientRect();
      return { x: (evt.clientX - rect.left) * (canvas.width / rect.width), y: (evt.clientY - rect.top) * (canvas.height / rect.height) };
    }

    function onDown(evt) {
      canvas.setPointerCapture(evt.pointerId);
      const p = toCanvasPx(evt);
      pointers.set(evt.pointerId, p);
      if (pointers.size === 1) {
        mode = 'pan';
        panLast = p;
        tapStart = { x: p.x, y: p.y, t: performance.now(), id: evt.pointerId };
        game.camera.dragging = true;
      } else if (pointers.size === 2) {
        mode = 'pinch';
        tapStart = null;
        const pts = [...pointers.values()];
        pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        pinchStartZoom = game.camera.zoom;
      }
    }

    function onMove(evt) {
      if (!pointers.has(evt.pointerId)) return;
      const p = toCanvasPx(evt);
      pointers.set(evt.pointerId, p);

      if (mode === 'pan' && pointers.size === 1) {
        const dx = p.x - panLast.x, dy = p.y - panLast.y;
        panLast = p;
        const zoom = game.camera.zoom * dpr();
        game.camera.x -= dx / zoom;
        game.camera.y -= dy / zoom;
        game.camera.targetX = game.camera.x; game.camera.targetY = game.camera.y;
        R.clampCamera(game);
        if (tapStart && Math.hypot(p.x - tapStart.x, p.y - tapStart.y) > TAP_MOVE_THRESHOLD) tapStart = null;
      } else if (mode === 'pinch' && pointers.size === 2) {
        const pts = [...pointers.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        const z = K.clamp(pinchStartZoom * (dist / pinchStartDist), R.ZOOM_MIN, R.ZOOM_MAX);
        game.camera.zoom = z; game.camera.targetZoom = z;
      }
    }

    function onUp(evt) {
      const wasTap = tapStart && tapStart.id === evt.pointerId
        && (performance.now() - tapStart.t) < TAP_MAX_DURATION;
      pointers.delete(evt.pointerId);

      if (wasTap) handleTap(tapStart.x, tapStart.y);

      if (pointers.size === 0) {
        mode = null; game.camera.dragging = false; tapStart = null;
      } else if (pointers.size === 1) {
        mode = 'pan';
        panLast = [...pointers.values()][0];
        tapStart = null;
      }
    }

    function handleTap(x, y) {
      /* Build mode short-circuits every other hit test. Otherwise a tap
       * aimed at open ground that happens to land near an organism selects
       * it instead of siting the chamber, and the player is left tapping a
       * crowded area wondering why nothing is being built. While the banner
       * says "tap the ground", a tap has to mean exactly that. */
      if (game.buildMode) {
        handlers.onTapEmpty && handlers.onTapEmpty(R.screenToWorld(game, canvas, x, y));
        return;
      }
      const org = hitTestOrganism(game, canvas, x, y);
      if (org) { handlers.onSelectOrganism && handlers.onSelectOrganism(org); return; }
      const site = hitTestStructure(game, canvas, x, y);
      if (site) { handlers.onTapStructure && handlers.onTapStructure(site); return; }
      const sample = hitTestSample(game, canvas, x, y);
      if (sample) { handlers.onTapSample && handlers.onTapSample(sample); return; }
      const core = hitTestCore(game, canvas, x, y);
      if (core) { handlers.onTapCore && handlers.onTapCore(); return; }
      handlers.onTapEmpty && handlers.onTapEmpty(R.screenToWorld(game, canvas, x, y));
    }

    canvas.addEventListener('pointerdown', onDown, { passive: true });
    canvas.addEventListener('pointermove', onMove, { passive: true });
    canvas.addEventListener('pointerup', onUp, { passive: true });
    canvas.addEventListener('pointercancel', onUp, { passive: true });
    canvas.addEventListener('wheel', evt => {
      evt.preventDefault();
      zoomBy(game, evt.deltaY < 0 ? 1.12 : 0.89);
    }, { passive: false });
  }

  CM.input = { attach, zoomBy, focusCore, hitTestOrganism, hitTestSample, hitTestCore, hitTestStructure };
})(window.CM = window.CM || {});
