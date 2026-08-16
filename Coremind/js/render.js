/* Coremind — camera + rendering. Terrain is baked once into an offscreen
 * canvas (1 pixel per world cell) and blitted with a single drawImage per
 * frame regardless of zoom level; only organisms/samples/Core are drawn as
 * individual shapes, and only the ones inside the viewport (+ a margin).
 */
(function (CM) {
  'use strict';
  const K = CM.core;
  const W = CM.world;
  const T = CM.traits;

  const ZOOM_MIN = 5, ZOOM_MAX = 46;
  const CAM_EASE = 6.5; // per-second convergence rate toward the camera target

  /* The terrain is baked once into a 1px-per-cell offscreen canvas and blitted
   * with a single drawImage per frame at any zoom. Shading is done here, at
   * bake time, so the per-frame cost stays one blit no matter how much detail
   * the map gains. */
  function buildTerrainCache(world) {
    const size = world.size;
    const canvas = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(size, size)
      : Object.assign(document.createElement('canvas'), { width: size, height: size });
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const data = img.data;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const p = i * 4;
        const b = world.biome[i];
        const info = W.BIOME_INFO[b];
        let r = info.color[0], g = info.color[1], bl = info.color[2];

        // Vegetated ground darkens and yellows as it is grazed down, so the
        // food web is legible in the terrain itself rather than only in a
        // population graph.
        const cap = world.foodCap[i];
        if (cap > 0) {
          const lush = K.clamp01(world.food[i] / cap);
          const bare = [118, 98, 62];
          r = K.lerp(bare[0], r, 0.35 + lush * 0.65);
          g = K.lerp(bare[1], g, 0.35 + lush * 0.65);
          bl = K.lerp(bare[2], bl, 0.35 + lush * 0.65);
        }

        // Relief: light from the north-west, using the elevation gradient.
        // Cheap, and it is what stops a 14-colour map from reading flat.
        if (!info.water) {
          const eL = world.elevation[y * size + Math.max(0, x - 1)];
          const eU = world.elevation[Math.max(0, y - 1) * size + x];
          const e = world.elevation[i];
          const slope = ((e - eL) + (e - eU)) * 0.5;
          const shade = K.clamp(1 + slope * 6.5, 0.72, 1.32);
          r *= shade; g *= shade; bl *= shade;
        } else {
          // Depth shading for water.
          const depth = K.clamp01((0.305 - world.elevation[i]) / 0.3);
          r *= 1 - depth * 0.45; g *= 1 - depth * 0.4; bl *= 1 - depth * 0.2;
        }

        const hz = world.hazard[i];
        if (hz) {
          const hc = W.HAZARD_INFO[hz].color;
          r = K.lerp(r, hc[0], 0.35); g = K.lerp(g, hc[1], 0.35); bl = K.lerp(bl, hc[2], 0.35);
        }

        data[p] = K.clamp(r, 0, 255) | 0;
        data[p + 1] = K.clamp(g, 0, 255) | 0;
        data[p + 2] = K.clamp(bl, 0, 255) | 0;
        data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* Rebaked periodically as well as on world change, because the vegetation
   * shading above is a snapshot of a field that keeps moving — grazing,
   * regrowth and drought all change it. Every ~12s of simulation is often
   * enough to read as alive without paying 65k pixels every frame. */
  const TERRAIN_REFRESH = 12;
  function ensureCache(game) {
    if (!game.render) game.render = {};
    const r = game.render;
    if (!r.terrainCanvas || r.terrainSeed !== game.seed) {
      r.terrainCanvas = buildTerrainCache(game.world);
      r.terrainSeed = game.seed;
      r.terrainBakedAt = game.simTime;
    } else if (game.simTime - r.terrainBakedAt > TERRAIN_REFRESH) {
      r.terrainCanvas = buildTerrainCache(game.world);
      r.terrainBakedAt = game.simTime;
    }
    return r.terrainCanvas;
  }

  /* --- the underground view -------------------------------------------------
   * A separate way of looking at the world: instead of the surface map, the
   * rock of one stratum, with the colony's excavations cut through it. Baked
   * exactly like the terrain — one canvas per depth, one blit per frame — so
   * looking underground costs no more than looking at the surface.
   *
   * The rock is banded horizontally rather than blotched, because strata are
   * what makes a cross-section read as *rock* rather than as a differently
   * coloured map. */
  function buildRockCache(world, depth) {
    const info = CM.structures.DEPTHS[depth];
    const size = world.size;
    const canvas = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(size, size)
      : Object.assign(document.createElement('canvas'), { width: size, height: size });
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const seed = 90210 + depth * 1777;

    for (let y = 0; y < size; y++) {
      // Sedimentary banding: a low-frequency vertical ramp warped by noise so
      // the bands buckle instead of running dead straight.
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const p = i * 4;
        const warp = K.fbm(seed, x * 0.035, y * 0.035, 3);
        const band = Math.sin((y * 0.42) + warp * 5.5);
        const grain = K.fbm(seed + 31, x * 0.16, y * 0.16, 4);
        const shade = 0.74 + band * 0.09 + grain * 0.3;
        // Deeper rock also carries heat: veins of warmth bleed through the
        // abyssal layer, which is why it is worth cutting a geothermal tap.
        const heat = depth >= 3 ? Math.max(0, K.fbm(seed + 77, x * 0.05, y * 0.05, 3) - 0.62) * 3.4 : 0;
        data[p]     = K.clamp(info.rock[0] * shade + heat * 90, 0, 255) | 0;
        data[p + 1] = K.clamp(info.rock[1] * shade + heat * 26, 0, 255) | 0;
        data[p + 2] = K.clamp(info.rock[2] * shade + heat * 18, 0, 255) | 0;
        data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function ensureRockCache(game, depth) {
    if (!game.render) game.render = {};
    const r = game.render;
    if (!r.rock || r.rockSeed !== game.seed) { r.rock = {}; r.rockSeed = game.seed; }
    if (!r.rock[depth]) r.rock[depth] = buildRockCache(game.world, depth);
    return r.rock[depth];
  }

  function resizeCanvas(canvas) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    return dpr;
  }

  function clampCamera(game) {
    const c = game.camera, size = game.world.size;
    c.x = K.clamp(c.x, 0, size);
    c.y = K.clamp(c.y, 0, size);
    c.zoom = K.clamp(c.zoom, ZOOM_MIN, ZOOM_MAX);
    if (c.targetZoom != null) c.targetZoom = K.clamp(c.targetZoom, ZOOM_MIN, ZOOM_MAX);
  }

  function focusOn(game, x, y, zoom) {
    const c = game.camera;
    c.targetX = x; c.targetY = y;
    if (zoom != null) c.targetZoom = zoom;
  }

  function updateCamera(game, dt) {
    const c = game.camera;
    if (c.targetX == null) { c.targetX = c.x; c.targetY = c.y; c.targetZoom = c.zoom; }
    if (!c.dragging) {
      const t = 1 - Math.exp(-CAM_EASE * dt);
      c.x = K.lerp(c.x, c.targetX, t);
      c.y = K.lerp(c.y, c.targetY, t);
      c.zoom = K.lerp(c.zoom, c.targetZoom, t);
    }
    clampCamera(game);
  }

  /* Both of these work in *canvas* pixels, which is what the input layer
   * produces and what draw() renders in. The dpr factor is not optional: the
   * frame is drawn at camera.zoom * dpr, so leaving it out here made every
   * hit test progressively wronger the further the tap was from the centre of
   * the screen — invisible at dpr 1 on a desktop, and a miss of most of a
   * phone's width at dpr 3, which is the only device this game is for. */
  function worldToScreen(game, canvas, wx, wy) {
    const c = game.camera;
    const zoom = c.zoom * (canvas.__dpr || 1);
    return {
      x: (wx - c.x) * zoom + canvas.width / 2,
      y: (wy - c.y) * zoom + canvas.height / 2
    };
  }
  function screenToWorld(game, canvas, sx, sy) {
    const c = game.camera;
    const zoom = c.zoom * (canvas.__dpr || 1);
    return {
      x: (sx - canvas.width / 2) / zoom + c.x,
      y: (sy - canvas.height / 2) / zoom + c.y
    };
  }

  // -- organism drawing -------------------------------------------------------
  function drawOrganism(ctx, org, sx, sy, zoom, alpha) {
    const size = Math.max(1.5, org.stats.size * 0.075) * zoom;
    const mods = new Set(org.traits.map(id => (T.TRAITS_BY_ID[id] || {}).visual_modifier).filter(Boolean));
    const stretch = mods.has('streamlined') ? 1.5 : mods.has('lean') ? 1.25 : 1;

    // A burrowed organism is drawn as the mound it left behind — it has to be
    // visibly *gone* rather than merely faded, because "the predator can no
    // longer see it" is the entire mechanic.
    if (org.burrowed) {
      ctx.save();
      ctx.fillStyle = 'rgba(74,56,38,.85)';
      ctx.beginPath();
      ctx.ellipse(sx, sy, size * 1.15, size * 0.6, 0, Math.PI, 0);
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,14,8,.5)'; ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(org.heading);

    // camouflage: render translucent to hint that predators struggle to spot it
    if (mods.has('mottled')) ctx.globalAlpha = 0.62;

    // legs / digger limbs, drawn under the body
    if (mods.has('legs') || mods.has('digger')) {
      ctx.strokeStyle = 'rgba(0,0,0,.35)';
      ctx.lineWidth = Math.max(1, size * 0.12);
      const n = mods.has('digger') ? 3 : 2;
      for (let i = 0; i < n; i++) {
        const t = (i / (n - 1 || 1) - 0.5) * size * 1.6;
        ctx.beginPath(); ctx.moveTo(t, size * 0.55); ctx.lineTo(t * 0.7, size * 1.05); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(t, -size * 0.55); ctx.lineTo(t * 0.7, -size * 1.05); ctx.stroke();
      }
    }

    // body
    let bodyColor = org.color;
    if (mods.has('warm_hued')) bodyColor = tint(bodyColor, [40, 10, -10]);
    if (mods.has('cool_hued')) bodyColor = tint(bodyColor, [-15, 5, 35]);
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.ellipse(0, 0, size * stretch, size * 0.72, 0, 0, Math.PI * 2);
    ctx.fill();

    if (mods.has('shell')) {
      ctx.strokeStyle = 'rgba(20,20,20,.55)';
      ctx.lineWidth = Math.max(1.2, size * 0.22);
      ctx.beginPath(); ctx.ellipse(0, 0, size * stretch * 0.86, size * 0.56, 0, 0, Math.PI * 2); ctx.stroke();
    }
    if (mods.has('veined')) {
      ctx.strokeStyle = 'rgba(255,90,90,.5)';
      ctx.lineWidth = Math.max(0.6, size * 0.08);
      ctx.beginPath(); ctx.moveTo(-size * 0.4, 0); ctx.lineTo(size * 0.4, 0); ctx.stroke();
    }

    // head features (front = +x local, since heading rotates toward travel dir)
    if (mods.has('jaws') || mods.has('claws')) {
      ctx.fillStyle = 'rgba(30,20,20,.85)';
      ctx.beginPath();
      ctx.moveTo(size * stretch * 0.85, -size * 0.22);
      ctx.lineTo(size * stretch * 1.35, 0);
      ctx.lineTo(size * stretch * 0.85, size * 0.22);
      ctx.closePath(); ctx.fill();
    }
    if (mods.has('eyes')) {
      ctx.fillStyle = '#111';
      ctx.beginPath(); ctx.arc(size * stretch * 0.55, -size * 0.28, size * 0.15, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(size * stretch * 0.55, size * 0.28, size * 0.15, 0, Math.PI * 2); ctx.fill();
    }
    if (mods.has('antennae')) {
      ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = Math.max(0.6, size * 0.08);
      ctx.beginPath(); ctx.moveTo(size * stretch * 0.6, -size * 0.1); ctx.lineTo(size * stretch * 1.3, -size * 0.55); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(size * stretch * 0.6, size * 0.1); ctx.lineTo(size * stretch * 1.3, size * 0.55); ctx.stroke();
    }
    if (mods.has('whiskers')) {
      ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = Math.max(0.5, size * 0.06);
      for (const s of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(0, s * size * 0.6); ctx.lineTo(-size * 0.6, s * size * 1.0); ctx.stroke();
      }
    }
    if (mods.has('venom_glands')) {
      ctx.fillStyle = '#8a3fd1';
      for (const s of [-0.35, 0.35]) { ctx.beginPath(); ctx.arc(-size * 0.15, s * size * 0.55, size * 0.22, 0, Math.PI * 2); ctx.fill(); }
    }
    if (mods.has('acid_sacs')) {
      ctx.fillStyle = '#8fd15a';
      for (const s of [-0.3, 0.3]) { ctx.beginPath(); ctx.arc(-size * 0.25, s * size * 0.5, size * 0.2, 0, Math.PI * 2); ctx.fill(); }
    }
    if (mods.has('brood_sac')) {
      ctx.fillStyle = 'rgba(255,200,220,.85)';
      ctx.beginPath(); ctx.ellipse(-size * 0.95, 0, size * 0.4, size * 0.32, 0, 0, Math.PI * 2); ctx.fill();
    }

    ctx.restore();

    if (org.selected) {
      ctx.save();
      ctx.strokeStyle = '#33e6b0'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, size * 1.9, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // health bar for anything below 60% — a quiet, constant readout of danger
    const hf = K.clamp01(org.health / org.stats.health);
    if (hf < 0.6) {
      const w = Math.max(10, size * 2.2), h = 3;
      const bx = sx - w / 2, by = sy - size * 1.9 - 6;
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(bx, by, w, h);
      ctx.fillStyle = hf < 0.3 ? '#ef5b5b' : '#f2a33c'; ctx.fillRect(bx, by, w * hf, h);
    }
  }

  function tint(hex, delta) {
    const c = hexToRgb(hex);
    return `rgb(${K.clamp(c[0] + delta[0], 0, 255)},${K.clamp(c[1] + delta[1], 0, 255)},${K.clamp(c[2] + delta[2], 0, 255)})`;
  }
  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  // -- main draw ---------------------------------------------------------
  function draw(game, canvas, ctx) {
    const dpr = resizeCanvas(canvas);
    const w = canvas.width, h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (game.viewDepth) { drawStratum(game, canvas, ctx, w, h, dpr); return; }

    ctx.fillStyle = '#04080d';
    ctx.fillRect(0, 0, w, h);

    const zoom = game.camera.zoom * dpr;
    const size = game.world.size;
    const halfW = w / 2 / zoom, halfH = h / 2 / zoom;
    let sx0 = game.camera.x - halfW, sy0 = game.camera.y - halfH;
    let sx1 = game.camera.x + halfW, sy1 = game.camera.y + halfH;
    const csx0 = K.clamp(sx0, 0, size), csy0 = K.clamp(sy0, 0, size);
    const csx1 = K.clamp(sx1, 0, size), csy1 = K.clamp(sy1, 0, size);

    if (csx1 > csx0 && csy1 > csy0) {
      const cache = ensureCache(game);
      const dx0 = (csx0 - game.camera.x) * zoom + w / 2, dy0 = (csy0 - game.camera.y) * zoom + h / 2;
      const dx1 = (csx1 - game.camera.x) * zoom + w / 2, dy1 = (csy1 - game.camera.y) * zoom + h / 2;
      ctx.imageSmoothingEnabled = zoom < 3;
      ctx.drawImage(cache, csx0, csy0, csx1 - csx0, csy1 - csy0, dx0, dy0, dx1 - dx0, dy1 - dy0);
    }

    // Territory: drawn under everything living, as flat translucent blocks on
    // the coarse influence grid. Contested cells are hatched brighter, which
    // is where the player should expect trouble.
    if (game.territory && game.showTerritory !== false) drawTerritory(game, ctx, w, h, zoom, dpr, sx0, sy0, sx1, sy1);

    // Cores — the player's and every rival's, drawn identically apart from
    // colour, because a rival Core is the same kind of object.
    for (const colony of (game.colonies || [])) {
      if (!colony.alive) continue;
      if (colony.x < sx0 - 12 || colony.x > sx1 + 12 || colony.y < sy0 - 12 || colony.y > sy1 + 12) continue;
      const p = worldToScreenDpr(game, w, h, zoom, dpr, colony.x, colony.y);
      const r = colony.radius * zoom;
      const pulse = 0.85 + Math.sin(game.simTime * 2 + (colony.isPlayer ? 0 : 1.7)) * 0.08;
      const rgb = hexToRgb(colony.color);
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(1, r * pulse));
      grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.5)`);
      grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, r * pulse), 0, Math.PI * 2); ctx.fill();

      const inner = Math.max(4, r * 0.32);
      ctx.fillStyle = 'rgba(8,16,20,.9)';
      ctx.beginPath(); ctx.arc(p.x, p.y, inner, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = colony.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, inner, 0, Math.PI * 2); ctx.stroke();

      // Integrity ring: a Core losing a siege visibly empties out.
      if (colony.integrity < 100) {
        ctx.strokeStyle = '#ef5b5b'; ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, inner + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (colony.integrity / 100));
        ctx.stroke();
      }
    }

    /* The underground. Tunnels first, then chambers on top, all drawn with
     * dashed, dimmed edges so they read as *below* the surface rather
     * than as buildings sitting on it. */
    if (game.structures) drawUnderground(game, ctx, w, h, zoom, dpr, sx0, sy0, sx1, sy1);

    // Biomass deposits: the thing colonies compete over, so they have to be
    // visible. A claimed one is ringed in its owner's colour; a depleted one
    // fades, so "this patch is stripped" reads at a glance.
    for (const dep of game.world.deposits) {
      if (dep.x < sx0 - 4 || dep.x > sx1 + 4 || dep.y < sy0 - 4 || dep.y > sy1 + 4) continue;
      const p = worldToScreenDpr(game, w, h, zoom, dpr, dep.x, dep.y);
      const frac = K.clamp01(dep.remaining / dep.richness);
      const r = Math.max(3, 2.4 * zoom * (0.45 + frac * 0.55));
      ctx.fillStyle = `rgba(126,224,129,${0.25 + frac * 0.5})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      const owner = dep.claimedBy && game.coloniesById && game.coloniesById[dep.claimedBy];
      ctx.strokeStyle = owner ? owner.color : 'rgba(200,230,200,.5)';
      ctx.lineWidth = owner ? 2 : 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 2, 0, Math.PI * 2); ctx.stroke();
    }

    // samples
    for (const s of game.discovery.samples) {
      if (s.x < sx0 - 2 || s.x > sx1 + 2 || s.y < sy0 - 2 || s.y > sy1 + 2) continue;
      const p = worldToScreenDpr(game, w, h, zoom, dpr, s.x, s.y);
      const r = Math.max(4, 3.6 * zoom / 12);
      ctx.fillStyle = 'rgba(51,230,176,.85)';
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 2.5, 0, Math.PI * 2); ctx.stroke();
    }

    // organisms (viewport-culled)
    const margin = 3;
    for (const org of game.organisms) {
      if (org.x < sx0 - margin || org.x > sx1 + margin || org.y < sy0 - margin || org.y > sy1 + margin) continue;
      const p = worldToScreenDpr(game, w, h, zoom, dpr, org.x, org.y);
      drawOrganism(ctx, org, p.x, p.y, zoom);
    }

    canvas.__dpr = dpr;
  }

  function worldToScreenDpr(game, w, h, zoom, dpr, wx, wy) {
    return { x: (wx - game.camera.x) * zoom + w / 2, y: (wy - game.camera.y) * zoom + h / 2 };
  }

  function drawUnderground(game, ctx, w, h, zoom, dpr, sx0, sy0, sx1, sy1) {
    const list = CM.structures.all(game);
    if (!list.length) return;
    const byId = {};
    for (const s of list) byId[s.id] = s;

    // tunnels
    ctx.save();
    ctx.setLineDash([4, 3]);
    for (const s of list) {
      if (!s.linkId) continue;
      const other = byId[s.linkId];
      if (!other) continue;
      if (Math.max(s.x, other.x) < sx0 - 6 || Math.min(s.x, other.x) > sx1 + 6) continue;
      if (Math.max(s.y, other.y) < sy0 - 6 || Math.min(s.y, other.y) > sy1 + 6) continue;
      const colony = game.coloniesById && game.coloniesById[s.colonyId];
      const rgb = hexToRgb(colony ? colony.color : '#8899aa');
      const a = worldToScreenDpr(game, w, h, zoom, dpr, s.x, s.y);
      const b = worldToScreenDpr(game, w, h, zoom, dpr, other.x, other.y);
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${s.done ? 0.5 : 0.22})`;
      ctx.lineWidth = Math.max(1, zoom * 0.12);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();

    // chambers
    for (const s of list) {
      if (s.x < sx0 - 8 || s.x > sx1 + 8 || s.y < sy0 - 8 || s.y > sy1 + 8) continue;
      const type = CM.structures.TYPES[s.type];
      const colony = game.coloniesById && game.coloniesById[s.colonyId];
      const rgb = hexToRgb(colony ? colony.color : '#8899aa');
      const p = worldToScreenDpr(game, w, h, zoom, dpr, s.x, s.y);
      const r = Math.max(3.5, type.radius * zoom * 0.26);

      if (s.done) {
        /* Deliberately drawn light. An earlier version filled the chamber
         * with near-opaque dark and ringed its whole effect radius, which at
         * a normal zoom turned a developed network into black holes punched
         * through the map — the terrain, the food and the organisms standing
         * on it all disappeared. The underground has to be legible *and*
         * stay out of the way of the world it sits beneath. */
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.22)`;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.arc(p.x, p.y, type.radius * zoom, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = 'rgba(10,16,22,.45)';
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.9)`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
      } else {
        // A pit being dug: dashed outline plus a progress arc.
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.55)`;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.95)`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (s.work / s.workNeeded));
        ctx.stroke();
      }

      if (zoom > 7) {
        ctx.fillStyle = 'rgba(255,255,255,.85)';
        ctx.font = `${Math.max(9, Math.min(15, r * 1.1))}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(type.icon, p.x, p.y);
        ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
      }
    }
  }

  /* --- the stratum view -----------------------------------------------------
   * Looking at one underground level instead of the surface. Everything the
   * colony has cut becomes an actual excavated space: rooms with rock walls,
   * corridors between them, shafts running up and down. The rest of the
   * stratum is unlit rock, because a colony only knows the ground it has dug
   * — an underground map that showed the whole world would make prospecting
   * meaningless. */
  function siteSeed(site) {
    const n = parseInt(String(site.id).replace(/\D/g, ''), 10);
    return (isNaN(n) ? 1 : n) * 2654435761 % 100003;
  }

  /* Cavern outlines are wobbled and then smoothed through their midpoints, so
   * a room reads as something cut out of rock rather than a drawn circle. The
   * wobble is hashed off the chamber id, so a given room keeps its shape. */
  function roomPath(ctx, cx, cy, r, seed) {
    const n = 14;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const wob = 0.76 + K.hash2(seed, i, 0) * 0.42;
      pts.push([cx + Math.cos(a) * r * wob, cy + Math.sin(a) * r * wob]);
    }
    ctx.beginPath();
    let prev = pts[n - 1];
    ctx.moveTo((prev[0] + pts[0][0]) / 2, (prev[1] + pts[0][1]) / 2);
    for (let i = 0; i < n; i++) {
      const cur = pts[i], next = pts[(i + 1) % n];
      ctx.quadraticCurveTo(cur[0], cur[1], (cur[0] + next[0]) / 2, (cur[1] + next[1]) / 2);
    }
    ctx.closePath();
  }

  function drawStratum(game, canvas, ctx, w, h, dpr) {
    const depth = K.clamp(game.viewDepth, 1, CM.structures.MAX_DEPTH);
    const info = CM.structures.DEPTHS[depth];
    const zoom = game.camera.zoom * dpr;
    const size = game.world.size;
    const halfW = w / 2 / zoom, halfH = h / 2 / zoom;
    const sx0 = game.camera.x - halfW, sy0 = game.camera.y - halfH;
    const sx1 = game.camera.x + halfW, sy1 = game.camera.y + halfH;

    // Unlit rock. Everything drawn after this is somewhere a colony has been.
    ctx.fillStyle = depth === 3 ? '#0b0509' : depth === 2 ? '#08070d' : '#0a0806';
    ctx.fillRect(0, 0, w, h);

    const list = CM.structures.all(game);
    const byId = {};
    for (const s of list) byId[s.id] = s;
    const here = list.filter(s => s.depth === depth);
    const p2 = (x, y) => worldToScreenDpr(game, w, h, zoom, dpr, x, y);

    if (here.length) {
      /* The lit region: rock is only visible where the colony has opened it
       * up. Built as a clip of rooms plus the corridors between them, then
       * the baked rock is blitted through it — one drawImage, same as the
       * surface, however elaborate the network gets. */
      ctx.save();
      ctx.beginPath();
      for (const s of here) {
        const p = p2(s.x, s.y);
        const lit = CM.structures.TYPES[s.type].radius * zoom * 0.88;
        ctx.moveTo(p.x + lit, p.y);
        ctx.arc(p.x, p.y, lit, 0, Math.PI * 2);
      }
      // Corridors are lit too, or a tunnel would run through black nothing.
      ctx.lineWidth = Math.max(6, zoom * 1.6);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const s of here) {
        const other = s.linkId && byId[s.linkId];
        if (!other || other.depth !== depth) continue;
        const a = p2(s.x, s.y), b = p2(other.x, other.y);
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      }
      ctx.clip();

      const csx0 = K.clamp(sx0, 0, size), csy0 = K.clamp(sy0, 0, size);
      const csx1 = K.clamp(sx1, 0, size), csy1 = K.clamp(sy1, 0, size);
      if (csx1 > csx0 && csy1 > csy0) {
        const rock = ensureRockCache(game, depth);
        const dx0 = (csx0 - game.camera.x) * zoom + w / 2, dy0 = (csy0 - game.camera.y) * zoom + h / 2;
        const dx1 = (csx1 - game.camera.x) * zoom + w / 2, dy1 = (csy1 - game.camera.y) * zoom + h / 2;
        /* Nearest-neighbour once a world cell is bigger than a few pixels.
         * Smoothed, the 1px-per-cell grain averages itself into a flat brown
         * fog and the stratum stops reading as rock at all — the same reason
         * the surface terrain turns smoothing off past this zoom. */
        ctx.imageSmoothingEnabled = zoom < 3;
        ctx.drawImage(rock, csx0, csy0, csx1 - csx0, csy1 - csy0, dx0, dy0, dx1 - dx0, dy1 - dy0);
      }

      /* Falloff: the lit area has to fade into the dark instead of ending at a
       * hard circle, or the network looks like discs cut out of a photograph
       * rather than the reach of the colony's own light.
       *
       * Composited with 'darken' rather than drawn normally. Drawn normally,
       * two chambers whose halos overlap sum their shadows, and a developed
       * network turns into a pattern of visibly overlapping grey discs — the
       * seam between two rooms came out darker than the rock beyond either.
       * 'darken' takes the darker of the two instead of adding them, which is
       * how overlapping pools of light actually behave. */
      ctx.globalCompositeOperation = 'darken';
      for (const s of here) {
        const p = p2(s.x, s.y);
        const lit = CM.structures.TYPES[s.type].radius * zoom * 0.88;
        /* The fade starts inside the room, not at its wall. Starting it at
         * the wall left a band of raw, evenly-lit rock around every chamber,
         * and a cluster of chambers read as a pile of grey discs. */
        const fade = ctx.createRadialGradient(p.x, p.y, lit * 0.45, p.x, p.y, lit);
        // Fully opaque at the rim, not merely dark: at 0.88 the clip boundary
        // stayed faintly visible, so the lit region read as a ring of hard
        // grey discs rather than as light petering out into rock.
        fade.addColorStop(0, 'rgba(0,0,0,0)');
        fade.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = fade;
        ctx.beginPath(); ctx.arc(p.x, p.y, lit, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    }

    // Known veins, drawn before the excavations so a veinworks sits on top of
    // its seam. Only at the depth they belong to, and only once found.
    if (depth === CM.structures.MAX_DEPTH) {
      for (const v of (game.world.veins || [])) {
        if (!v.known) continue;
        if (v.x < sx0 - 6 || v.x > sx1 + 6 || v.y < sy0 - 6 || v.y > sy1 + 6) continue;
        const p = p2(v.x, v.y);
        const frac = K.clamp01(v.remaining / v.richness);
        const r = Math.max(4, 2.6 * zoom);
        const pulse = 0.6 + Math.sin(game.simTime * 1.6 + v.x) * 0.15;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.2);
        grad.addColorStop(0, `rgba(126,224,160,${(0.2 + frac * 0.5) * pulse})`);
        grad.addColorStop(1, 'rgba(126,224,160,0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2); ctx.fill();
        // The seam itself: a few bright splinters through the rock.
        ctx.strokeStyle = `rgba(180,255,200,${0.25 + frac * 0.45})`;
        ctx.lineWidth = Math.max(1, zoom * 0.09);
        for (let i = 0; i < 4; i++) {
          const a = K.hash2(7, v.x | 0, i) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(p.x - Math.cos(a) * r, p.y - Math.sin(a) * r);
          ctx.lineTo(p.x + Math.cos(a) * r * 1.3, p.y + Math.sin(a) * r * 1.3);
          ctx.stroke();
        }
      }
    }

    /* Corridors. A link between two chambers on this level is a cut tunnel;
     * a link that changes level is a shaft, drawn at the deeper end. */
    for (const s of here) {
      if (!s.linkId) continue;
      const other = byId[s.linkId];
      if (!other) continue;
      const colony = game.coloniesById && game.coloniesById[s.colonyId];
      const rgb = hexToRgb(colony ? colony.color : '#8899aa');
      if (other.depth !== depth) continue; // vertical: drawn as a shaft below
      const rock = CM.structures.DEPTHS[depth].rock;
      const a = p2(s.x, s.y), b = p2(other.x, other.y);
      const wide = Math.max(2.5, zoom * 0.5);
      ctx.lineCap = 'round';
      // Cut walls, then the floor of the passage between them. Same logic as a
      // room: the corridor is dug-out space, so it is lighter than the rock.
      ctx.strokeStyle = `rgba(${(rock[0] * 0.35) | 0},${(rock[1] * 0.35) | 0},${(rock[2] * 0.35) | 0},.9)`;
      ctx.lineWidth = wide + Math.max(2, zoom * 0.18);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = s.done
        ? `rgb(${Math.min(255, rock[0] * 1.2 + rgb[0] * 0.12) | 0},${Math.min(255, rock[1] * 1.2 + rgb[1] * 0.12) | 0},${Math.min(255, rock[2] * 1.2 + rgb[2] * 0.12) | 0})`
        : 'rgba(120,120,130,.3)';
      ctx.lineWidth = wide;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // Rooms.
    for (const s of here) {
      if (s.x < sx0 - 12 || s.x > sx1 + 12 || s.y < sy0 - 12 || s.y > sy1 + 12) continue;
      drawRoom(game, ctx, s, p2(s.x, s.y), zoom, byId, depth);
    }

    /* Organisms that are down here. Deep fauna carry their own stratum;
     * a colony's own organisms are underground when they are standing inside
     * one of its chambers on this level, which is exactly when the chamber's
     * effects are reaching them. */
    const seen = new Set();
    const drawOne = (org) => {
      if (seen.has(org.id) || !org.alive) return;
      seen.add(org.id);
      const p = p2(org.x, org.y);
      drawOrganism(ctx, org, p.x, p.y, zoom);
    };
    for (const s of here) {
      if (!s.done) continue;
      // Matched to the *drawn* room, not to the chamber's effect radius: the
      // effect radius is much wider, so organisms merely passing near a
      // chamber were drawn floating in solid rock.
      const r = CM.structures.TYPES[s.type].radius * 0.62;
      for (const o of game.world.grid.queryRadius(s.x, s.y, r, [])) {
        if (o.depth && o.depth !== depth) continue;
        drawOne(o);
      }
    }
    for (const org of game.organisms) {
      if (org.depth === depth && org.x > sx0 - 3 && org.x < sx1 + 3 && org.y > sy0 - 3 && org.y < sy1 + 3) drawOne(org);
    }

    /* Chambers one level away, as faint ghosts. Without them the strata feel
     * like unrelated maps; with them the player can see where the level above
     * sits over the level they are cutting. */
    ctx.save();
    ctx.setLineDash([2, 5]);
    for (const s of list) {
      if (Math.abs(s.depth - depth) !== 1) continue;
      if (s.x < sx0 - 10 || s.x > sx1 + 10 || s.y < sy0 - 10 || s.y > sy1 + 10) continue;
      const p = p2(s.x, s.y);
      const r = Math.max(3, CM.structures.TYPES[s.type].radius * zoom * 0.5);
      ctx.strokeStyle = s.depth < depth ? 'rgba(150,170,190,.22)' : 'rgba(190,140,170,.22)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();

    // Shafts: where a chamber on this level connects to another stratum.
    for (const s of here) {
      const other = s.linkId && byId[s.linkId];
      if (!other || other.depth === depth) continue;
      const p = p2(s.x, s.y);
      const r = Math.max(5, zoom * 0.9);
      const up = other.depth < depth;
      ctx.strokeStyle = up ? 'rgba(190,205,220,.8)' : 'rgba(210,150,180,.8)';
      ctx.lineWidth = Math.max(1.5, zoom * 0.1);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
      // rungs, so the direction of travel is readable without a legend
      for (let i = -1; i <= 1; i++) {
        const y = p.y + i * r * 0.55;
        ctx.beginPath(); ctx.moveTo(p.x - r * 0.55, y); ctx.lineTo(p.x + r * 0.55, y); ctx.stroke();
      }
    }

    /* Depth banner. Along the bottom rather than the top: the top of the stage
     * is where toasts stack, and a banner there spent most of its life hidden
     * behind three of them. */
    ctx.save();
    ctx.font = `600 ${Math.round(13 * dpr)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const label = `${info.name}  ·  level ${depth} of ${CM.structures.MAX_DEPTH}`;
    const tw = ctx.measureText(label).width;
    const by = h - 34 * dpr;
    ctx.fillStyle = 'rgba(6,8,12,.8)';
    ctx.fillRect(w / 2 - tw / 2 - 12 * dpr, by, tw + 24 * dpr, 24 * dpr);
    ctx.strokeStyle = info.tint; ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(w / 2 - tw / 2 - 12 * dpr, by); ctx.lineTo(w / 2 + tw / 2 + 12 * dpr, by); ctx.stroke();
    ctx.fillStyle = info.tint;
    ctx.fillText(label, w / 2, by + 17 * dpr);
    if (!here.length) {
      ctx.font = `${Math.round(12 * dpr)}px system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(200,210,220,.55)';
      ctx.fillText('Solid rock. Nothing has been cut this deep yet.', w / 2, h / 2);
    }
    ctx.restore();
    canvas.__dpr = dpr;
  }

  function drawRoom(game, ctx, s, p, zoom, byId, depth) {
    const type = CM.structures.TYPES[s.type];
    const colony = game.coloniesById && game.coloniesById[s.colonyId];
    const rgb = hexToRgb(colony ? colony.color : '#8899aa');
    const r = Math.max(5, type.radius * zoom * 0.62);
    const seed = siteSeed(s);

    if (!s.done) {
      // A working face: the outline of the room to come, and how far in it is.
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.45)`;
      ctx.lineWidth = 1.5;
      roomPath(ctx, p.x, p.y, r, seed);
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.95)`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.55, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (s.work / s.workNeeded));
      ctx.stroke();
      return;
    }

    /* Floor. An excavated, occupied room is the *brightest* thing on the
     * stratum — an earlier version filled it with near-black over lighter
     * rock, which read exactly backwards: the chambers looked like holes
     * punched in the ground rather than spaces the colony lives in. The floor
     * is lit stone, warmed toward the colony's own colour at the centre. */
    const rock = CM.structures.DEPTHS[s.depth].rock;
    roomPath(ctx, p.x, p.y, r, seed);
    const floor = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    floor.addColorStop(0, `rgb(${Math.min(255, rock[0] * 1.5 + rgb[0] * 0.34)},${Math.min(255, rock[1] * 1.5 + rgb[1] * 0.34)},${Math.min(255, rock[2] * 1.5 + rgb[2] * 0.34)})`);
    floor.addColorStop(0.62, `rgb(${(rock[0] * 1.05) | 0},${(rock[1] * 1.05) | 0},${(rock[2] * 1.05) | 0})`);
    floor.addColorStop(1, `rgb(${(rock[0] * 0.6) | 0},${(rock[1] * 0.6) | 0},${(rock[2] * 0.6) | 0})`);
    ctx.fillStyle = floor;
    ctx.fill();
    // Cut rock rim: a bright inner edge over a dark one reads as a wall face.
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.lineWidth = Math.max(2, zoom * 0.2);
    ctx.stroke();
    ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.75)`;
    ctx.lineWidth = Math.max(1, zoom * 0.06);
    ctx.stroke();

    /* The Sanctum is the one room the whole descent is for, so it is the one
     * room that announces itself: a slow pulse the player can find from any
     * zoom level. */
    if (type.endgame) {
      const pulse = 0.5 + Math.sin(game.simTime * 1.4) * 0.5;
      ctx.strokeStyle = `rgba(200,140,255,${0.25 + pulse * 0.5})`;
      ctx.lineWidth = Math.max(1.5, zoom * 0.1);
      ctx.beginPath(); ctx.arc(p.x, p.y, r * (1.15 + pulse * 0.18), 0, Math.PI * 2); ctx.stroke();
    }

    // Damage: a chamber being chewed open cracks visibly before it collapses.
    if (s.integrity != null && s.integrity < 100) {
      const frac = K.clamp01(s.integrity / 100);
      ctx.strokeStyle = `rgba(239,91,91,${0.4 + (1 - frac) * 0.5})`;
      ctx.lineWidth = Math.max(1, zoom * 0.08);
      for (let i = 0; i < 3; i++) {
        const a = K.hash2(seed, i, 9) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(p.x + Math.cos(a) * r * 0.9, p.y + Math.sin(a) * r * 0.9);
        ctx.lineTo(p.x + Math.cos(a + 0.5) * r * 0.35, p.y + Math.sin(a + 0.5) * r * 0.35);
        ctx.stroke();
      }
    }

    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.font = `${Math.max(10, Math.min(20, r * 0.7))}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(type.icon, p.x, p.y);
    if (zoom > 9) {
      ctx.font = `${Math.max(8, Math.min(12, r * 0.3))}px system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(220,228,236,.7)';
      ctx.fillText(type.name, p.x, p.y + r * 0.78);
    }
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }

  function drawTerritory(game, ctx, w, h, zoom, dpr, sx0, sy0, sx1, sy1) {
    const terr = game.territory;
    const cell = terr.cell;
    const x0 = Math.max(0, Math.floor(sx0 / cell)), y0 = Math.max(0, Math.floor(sy0 / cell));
    const x1 = Math.min(terr.size - 1, Math.ceil(sx1 / cell)), y1 = Math.min(terr.size - 1, Math.ceil(sy1 / cell));
    const px = cell * zoom;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const ti = ty * terr.size + tx;
        const owner = terr.owner[ti];
        if (owner < 0) continue;
        const colony = game.colonies[owner];
        if (!colony || !colony.alive) continue;
        const p = worldToScreenDpr(game, w, h, zoom, dpr, tx * cell, ty * cell);
        const rgb = hexToRgb(colony.color);
        ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${terr.contested[ti] ? 0.24 : 0.12})`;
        ctx.fillRect(p.x, p.y, px + 1, px + 1);
        if (terr.contested[ti]) {
          ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.5)`;
          ctx.lineWidth = 1;
          ctx.strokeRect(p.x + 1, p.y + 1, px - 1, px - 1);
        }
      }
    }
  }

  CM.render = {
    ZOOM_MIN, ZOOM_MAX, ensureCache, ensureRockCache, resizeCanvas, clampCamera, focusOn, updateCamera,
    worldToScreen, screenToWorld, draw, drawOrganism
  };
})(window.CM = window.CM || {});
