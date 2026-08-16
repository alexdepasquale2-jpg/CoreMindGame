/* Coremind — procedural world: a 256x256 cell ecosystem.
 *
 * Terrain is regenerated from the seed on every load and never saved, so
 * everything here must be deterministic given the same seed. What the player
 * *changed* (food levels, colonies, discoveries) lives in save.js.
 *
 * Generation runs as a pipeline of named stages, each drawing from its own
 * offset of the seed, so changing one stage's algorithm cannot silently
 * shift the output of the others.
 */
(function (CM) {
  'use strict';
  const K = CM.core;

  const SIZE = 256;

  /* Biome ids are append-only: they are written into save-adjacent code
   * paths and compared numerically all over the simulation. Insert new
   * biomes at the end, never in the middle. */
  const BIOME = {
    DEEP_WATER: 0, SHALLOWS: 1, MARSH: 2, BEACH: 3, DESERT: 4, SAVANNA: 5,
    GRASSLAND: 6, FOREST: 7, JUNGLE: 8, TAIGA: 9, TUNDRA: 10, ICE: 11,
    ROCK: 12, MOUNTAIN: 13
  };

  /* foodCap: peak plant biomass a cell of this biome can hold.
   * moveCost: multiplier on movement speed (1 = normal ground).
   * water:    can be drunk from / counts as open water.
   * shelter:  reduces how exposed an organism is to temperature swings. */
  const BIOME_INFO = [
    { id: 0,  key: 'DEEP_WATER', name: 'Deep Water', color: [22, 52, 84],   foodCap: 0,   moveCost: 0.35, water: true,  shelter: 0,    passable: true },
    { id: 1,  key: 'SHALLOWS',   name: 'Shallows',   color: [42, 96, 130],  foodCap: 14,  moveCost: 0.6,  water: true,  shelter: 0,    passable: true },
    { id: 2,  key: 'MARSH',      name: 'Marsh',      color: [64, 92, 66],   foodCap: 78,  moveCost: 0.7,  water: true,  shelter: 0.25, passable: true },
    { id: 3,  key: 'BEACH',      name: 'Sands',      color: [178, 162, 116],foodCap: 8,   moveCost: 0.9,  water: false, shelter: 0,    passable: true },
    { id: 4,  key: 'DESERT',     name: 'Desert',     color: [186, 148, 92], foodCap: 6,   moveCost: 0.95, water: false, shelter: 0,    passable: true },
    { id: 5,  key: 'SAVANNA',    name: 'Savanna',    color: [152, 152, 74], foodCap: 46,  moveCost: 1,    water: false, shelter: 0.1,  passable: true },
    { id: 6,  key: 'GRASSLAND',  name: 'Grassland',  color: [96, 142, 62],  foodCap: 84,  moveCost: 1,    water: false, shelter: 0.1,  passable: true },
    { id: 7,  key: 'FOREST',     name: 'Forest',     color: [52, 104, 54],  foodCap: 104, moveCost: 0.82, water: false, shelter: 0.45, passable: true },
    { id: 8,  key: 'JUNGLE',     name: 'Jungle',     color: [34, 92, 48],   foodCap: 128, moveCost: 0.68, water: false, shelter: 0.55, passable: true },
    { id: 9,  key: 'TAIGA',      name: 'Taiga',      color: [58, 88, 74],   foodCap: 58,  moveCost: 0.85, water: false, shelter: 0.4,  passable: true },
    { id: 10, key: 'TUNDRA',     name: 'Tundra',     color: [122, 128, 112],foodCap: 22,  moveCost: 0.92, water: false, shelter: 0.05, passable: true },
    { id: 11, key: 'ICE',        name: 'Ice Sheet',  color: [206, 218, 226],foodCap: 2,   moveCost: 0.75, water: false, shelter: 0,    passable: true },
    { id: 12, key: 'ROCK',       name: 'Rocky Waste',color: [104, 100, 96], foodCap: 10,  moveCost: 0.7,  water: false, shelter: 0.3,  passable: true },
    { id: 13, key: 'MOUNTAIN',   name: 'Mountains',  color: [140, 138, 140],foodCap: 0,   moveCost: 0.45, water: false, shelter: 0.35, passable: true }
  ];
  const BIOME_NAMES = BIOME_INFO.map(b => b.name);

  function isWaterBiome(b) { return BIOME_INFO[b] && BIOME_INFO[b].water; }

  // --- hazards -------------------------------------------------------------
  const HAZARD = { NONE: 0, THERMAL_VENT: 1, TOXIC_BOG: 2, HARD_FROST: 3 };
  const HAZARD_INFO = [
    null,
    { key: 'THERMAL_VENT', name: 'Thermal Vent', tempDelta: 26,  damage: 0.9, color: [214, 96, 48] },
    { key: 'TOXIC_BOG',    name: 'Toxic Bog',    tempDelta: 0,   damage: 1.6, color: [126, 176, 62] },
    { key: 'HARD_FROST',   name: 'Frost Hollow', tempDelta: -24, damage: 0.9, color: [150, 200, 224] }
  ];

  function idx(x, y) { return y * SIZE + x; }
  function inBounds(x, y) { return x >= 0 && y >= 0 && x < SIZE && y < SIZE; }

  // --- region naming -------------------------------------------------------
  const NAME_PREFIX = ['Ashen', 'Verdant', 'Hollow', 'Sunken', 'Pale', 'Bitter', 'Amber', 'Quiet',
    'Broken', 'Long', 'Deep', 'First', 'Salt', 'Iron', 'Glass', 'Low', 'Far', 'Old'];
  const NAME_SUFFIX = {
    DEEP_WATER: 'Deep', SHALLOWS: 'Shoal', MARSH: 'Fen', BEACH: 'Strand', DESERT: 'Waste',
    SAVANNA: 'Flats', GRASSLAND: 'Meadows', FOREST: 'Wood', JUNGLE: 'Tangle', TAIGA: 'Pinewood',
    TUNDRA: 'Barrens', ICE: 'Whiteness', ROCK: 'Scree', MOUNTAIN: 'Spine'
  };

  function regionName(rng, biomeId) {
    return NAME_PREFIX[Math.floor(rng() * NAME_PREFIX.length)] + ' ' + NAME_SUFFIX[BIOME_INFO[biomeId].key];
  }

  /* --- generation ---------------------------------------------------------
   * Elevation carves sea, land and highland. Moisture is elevation-biased so
   * basins are wetter, then rivers add moisture along their length.
   * Temperature follows a latitude band plus a lapse rate with altitude.
   * Biome is the joint classification of the three. */
  function generate(seed) {
    seed = (seed >>> 0) || 1;
    const n = SIZE * SIZE;

    const elevation = new Float32Array(n);
    const moisture = new Float32Array(n);
    const temp = new Float32Array(n);
    const biome = new Uint8Array(n);
    const food = new Float32Array(n);
    const foodCap = new Float32Array(n);
    const flora = new Uint8Array(n);
    const regionId = new Uint16Array(n);
    const river = new Uint8Array(n);
    const hazard = new Uint8Array(n);

    // stage 1: elevation ---------------------------------------------------
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = idx(x, y);
        let e = K.fbm(seed, x * 0.018, y * 0.018, 5) * 0.7
              + K.fbm(seed + 1, x * 0.055, y * 0.055, 3) * 0.3;
        /* Raw fbm clusters hard around its midpoint, which leaves a map that
         * is half ocean and has no highland at all — every threshold above
         * ~0.75 goes unused. Stretching around a pivot below the mean widens
         * both tails, so the same noise yields real mountains and real deeps.
         * Measured over three seeds: ~25% water, ~65% habitable, ~10% highland. */
        e = K.clamp01(0.5 + (e - 0.45) * 1.7);
        // Pull the map's rim down so the playable landmass is enclosed by sea
        // rather than being cut off arbitrarily by the array bounds. Kept
        // narrow (10%) so the cold polar rows survive as land — a wider skirt
        // drowns them and the tundra/ice biomes never generate.
        const edge = Math.min(x, y, SIZE - 1 - x, SIZE - 1 - y) / (SIZE * 0.10);
        e *= K.clamp01(edge);
        elevation[i] = e;
      }
    }

    // stage 2: moisture + temperature --------------------------------------
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = idx(x, y);
        const e = elevation[i];
        moisture[i] = K.clamp01(K.fbm(seed + 2000, x * 0.03, y * 0.03, 4) * 0.72 + (1 - e) * 0.28);
        const lat = Math.abs(y / SIZE - 0.5) * 2;             // 0 equator, 1 pole
        let t = K.lerp(34, -12, lat)
              + (K.fbm(seed + 4000, x * 0.045, y * 0.045, 3) - 0.5) * 12;
        t -= Math.max(0, e - 0.45) * 42;                      // lapse rate with altitude
        temp[i] = t;
      }
    }

    // stage 3: rivers -------------------------------------------------------
    const rngRiver = K.rngFrom(seed ^ 0x5bf03635);
    carveRivers(elevation, moisture, river, rngRiver);

    // stage 4: biome classification ----------------------------------------
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = idx(x, y);
        biome[i] = classify(elevation[i], temp[i], moisture[i], river[i]);
      }
    }
    // Beaches read from the finished biome map, so they need their own pass.
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = idx(x, y);
        const b = biome[i];
        if (b === BIOME.DESERT || b === BIOME.SAVANNA || b === BIOME.GRASSLAND || b === BIOME.TUNDRA) {
          if (elevation[i] < 0.38 && touchesDeepWater(biome, x, y)) biome[i] = BIOME.BEACH;
        }
      }
    }

    // stage 5: flora + food capacity ---------------------------------------
    const world = {
      seed, size: SIZE,
      elevation, moisture, temp, biome, food, foodCap, flora, regionId, river, hazard,
      foodCursor: 0,
      regions: [],
      hazards: [],
      deposits: [],
      veins: [],
      grid: makeSpatialGrid(SIZE, 6)
    };
    CM.flora.populate(world, seed);

    // stage 6: regions + derived fields -------------------------------------
    world.regions = buildRegions(world, K.rngFrom(seed ^ 0x27d4eb2f));
    buildWaterField(world);

    // stage 7: hazards + deposits ------------------------------------------
    placeHazards(world, K.rngFrom(seed ^ 0x165667b1));
    placeDeposits(world, K.rngFrom(seed ^ 0x9e3779b1));
    placeVeins(world, K.rngFrom(seed ^ 0x3b9aca07));

    world.coreSpawn = findColonySite(world, K.rngFrom(seed ^ 0x9e3779b9), []);
    return world;
  }

  function classify(e, t, m, isRiver) {
    if (e < 0.24) return BIOME.DEEP_WATER;
    if (e < 0.305) return BIOME.SHALLOWS;
    if (isRiver) return BIOME.SHALLOWS;
    if (e > 0.86) return BIOME.MOUNTAIN;
    if (e > 0.75) return BIOME.ROCK;
    if (e < 0.40 && m > 0.66 && t > 2) return BIOME.MARSH;
    if (t < -11) return BIOME.ICE;
    if (t < 1) return m > 0.46 ? BIOME.TAIGA : BIOME.TUNDRA;
    if (t < 12) return m > 0.58 ? BIOME.FOREST : (m > 0.32 ? BIOME.GRASSLAND : BIOME.TUNDRA);
    if (t < 25) {
      if (m > 0.66) return BIOME.FOREST;
      if (m > 0.4) return BIOME.GRASSLAND;
      if (m > 0.22) return BIOME.SAVANNA;
      return BIOME.DESERT;
    }
    if (m > 0.6) return BIOME.JUNGLE;
    if (m > 0.42) return BIOME.SAVANNA;
    return BIOME.DESERT;
  }

  function touchesDeepWater(biome, x, y) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (inBounds(nx, ny)) {
          const b = biome[idx(nx, ny)];
          if (b === BIOME.DEEP_WATER || b === BIOME.SHALLOWS) return true;
        }
      }
    }
    return false;
  }

  /* Rivers run from high ground to the sea by steepest descent, with a small
   * random nudge so they meander instead of drawing straight lines. They are
   * what makes the interior of a continent habitable: without them, every
   * inland region is a death sentence for anything that needs to drink. */
  function carveRivers(elevation, moisture, river, rng) {
    const RIVER_COUNT = 26, MAX_LEN = 420;
    for (let r = 0; r < RIVER_COUNT; r++) {
      // start somewhere high
      let sx = 0, sy = 0, bestE = -1;
      for (let tries = 0; tries < 40; tries++) {
        const x = 4 + Math.floor(rng() * (SIZE - 8));
        const y = 4 + Math.floor(rng() * (SIZE - 8));
        const e = elevation[idx(x, y)];
        if (e > bestE) { bestE = e; sx = x; sy = y; }
      }
      if (bestE < 0.5) continue;

      let x = sx, y = sy;
      for (let step = 0; step < MAX_LEN; step++) {
        const i = idx(x, y);
        if (elevation[i] < 0.305) break;   // reached the sea
        river[i] = 1;
        // widen the moisture influence around the channel
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx, ny = y + dy;
            if (!inBounds(nx, ny)) continue;
            const d = Math.abs(dx) + Math.abs(dy);
            const j = idx(nx, ny);
            moisture[j] = K.clamp01(moisture[j] + (d <= 1 ? 0.3 : d <= 2 ? 0.16 : 0.07));
          }
        }
        // steepest descent among the 8 neighbours, with a little noise
        let nx = x, ny = y, bestScore = Infinity;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const cx = x + dx, cy = y + dy;
            if (!inBounds(cx, cy)) continue;
            const score = elevation[idx(cx, cy)] + (rng() - 0.5) * 0.02;
            if (score < bestScore) { bestScore = score; nx = cx; ny = cy; }
          }
        }
        if (nx === x && ny === y) break;          // local minimum: a lake
        if (bestScore >= elevation[i] + 0.004) break;
        x = nx; y = ny;
      }
    }
  }

  /* Contiguous same-biome areas become named regions. Small blobs are folded
   * into region 0 ("unremarkable ground") so the map has a handful of places
   * worth naming rather than thousands. */
  function buildRegions(world, rng) {
    const { biome, regionId } = world;
    const n = SIZE * SIZE;
    const MIN_REGION = 220;
    const regions = [{ id: 0, name: 'Uncharted', biome: BIOME.GRASSLAND, size: 0, cx: 0, cy: 0 }];
    const stack = new Int32Array(n);
    const visited = new Uint8Array(n);

    for (let start = 0; start < n; start++) {
      if (visited[start]) continue;
      const b = biome[start];
      let sp = 0, count = 0, sumX = 0, sumY = 0;
      stack[sp++] = start;
      visited[start] = 1;
      const cells = [];
      while (sp > 0) {
        const cur = stack[--sp];
        cells.push(cur);
        count++;
        sumX += cur % SIZE; sumY += (cur / SIZE) | 0;
        const cx = cur % SIZE, cy = (cur / SIZE) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0);
          const ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0);
          if (!inBounds(nx, ny)) continue;
          const j = idx(nx, ny);
          if (visited[j] || biome[j] !== b) continue;
          visited[j] = 1;
          stack[sp++] = j;
        }
      }
      if (count >= MIN_REGION && regions.length < 64) {
        const id = regions.length;
        regions.push({ id, name: regionName(rng, b), biome: b, size: count, cx: sumX / count, cy: sumY / count });
        for (const c of cells) regionId[c] = id;
      }
    }
    return regions;
  }

  function placeHazards(world, rng) {
    const { biome, hazard, temp } = world;
    const wanted = 34;
    for (let placed = 0; placed < wanted; ) {
      const x = Math.floor(rng() * SIZE), y = Math.floor(rng() * SIZE);
      const i = idx(x, y);
      const b = biome[i];
      let kind = HAZARD.NONE;
      if (b === BIOME.ROCK || b === BIOME.MOUNTAIN) kind = HAZARD.THERMAL_VENT;
      else if (b === BIOME.MARSH || b === BIOME.JUNGLE) kind = HAZARD.TOXIC_BOG;
      else if (b === BIOME.ICE || b === BIOME.TUNDRA) kind = HAZARD.HARD_FROST;
      if (kind === HAZARD.NONE) continue;

      const radius = 2 + Math.floor(rng() * 3);
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > radius * radius) continue;
          const nx = x + dx, ny = y + dy;
          if (!inBounds(nx, ny)) continue;
          hazard[idx(nx, ny)] = kind;
        }
      }
      world.hazards.push({ x: x + 0.5, y: y + 0.5, kind, radius, name: HAZARD_INFO[kind].name });
      placed++;
    }
  }

  /* Dense biomass deposits: the thing colonies actually compete over. Placed
   * only on productive land so contested ground is also ground worth living
   * on, rather than an arbitrary objective marker in a wasteland. */
  function placeDeposits(world, rng) {
    const wanted = 20;
    for (let placed = 0; placed < wanted; ) {
      const x = Math.floor(rng() * SIZE), y = Math.floor(rng() * SIZE);
      const i = idx(x, y);
      const b = world.biome[i];
      if (b !== BIOME.FOREST && b !== BIOME.JUNGLE && b !== BIOME.GRASSLAND && b !== BIOME.MARSH && b !== BIOME.SAVANNA) continue;
      if (world.hazard[i] !== HAZARD.NONE) continue;
      const richness = 60 + rng() * 140;
      world.deposits.push({
        id: 'dep_' + placed,
        x: x + 0.5, y: y + 0.5,
        richness,
        remaining: richness,
        claimedBy: null
      });
      placed++;
    }
  }

  /* Abyssal biomass veins. Unlike surface deposits these are invisible until
   * a colony digs deep near them, so the deep tier opens with prospecting
   * rather than with a shopping list. Placed on any diggable ground — the
   * best vein on a map may well be somewhere unpleasant to hold. */
  function placeVeins(world, rng) {
    world.veins = [];
    const wanted = 14;
    for (let placed = 0; placed < wanted; ) {
      const x = Math.floor(rng() * SIZE), y = Math.floor(rng() * SIZE);
      const i = idx(x, y);
      if (isWaterBiome(world.biome[i]) || world.biome[i] === BIOME.MOUNTAIN) continue;
      let tooClose = false;
      for (const v of world.veins) if (K.dist(v.x, v.y, x, y) < 26) { tooClose = true; break; }
      if (tooClose) continue;
      const richness = 900 + rng() * 1600;
      world.veins.push({
        id: 'vein_' + placed, x: x + 0.5, y: y + 0.5,
        richness, remaining: richness, known: false, claimedBy: null
      });
      placed++;
    }
  }

  /* Somewhere a colony can actually live: productive, temperate, near water,
   * and away from every site already taken. Used for the player's Core and
   * for every rival. */
  function findColonySite(world, rng, avoid) {
    let best = null, bestScore = -Infinity;
    for (let tries = 0; tries < 900; tries++) {
      const x = K.rndInt(rng, 12, SIZE - 12);
      const y = K.rndInt(rng, 12, SIZE - 12);
      const i = idx(x, y);
      const b = world.biome[i];
      if (b !== BIOME.GRASSLAND && b !== BIOME.FOREST && b !== BIOME.SAVANNA && b !== BIOME.JUNGLE && b !== BIOME.MARSH) continue;
      if (world.hazard[i] !== HAZARD.NONE) continue;

      const t = world.temp[i];
      let score = -Math.abs(t - 18) * 0.6 + world.foodCap[i] * 0.06;

      let nearWater = false;
      for (let dy = -4; dy <= 4 && !nearWater; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const nx = x + dx, ny = y + dy;
          if (inBounds(nx, ny) && isWaterBiome(world.biome[idx(nx, ny)])) { nearWater = true; break; }
        }
      }
      if (!nearWater) continue;      // a colony without water is not a colony
      score += 6;

      let tooClose = false;
      for (const a of avoid) {
        const d = K.dist(x, y, a.x, a.y);
        if (d < 55) { tooClose = true; break; }
        score += Math.min(12, d * 0.04);
      }
      if (tooClose) continue;

      if (score > bestScore) { bestScore = score; best = { x: x + 0.5, y: y + 0.5 }; }
    }
    // Relax the spacing rule rather than fail outright on a cramped map.
    if (!best && avoid.length) return findColonySite(world, rng, avoid.slice(0, -1));
    return best || { x: SIZE / 2, y: SIZE / 2 };
  }

  // --- lookups --------------------------------------------------------------
  function biomeAt(world, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (!inBounds(xi, yi)) return BIOME.DEEP_WATER;
    return world.biome[idx(xi, yi)];
  }
  function biomeInfoAt(world, x, y) { return BIOME_INFO[biomeAt(world, x, y)]; }
  function isWaterAt(world, x, y) { return isWaterBiome(biomeAt(world, x, y)); }
  function moveCostAt(world, x, y) { return BIOME_INFO[biomeAt(world, x, y)].moveCost; }

  function hazardAt(world, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (!inBounds(xi, yi)) return HAZARD.NONE;
    return world.hazard[idx(xi, yi)];
  }

  /* Effective temperature, including the local hazard's contribution and the
   * shelter a dense biome gives against it. */
  function tempAt(world, x, y) {
    const xi = K.clamp(Math.floor(x), 0, SIZE - 1), yi = K.clamp(Math.floor(y), 0, SIZE - 1);
    const i = idx(xi, yi);
    let t = world.temp[i] + (world.climateOffset || 0);
    const hz = world.hazard[i];
    if (hz) t += HAZARD_INFO[hz].tempDelta;
    const shelter = BIOME_INFO[world.biome[i]].shelter;
    // Shelter pulls the local reading back toward the comfortable middle.
    if (shelter > 0) t = K.lerp(t, 19, shelter * 0.45);
    return t;
  }

  function moistureAt(world, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (!inBounds(xi, yi)) return 0;
    return world.moisture[idx(xi, yi)];
  }
  function foodAt(world, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (!inBounds(xi, yi)) return 0;
    return world.food[idx(xi, yi)];
  }
  function regionAt(world, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (!inBounds(xi, yi)) return world.regions[0];
    return world.regions[world.regionId[idx(xi, yi)]] || world.regions[0];
  }

  function consumeFood(world, x, y, amount) {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (!inBounds(xi, yi)) return 0;
    const i = idx(xi, yi);
    const taken = Math.min(world.food[i], amount);
    world.food[i] -= taken;
    return taken;
  }

  /* Regrowth runs on a rolling cursor rather than a full 65k sweep, so cost
   * per call is bounded. Rate is scaled by the current climate so a drought
   * genuinely starves the map. */
  function tickFood(world, batchSize) {
    const n = world.food.length;
    const growth = world.growthScale == null ? 1 : world.growthScale;
    let c = world.foodCursor;
    for (let k = 0; k < batchSize; k++) {
      const i = c;
      const cap = world.foodCap[i];
      if (cap > 0) {
        const rate = CM.flora.regrowthRate(world.flora[i]) * growth;
        world.food[i] += (cap - world.food[i]) * rate;
        if (world.food[i] < 0.01) world.food[i] = 0;
        else if (world.food[i] > cap) world.food[i] = cap;
      }
      c = (c + 1) % n;
    }
    world.foodCursor = c;
  }

  /* avoidDefended: skip toxic/thorned species. Animals do not graze poison
   * when there is anything else going, and without this a colony that spawns
   * in a bitterleaf forest quietly poisons itself to death while its hunger
   * and thirst read perfectly normal — which is indistinguishable, from the
   * outside, from a bug. Desperation overrides it (see the caller), so the
   * defended plants still matter; they are just no longer a silent trap. */
  function findNearestFood(world, x, y, radius, minAmount, avoidDefended) {
    const xi = Math.floor(x), yi = Math.floor(y);
    let best = null, bestD = Infinity;
    let fallback = null, fallbackD = Infinity;
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = xi + dx, ny = yi + dy;
        if (!inBounds(nx, ny)) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > radius * radius) continue;
        const i = idx(nx, ny);
        if (world.food[i] < minAmount) continue;
        const defended = avoidDefended && CM.flora.isDefended(world.flora[i]);
        if (defended) {
          if (d2 < fallbackD) { fallbackD = d2; fallback = { x: nx + 0.5, y: ny + 0.5, amount: world.food[i], flora: world.flora[i] }; }
          continue;
        }
        if (d2 < bestD) { bestD = d2; best = { x: nx + 0.5, y: ny + 0.5, amount: world.food[i], flora: world.flora[i] }; }
      }
    }
    // Nothing safe within reach: a defended plant beats starving.
    return best || fallback;
  }

  /* Nearest-water is a multi-source BFS computed once at generation, storing
   * the index of the closest water cell for every cell on the map.
   *
   * It was previously a live radial scan, and because the thirst search
   * widens with desperation it reached a 77x77 sweep per thirsty organism per
   * decision — 46% of total simulation time, measured. Water is static
   * terrain, so paying for it once at load turns the query into a lookup. */
  /* 8SSEDT (Danielsson): two sweeps propagating the *vector* to the nearest
   * water cell, comparing true squared distance at every step.
   *
   * A plain 8-connected BFS was tried first and is wrong in a way that
   * matters: it spreads by hop count, i.e. Chebyshev distance, so a cell
   * whose real nearest water lies along a diagonal gets pointed at a
   * different source entirely. Measured against brute force it overshot by
   * up to 10 cells on a 34-cell true distance — a 30% error, paid by exactly
   * the organism least able to afford it, the one already dying of thirst.
   * This version's error against brute force is zero on the same sample. */
  function buildWaterField(world) {
    const n = SIZE * SIZE;
    const FAR = 30000;
    const dx = new Int16Array(n).fill(FAR);
    const dy = new Int16Array(n).fill(FAR);

    for (let i = 0; i < n; i++) {
      if (isWaterBiome(world.biome[i])) { dx[i] = 0; dy[i] = 0; }
    }

    const d2 = i => {
      const a = dx[i], b = dy[i];
      return a >= FAR || b >= FAR ? Infinity : a * a + b * b;
    };
    function relax(i, j, sx, sy) {
      if (dx[j] >= FAR) return;
      const nx = dx[j] + sx, ny = dy[j] + sy;
      if (nx * nx + ny * ny < d2(i)) { dx[i] = nx; dy[i] = ny; }
    }

    // forward sweep: from the top-left
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = idx(x, y);
        if (y > 0) relax(i, i - SIZE, 0, 1);
        if (x > 0) relax(i, i - 1, 1, 0);
        if (x > 0 && y > 0) relax(i, i - SIZE - 1, 1, 1);
        if (x < SIZE - 1 && y > 0) relax(i, i - SIZE + 1, -1, 1);
      }
      for (let x = SIZE - 2; x >= 0; x--) relax(idx(x, y), idx(x + 1, y), -1, 0);
    }
    // backward sweep: from the bottom-right
    for (let y = SIZE - 1; y >= 0; y--) {
      for (let x = SIZE - 1; x >= 0; x--) {
        const i = idx(x, y);
        if (y < SIZE - 1) relax(i, i + SIZE, 0, -1);
        if (x < SIZE - 1) relax(i, i + 1, -1, 0);
        if (x < SIZE - 1 && y < SIZE - 1) relax(i, i + SIZE + 1, -1, -1);
        if (x > 0 && y < SIZE - 1) relax(i, i + SIZE - 1, 1, -1);
      }
      for (let x = 1; x < SIZE; x++) relax(idx(x, y), idx(x - 1, y), 1, 0);
    }

    // Collapse the vectors into the source cell index each one points at.
    const nearest = new Int32Array(n).fill(-1);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = idx(x, y);
        if (dx[i] >= FAR) continue;
        const sx = x - dx[i], sy = y - dy[i];
        if (sx >= 0 && sy >= 0 && sx < SIZE && sy < SIZE) nearest[i] = idx(sx, sy);
      }
    }
    world.nearestWater = nearest;
  }

  function findNearestWater(world, x, y, radius) {
    const xi = K.clamp(Math.floor(x), 0, SIZE - 1), yi = K.clamp(Math.floor(y), 0, SIZE - 1);
    const field = world.nearestWater;
    if (!field) return null;
    const src = field[idx(xi, yi)];
    if (src < 0) return null;                       // a map with no water at all
    const wx = (src % SIZE) + 0.5, wy = ((src / SIZE) | 0) + 0.5;
    return K.dist(x, y, wx, wy) <= radius ? { x: wx, y: wy } : null;
  }

  /* Deposits are concentrated biomass — worth far more than grazing, finite,
   * and slow to recover, which is what makes them worth fighting over rather
   * than merely worth visiting. */
  const DEPOSIT_REACH = 2.2;
  function findNearestDeposit(world, x, y, radius) {
    let best = null, bestD = radius * radius;
    for (const d of world.deposits) {
      if (d.remaining <= 1) continue;
      const dd = K.dist2(d.x, d.y, x, y);
      if (dd < bestD) { bestD = dd; best = d; }
    }
    return best;
  }
  function harvestDeposit(deposit, amount) {
    const taken = Math.min(deposit.remaining, amount);
    deposit.remaining -= taken;
    return taken;
  }
  /* Regrowth is slow enough that a stripped deposit stays stripped for a
   * meaningful stretch, so exhausting one has consequences. */
  function tickDeposits(world, dt) {
    for (const d of world.deposits) {
      if (d.remaining < d.richness) d.remaining = Math.min(d.richness, d.remaining + d.richness * 0.004 * dt);
    }
  }

  function atWaterEdge(world, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = xi + dx, ny = yi + dy;
        if (inBounds(nx, ny) && isWaterBiome(world.biome[idx(nx, ny)])) return true;
      }
    }
    return false;
  }

  // --- uniform spatial grid for organisms / samples -------------------------
  function makeSpatialGrid(worldSize, cellSize) {
    const cols = Math.ceil(worldSize / cellSize);
    const buckets = new Map();
    const key = (cx, cy) => cx * 100000 + cy;

    function bucketOf(x, y) { return [Math.floor(x / cellSize), Math.floor(y / cellSize)]; }
    function insert(entity) {
      const [cx, cy] = bucketOf(entity.x, entity.y);
      entity.__gx = cx; entity.__gy = cy;
      const k = key(cx, cy);
      let b = buckets.get(k);
      if (!b) { b = new Set(); buckets.set(k, b); }
      b.add(entity);
    }
    function remove(entity) {
      const k = key(entity.__gx, entity.__gy);
      const b = buckets.get(k);
      if (b) { b.delete(entity); if (b.size === 0) buckets.delete(k); }
    }
    function update(entity) {
      const [cx, cy] = bucketOf(entity.x, entity.y);
      if (cx === entity.__gx && cy === entity.__gy) return;
      remove(entity);
      insert(entity);
    }
    function queryRadius(x, y, radius, out) {
      out = out || [];
      const r = Math.ceil(radius / cellSize);
      const [cx, cy] = bucketOf(x, y);
      const r2 = radius * radius;
      for (let gy = cy - r; gy <= cy + r; gy++) {
        for (let gx = cx - r; gx <= cx + r; gx++) {
          const b = buckets.get(key(gx, gy));
          if (!b) continue;
          for (const e of b) if (K.dist2(e.x, e.y, x, y) <= r2) out.push(e);
        }
      }
      return out;
    }
    function queryBox(minX, minY, maxX, maxY, out) {
      out = out || [];
      const [cx0, cy0] = bucketOf(minX, minY);
      const [cx1, cy1] = bucketOf(maxX, maxY);
      for (let gy = cy0; gy <= cy1; gy++) {
        for (let gx = cx0; gx <= cx1; gx++) {
          const b = buckets.get(key(gx, gy));
          if (!b) continue;
          for (const e of b) out.push(e);
        }
      }
      return out;
    }
    function clear() { buckets.clear(); }
    return { cellSize, insert, remove, update, queryRadius, queryBox, clear };
  }

  CM.world = {
    SIZE, BIOME, BIOME_INFO, BIOME_NAMES, HAZARD, HAZARD_INFO, idx, inBounds,
    generate, classify, findColonySite,
    biomeAt, biomeInfoAt, isWaterBiome, isWaterAt, moveCostAt, hazardAt,
    tempAt, moistureAt, foodAt, regionAt, consumeFood, tickFood,
    findNearestFood, findNearestWater, findNearestDeposit, harvestDeposit, tickDeposits,
    DEPOSIT_REACH, atWaterEdge, makeSpatialGrid
  };
})(window.CM = window.CM || {});
