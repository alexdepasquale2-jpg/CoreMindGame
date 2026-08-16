/* Coremind — the underground. A colony's second body.
 *
 * Every chamber here answers a pressure the surface game already applies:
 * thirst inland, temperature extremes, predation, the Core's storage
 * ceiling, slow research. Nothing is a generic "+10% building" — if a
 * chamber did not solve a problem the player has actually felt, it would
 * just be a button.
 *
 * The network is modular and grows outward: a Shaft can be sunk anywhere,
 * and everything else must be placed within reach of something already
 * built. That is what makes an underground a *shape* the player designs
 * rather than a list of upgrades they buy.
 */
(function (CM) {
  'use strict';
  const K = CM.core;
  const W = CM.world;

  /* How far a new chamber may sit from the nearest existing one of the same
   * colony. Also the length of the tunnel drawn between them. */
  const LINK_RANGE = 14;
  const MIN_SPACING = 4.5;        // chambers cannot be stacked on each other
  const SHAFT_SPACING = 26;       // ...and independent shafts must be genuinely apart

  /* --- depth ---------------------------------------------------------------
   * The underground has three strata. Each is safer from the surface and
   * richer than the one above it, and each is harder to cut. Reaching the
   * abyssal layer is the game's long arc: you cannot jump to it, because a
   * chamber may only link to one within a single depth level of itself.
   *
   * Depth is what turns the underground from a set of upgrades into a
   * campaign — the deep tier is where the endgame lives. */
  const DEPTHS = [
    null,
    { level: 1, key: 'SHALLOW',  name: 'Shallow Works', rock: [116, 94, 70],  tempShift: 2,  tint: '#c69a63' },
    { level: 2, key: 'DEEP',     name: 'Deep Galleries', rock: [88, 78, 92],  tempShift: 8,  tint: '#a294c4' },
    { level: 3, key: 'ABYSSAL',  name: 'Abyssal Reach',  rock: [72, 54, 78],  tempShift: 22, tint: '#d07aa4' }
  ];
  const MAX_DEPTH = 3;

  const TYPES = {
    // -- depth 1: shallow works ------------------------------------------
    SHAFT: {
      key: 'SHAFT', name: 'Access Shaft', icon: '\u{1F573}', depth: 1,
      blurb: 'Sinks a new entrance. The only chamber that can be dug away from an existing network.',
      cost: { biomass: 24, energy: 14 }, work: 26, radius: 5,
      minDigging: 0, standalone: true
    },
    WARREN: {
      key: 'WARREN', name: 'Warren', icon: '\u{1F3E0}', depth: 1,
      blurb: 'Shelter. Organisms inside are hidden from predators and shielded from temperature extremes.',
      cost: { biomass: 30, energy: 18 }, work: 34, radius: 7,
      minDigging: 10, standalone: false
    },
    CISTERN: {
      key: 'CISTERN', name: 'Cistern', icon: '\u{1F4A7}', depth: 1,
      blurb: 'Taps groundwater. Organisms can drink here, which makes dry inland ground survivable.',
      cost: { biomass: 28, energy: 22 }, work: 40, radius: 6,
      minDigging: 14, standalone: false
    },
    GRANARY: {
      key: 'GRANARY', name: 'Granary', icon: '\u{1F33E}', depth: 1,
      blurb: 'Cold storage. Raises how much biomass the Core can hold.',
      cost: { biomass: 34, energy: 16 }, work: 38, radius: 6,
      storageBonus: 180,
      minDigging: 10, standalone: false
    },

    // -- depth 2: deep galleries -------------------------------------------
    DESCENT: {
      key: 'DESCENT', name: 'Descent', icon: '\u{2B07}', depth: 2,
      blurb: 'Cuts down into the deep galleries. Everything at this depth hangs off one.',
      cost: { biomass: 46, energy: 34 }, work: 62, radius: 6,
      minDigging: 22, standalone: false
    },
    NURSERY: {
      key: 'NURSERY', name: 'Nursery', icon: '\u{1F423}', depth: 2,
      blurb: 'Protected breeding. Organisms nearby recover and come off reproduction cooldown faster.',
      cost: { biomass: 36, energy: 20 }, work: 42, radius: 7,
      minDigging: 16, standalone: false
    },
    VAULT: {
      key: 'VAULT', name: 'Analysis Vault', icon: '\u{1F52C}', depth: 2,
      blurb: 'A buried laboratory. Speeds up how fast observations turn into discoveries.',
      cost: { biomass: 40, energy: 30 }, work: 48, radius: 9,
      researchBonus: 1.6,
      minDigging: 20, standalone: false
    },
    REDOUBT: {
      key: 'REDOUBT', name: 'Redoubt', icon: '\u{1F6E1}', depth: 2,
      blurb: 'A fortified bolt-hole. Organisms near it fight harder and the ground itself resists sieges.',
      cost: { biomass: 44, energy: 26 }, work: 52, radius: 8,
      defenseBonus: 0.45,
      minDigging: 24, standalone: false
    },
    FUNGARIUM: {
      key: 'FUNGARIUM', name: 'Fungarium', icon: '\u{1F344}', depth: 2,
      blurb: 'Cultivated fungus. Feeds organisms underground, so a colony can live without the surface.',
      cost: { biomass: 42, energy: 24 }, work: 50, radius: 7,
      feedsRate: 9,
      minDigging: 20, standalone: false
    },

    // -- depth 3: the abyssal reach — endgame ------------------------------
    GEOTHERMAL: {
      key: 'GEOTHERMAL', name: 'Geothermal Tap', icon: '\u{1F30B}', depth: 3,
      blurb: 'Draws heat from the deep rock. A large, permanent energy income.',
      cost: { biomass: 60, energy: 46 }, work: 84, radius: 8,
      energyRate: 3.2,
      minDigging: 30, standalone: false
    },
    VEINWORKS: {
      key: 'VEINWORKS', name: 'Veinworks', icon: '\u{26CF}', depth: 3,
      blurb: 'Mines an abyssal biomass vein. Must be cut directly onto one.',
      cost: { biomass: 66, energy: 40 }, work: 96, radius: 7,
      requiresVein: true,
      minDigging: 34, standalone: false
    },
    SANCTUM: {
      key: 'SANCTUM', name: 'Deep Sanctum', icon: '\u{1F52E}', depth: 3,
      blurb: 'A second seat for the Coremind, buried beyond reach. Completing one secures the colony permanently.',
      cost: { biomass: 140, energy: 120 }, work: 190, radius: 10,
      endgame: true,
      minDigging: 40, standalone: false
    }
  };
  const TYPE_KEYS = Object.keys(TYPES);

  function newState() {
    return { list: [], nextId: 1 };
  }

  function all(game) { return game.structures ? game.structures.list : []; }
  function ofColony(game, colonyId) { return all(game).filter(s => s.colonyId === colonyId); }
  function completed(game, colonyId) { return all(game).filter(s => s.colonyId === colonyId && s.done); }

  /* Can this colony put `typeKey` at (x,y)? Returns {ok, reason, linkTo}.
   * The reason strings are shown directly in the build UI — a refusal the
   * player cannot interpret is worse than no refusal at all. */
  function canPlace(game, colony, typeKey, x, y) {
    const type = TYPES[typeKey];
    if (!type) return { ok: false, reason: 'Unknown chamber.' };
    if (!colony || !colony.alive) return { ok: false, reason: 'No Coremind to build it.' };

    if (x < 2 || y < 2 || x > game.world.size - 2 || y > game.world.size - 2) {
      return { ok: false, reason: 'Outside the world.' };
    }
    if (W.isWaterAt(game.world, x, y)) return { ok: false, reason: 'Cannot dig under open water.' };
    const biome = W.biomeAt(game.world, x, y);
    if (biome === W.BIOME.MOUNTAIN) return { ok: false, reason: 'The rock here is too hard to cut.' };

    const depth = type.depth;
    const mine = ofColony(game, colony.id);
    // Spacing is per-depth: two chambers on different strata are not in each
    // other's way, which is what lets a network stack rather than sprawl.
    for (const s of mine) {
      if (s.depth === depth && K.dist(s.x, s.y, x, y) < MIN_SPACING) {
        return { ok: false, reason: 'Too close to an existing chamber on this level.' };
      }
    }

    // A vein chamber has to sit on an actual vein — the deep resource is a
    // place on the map, not a purchase.
    if (type.requiresVein) {
      const vein = nearestVein(game, x, y, VEIN_REACH);
      if (!vein) return { ok: false, reason: 'No abyssal vein here — find one first.' };
      if (vein.claimedBy && vein.claimedBy !== colony.id) return { ok: false, reason: 'That vein is already being worked.' };
    }

    if (type.standalone) {
      // A shaft may go anywhere, but not right beside another shaft — that is
      // what stops the network being a blob and makes expansion directional.
      for (const s of mine) {
        if (s.type === 'SHAFT' && K.dist(s.x, s.y, x, y) < SHAFT_SPACING) {
          return { ok: false, reason: 'Another shaft already serves this area.' };
        }
      }
      return { ok: true, linkTo: null };
    }

    /* Everything else must connect to a *finished* chamber within one depth
     * level of itself. That single rule is what makes depth a campaign: to
     * put anything in the abyssal reach you must already hold deep galleries
     * above it, and to hold those you need shallow works above them. */
    let linkTo = null, bestD = LINK_RANGE;
    let sawNearer = false;
    for (const s of mine) {
      if (!s.done) continue;
      const d = K.dist(s.x, s.y, x, y);
      if (d > LINK_RANGE) continue;
      sawNearer = true;
      if (Math.abs(s.depth - depth) > 1) continue;
      if (d <= bestD) { bestD = d; linkTo = s; }
    }
    if (!linkTo) {
      if (sawNearer) {
        const above = DEPTHS[depth - 1];
        return { ok: false, reason: `Nothing at a workable depth here — cut ${above ? above.name.toLowerCase() : 'shallower works'} first.` };
      }
      return { ok: false, reason: 'Must connect to a finished chamber — sink a shaft first.' };
    }
    return { ok: true, linkTo };
  }

  /* --- abyssal veins --------------------------------------------------------
   * Buried biomass seams, placed at world generation and only findable by
   * digging. They are the reason to go deep at all, and being fixed points on
   * the map means the deep tier is contested ground rather than a menu. */
  const VEIN_REACH = 3.2;
  function nearestVein(game, x, y, radius) {
    let best = null, bestD = radius;
    for (const v of (game.world.veins || [])) {
      const d = K.dist(v.x, v.y, x, y);
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }
  /* Veins are only revealed once a colony has dug deep nearby — until then
   * the player is prospecting, not shopping from a list. */
  function revealVeinsNear(game, x, y, radius) {
    let found = null;
    for (const v of (game.world.veins || [])) {
      if (v.known) continue;
      if (K.dist(v.x, v.y, x, y) <= radius) { v.known = true; found = v; }
    }
    return found;
  }

  function cost(typeKey) {
    const t = TYPES[typeKey];
    return t ? { biomass: t.cost.biomass, energy: t.cost.energy } : { biomass: 0, energy: 0 };
  }

  /* Queues a build site. Resources are spent up front, so a half-dug chamber
   * represents a real commitment the player can lose. */
  function queue(game, bus, colony, typeKey, x, y) {
    const check = canPlace(game, colony, typeKey, x, y);
    if (!check.ok) return { ok: false, reason: check.reason };
    const c = cost(typeKey);
    if (colony.biomass < c.biomass || colony.energy < c.energy) {
      return { ok: false, reason: 'Not enough biomass or energy.' };
    }
    colony.biomass -= c.biomass;
    colony.energy -= c.energy;

    const site = {
      id: 'st_' + (game.structures.nextId++),
      colonyId: colony.id,
      type: typeKey,
      x, y,
      depth: TYPES[typeKey].depth,
      work: 0,
      workNeeded: TYPES[typeKey].work,
      done: false,
      integrity: 100,
      linkId: check.linkTo ? check.linkTo.id : null
    };
    if (TYPES[typeKey].requiresVein) {
      const vein = nearestVein(game, x, y, VEIN_REACH);
      if (vein) { vein.claimedBy = colony.id; site.veinId = vein.id; }
    }
    game.structures.list.push(site);
    if (colony.isPlayer && bus) {
      CM.discovery.pushEvent(game, bus, {
        kind: 'system', icon: TYPES[typeKey].icon,
        message: `${TYPES[typeKey].name} marked for excavation.`,
        x, y, structureId: site.id
      });
    }
    return { ok: true, site };
  }

  /* Digging progress. Rate scales with the organism's digging stat, so the
   * trait is what makes a colony able to build at all — a colony with no
   * burrowers can queue chambers but will crawl through them. */
  function addWork(game, bus, site, org, dt) {
    if (site.done) return false;
    const rate = 0.5 + (org.stats.digging || 0) * 0.055;
    site.work += rate * dt;
    if (site.work < site.workNeeded) return false;
    site.done = true;
    site.work = site.workNeeded;
    const colony = game.coloniesById[site.colonyId];
    if (colony && colony.isPlayer && bus) {
      CM.discovery.pushEvent(game, bus, {
        kind: 'discovery', icon: TYPES[site.type].icon,
        message: `${TYPES[site.type].name} complete. ${TYPES[site.type].blurb}`,
        x: site.x, y: site.y, structureId: site.id
      });
    }
    /* Cutting deep is how veins are found. Prospecting is a *consequence* of
     * digging rather than a separate action, so the reward for pushing the
     * network downward arrives on its own — and the deeper the chamber, the
     * further through the rock the colony can sense. */
    if (site.depth >= 2) {
      const found = revealVeinsNear(game, site.x, site.y, 8 + site.depth * 7);
      if (found && colony && colony.isPlayer && bus) {
        CM.discovery.pushEvent(game, bus, {
          kind: 'discovery', icon: '\u{1F48E}',
          message: 'Abyssal vein struck. Cut a Veinworks onto it to work the seam.',
          x: found.x, y: found.y
        });
      }
    }
    return true;
  }

  /* How much the buried works themselves resist being chewed open. A redoubt
   * hardens the ground around it, which is what makes it worth putting one in
   * the middle of a network rather than at its edge. */
  function defenseAt(game, colonyId, x, y) {
    let bonus = 0;
    for (const s of all(game)) {
      if (!s.done || s.colonyId !== colonyId) continue;
      const type = TYPES[s.type];
      if (!type.defenseBonus) continue;
      if (K.dist(s.x, s.y, x, y) <= type.radius * 1.5) bonus += type.defenseBonus;
    }
    return bonus;
  }

  function nearestSite(game, colonyId, x, y, maxDist) {
    let best = null, bestD = maxDist || Infinity;
    for (const s of all(game)) {
      if (s.done || s.colonyId !== colonyId) continue;
      const d = K.dist(s.x, s.y, x, y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /* --- effects -------------------------------------------------------------
   * Queried by the simulation. Each is a plain lookup over finished chambers
   * of the right type in range, so a chamber's benefit is always tied to
   * *where* the player chose to put it. */
  function nearestOfType(game, colonyId, typeKey, x, y) {
    let best = null, bestD = Infinity;
    for (const s of all(game)) {
      if (!s.done || s.type !== typeKey || s.colonyId !== colonyId) continue;
      const d = K.dist(s.x, s.y, x, y);
      if (d < bestD && d <= TYPES[typeKey].radius) { bestD = d; best = s; }
    }
    return best;
  }

  /* Is there a chamber this organism could walk to for shelter? Kept separate
   * from the effect-radius lookups above: searching within a chamber's *effect*
   * radius meant an organism only recognised a warren once it was already
   * standing in one, so the SHELTER order could never move anybody. */
  function findShelter(game, colonyId, x, y, searchRadius) {
    let best = null, bestD = searchRadius;
    for (const s of all(game)) {
      if (!s.done || s.colonyId !== colonyId) continue;
      if (s.type !== 'WARREN' && s.type !== 'REDOUBT') continue;
      const d = K.dist(s.x, s.y, x, y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }
  function nurseryAt(game, org) { return nearestOfType(game, org.ownerId, 'NURSERY', org.x, org.y); }

  function findNearestCistern(game, colonyId, x, y, radius) {
    let best = null, bestD = radius;
    for (const s of all(game)) {
      if (!s.done || s.type !== 'CISTERN' || s.colonyId !== colonyId) continue;
      const d = K.dist(s.x, s.y, x, y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /* Fungus feeds whoever stands in it. This is the chamber that severs a
   * colony from the surface: with one, organisms no longer have to walk out
   * into the weather and the predators to eat, which is the precondition for
   * living in the abyssal reach at all. */
  function fungariumFeed(game, org) {
    const f = nearestOfType(game, org.ownerId, 'FUNGARIUM', org.x, org.y);
    return f ? TYPES.FUNGARIUM.feedsRate : 0;
  }

  /* Everything a colony's finished chambers pay out per second, gathered in
   * one pass so the simulation does not walk the list once per effect. */
  function colonyIncome(game, colonyId) {
    let biomass = 0, energy = 0;
    for (const s of all(game)) {
      if (!s.done || s.colonyId !== colonyId) continue;
      const type = TYPES[s.type];
      if (type.energyRate) energy += type.energyRate;
      if (type.requiresVein && s.veinId) {
        const vein = (game.world.veins || []).find(v => v.id === s.veinId);
        if (vein && vein.remaining > 0) {
          // A vein is finite: the abyssal economy is a windfall to be used,
          // not a permanent fountain.
          const rate = 2.4;
          biomass += rate;
          vein.remaining = Math.max(0, vein.remaining - rate);
        }
      }
    }
    return { biomass, energy };
  }

  function hasSanctum(game, colonyId) {
    return all(game).some(s => s.done && s.colonyId === colonyId && TYPES[s.type].endgame);
  }
  function sanctumProgress(game, colonyId) {
    let best = 0;
    for (const s of all(game)) {
      if (s.colonyId !== colonyId || !TYPES[s.type].endgame) continue;
      best = Math.max(best, s.done ? 1 : s.work / s.workNeeded);
    }
    return best;
  }

  function deepestOf(game, colonyId) {
    let d = 0;
    for (const s of all(game)) if (s.done && s.colonyId === colonyId && s.depth > d) d = s.depth;
    return d;
  }

  function storageBonus(game, colonyId) {
    let bonus = 0;
    for (const s of all(game)) {
      if (s.done && s.colonyId === colonyId && TYPES[s.type].storageBonus) bonus += TYPES[s.type].storageBonus;
    }
    return bonus;
  }

  /* Research multiplier from vaults covering the observing organism. */
  function researchMultiplier(game, org) {
    const vault = nearestOfType(game, org.ownerId, 'VAULT', org.x, org.y);
    return vault ? TYPES.VAULT.researchBonus : 1;
  }

  /* Where a colony should dig next if it is expanding on its own. Picks a
   * point at the edge of the current network, biased toward ground the
   * colony actually wants: water for cisterns, open land otherwise. */
  function suggestExpansion(game, colony) {
    const mine = completed(game, colony.id);
    if (!mine.length) {
      // No network yet: the first thing is always a shaft near the Core.
      for (let i = 0; i < 24; i++) {
        const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 8;
        const x = colony.x + Math.cos(a) * r, y = colony.y + Math.sin(a) * r;
        if (canPlace(game, colony, 'SHAFT', x, y).ok) return { typeKey: 'SHAFT', x, y };
      }
      return null;
    }
    const anchor = mine[Math.floor(Math.random() * mine.length)];
    const wanted = pickWantedType(game, colony);
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2, r = MIN_SPACING + Math.random() * (LINK_RANGE - MIN_SPACING);
      const x = anchor.x + Math.cos(a) * r, y = anchor.y + Math.sin(a) * r;
      if (canPlace(game, colony, wanted, x, y).ok) return { typeKey: wanted, x, y };
    }
    return null;
  }

  /* What this colony is short of. Deliberately reads live state rather than
   * a fixed build order, so an inland colony digs cisterns and a besieged
   * one digs redoubts. */
  function pickWantedType(game, colony) {
    const have = {};
    for (const s of completed(game, colony.id)) have[s.type] = (have[s.type] || 0) + 1;
    const deepest = deepestOf(game, colony.id);

    // Shallow needs first — a colony that cannot drink has no business
    // sinking a descent.
    const dry = !W.findNearestWater(game.world, colony.x, colony.y, 30);
    if (dry && !have.CISTERN) return 'CISTERN';
    if (!have.WARREN) return 'WARREN';
    if (colony.biomass >= colony.biomassCap * 0.95 && !have.GRANARY) return 'GRANARY';

    // Then downward, one stratum at a time.
    if (deepest >= 1 && !have.DESCENT) return 'DESCENT';
    if (deepest >= 2) {
      if (colony.losses > 6 && !have.REDOUBT) return 'REDOUBT';
      if (!have.NURSERY) return 'NURSERY';
      if (!have.FUNGARIUM) return 'FUNGARIUM';
      if (!have.VAULT) return 'VAULT';
      if (!have.GEOTHERMAL) return 'GEOTHERMAL';
      if (nearestVein(game, colony.x, colony.y, 40)) return 'VEINWORKS';
    }
    if (deepest >= 3 && !have.SANCTUM && colony.biomass > 150) return 'SANCTUM';

    const pool = deepest >= 2
      ? ['WARREN', 'CISTERN', 'GRANARY', 'NURSERY', 'REDOUBT', 'FUNGARIUM']
      : ['WARREN', 'CISTERN', 'GRANARY'];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function destroy(game, site) {
    const i = game.structures.list.indexOf(site);
    if (i >= 0) game.structures.list.splice(i, 1);
    // Anything that hung off it is orphaned rather than silently kept alive:
    // a network severed above ground does not keep working below it.
    for (const s of all(game)) if (s.linkId === site.id) s.linkId = null;
    if (site.veinId) {
      const vein = (game.world.veins || []).find(v => v.id === site.veinId);
      if (vein) vein.claimedBy = null;
    }
  }

  function removeStructuresOf(game, colonyId) {
    game.structures.list = all(game).filter(s => s.colonyId !== colonyId);
  }

  function serialize(game) {
    return { nextId: game.structures.nextId, list: all(game).map(s => Object.assign({}, s)) };
  }
  function hydrate(game, data) {
    game.structures = newState();
    if (!data) return;
    game.structures.nextId = data.nextId || 1;
    game.structures.list = (data.list || []).map(s => Object.assign({}, s));
  }

  CM.structures = {
    TYPES, TYPE_KEYS, LINK_RANGE, MIN_SPACING,
    newState, all, ofColony, completed, canPlace, cost, queue, addWork, nearestSite,
    DEPTHS, MAX_DEPTH, VEIN_REACH, nearestVein, revealVeinsNear,
    findShelter, nurseryAt, fungariumFeed, findNearestCistern, defenseAt,
    colonyIncome, hasSanctum, sanctumProgress, deepestOf,
    storageBonus, researchMultiplier, suggestExpansion, pickWantedType,
    destroy, removeStructuresOf, serialize, hydrate
  };
})(window.CM = window.CM || {});
