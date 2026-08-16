/* Coremind — local persistence. Terrain is never saved (it's fully
 * regenerable from the seed); everything the player actually changed is:
 * discovered species/traits, designs, every living organism, and the
 * Core's resources. Autosaves are throttled but triggered eagerly on
 * anything narratively "major" so closing the app never loses progress.
 */
(function (CM) {
  'use strict';
  const KEY = 'coremind/save/v1';
  /* v2 adds colonies, climate and flora knowledge. A v1 save has no rivals
   * recorded, so rather than refuse it we load it and let createAll() seed a
   * fresh set — the player keeps their discoveries and organisms, and the
   * world simply acquires neighbours. Losing a campaign to a schema bump is
   * never worth the tidiness. */
  /* v3 adds the world's mutable features. The terrain is regenerable from the
   * seed, but what the player has *done* to it is not: a stripped deposit came
   * back full and a found vein came back unknown, so reloading quietly undid
   * an hour of prospecting and harvesting. Old saves still load — they simply
   * arrive with untouched deposits, which is what they already did. */
  const VERSION = 3;
  const MIN_LOADABLE = 1;
  const MIN_SAVE_INTERVAL_MS = 5000;
  const PERIODIC_MS = 20000;

  function hasSave() {
    try { return !!localStorage.getItem(KEY); } catch (e) { return false; }
  }

  function serialize(game) {
    return {
      v: VERSION, savedAt: Date.now(),
      seed: game.seed, simTime: game.simTime, speed: game.speed,
      core: { biomass: game.core.biomass, energy: game.core.energy },
      climate: game.climate,
      structures: CM.structures.serialize(game),
      /* Only the fields play changes. Positions and richness come back off the
       * seed, so there is no point writing them to storage every 20 seconds. */
      world: {
        deposits: game.world.deposits.map(d => ({ id: d.id, remaining: d.remaining, claimedBy: d.claimedBy || null })),
        veins: (game.world.veins || []).map(v => ({ id: v.id, remaining: v.remaining, known: !!v.known, claimedBy: v.claimedBy || null }))
      },
      colonies: game.colonies.map(c => ({
        id: c.id, name: c.name, isPlayer: c.isPlayer, x: c.x, y: c.y, color: c.color,
        strategyKey: c.strategyKey, alive: c.alive, integrity: c.integrity,
        biomass: c.biomass, energy: c.energy,
        observations: c.observations, discovered: c.discovered,
        currentDesign: c.currentDesign, designGeneration: c.designGeneration,
        losses: c.losses, kills: c.kills, deployed: c.deployed, standing: c.standing
      })),
      camera: { x: game.camera.x, y: game.camera.y, zoom: game.camera.zoom },
      discovery: {
        observations: game.discovery.observations,
        discoveredTraits: game.discovery.discoveredTraits,
        knownSpecies: game.discovery.knownSpecies,
        events: game.discovery.events.slice(0, 150),
        samples: game.discovery.samples,
        knownFlora: game.discovery.knownFlora || {}
      },
      designs: game.designs,
      nextDesignId: game.nextDesignId,
      organisms: game.organisms.map(o => ({
        ownerId: o.ownerId, speciesId: o.speciesId, designId: o.designId, name: o.name,
        generation: o.generation, age: o.age, x: o.x, y: o.y, heading: o.heading,
        traits: o.traits, diet: o.diet, color: o.color,
        health: o.health, energy: o.energy, hunger: o.hunger, thirst: o.thirst,
        state: o.state, directive: o.directive, carrying: o.carrying, reproCooldown: o.reproCooldown,
        // Burrow state is deliberately not saved: reloading into "underground
        // and untargetable" would be an invisible, unexplainable condition.
        // Everything reloads above ground.
      }))
    };
  }

  function writeNow(game) {
    try {
      localStorage.setItem(KEY, JSON.stringify(serialize(game)));
      game.__lastSaveAt = performance.now();
      return true;
    } catch (e) {
      console.warn('[coremind] save failed', e);
      return false;
    }
  }

  function readRaw() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !(data.v >= MIN_LOADABLE && data.v <= VERSION)) return null;
      return data;
    } catch (e) {
      console.warn('[coremind] read failed', e);
      return null;
    }
  }

  /* Rebuild a full game object: regenerate the world from the seed, then
   * overlay everything that isn't derivable from it. */
  function hydrate(data) {
    const game = CM.coremind.newGame(data.seed);
    game.simTime = data.simTime || 0;
    game.speed = data.speed || 1;

    if (data.climate) game.climate = data.climate;
    CM.climate.apply(game);
    CM.structures.hydrate(game, data.structures);

    // Overlay what play changed onto the freshly-generated features. Matched
    // by id rather than by index, so a change to how many deposits a world
    // gets cannot silently shuffle a save's harvest state onto the wrong ones.
    if (data.world) {
      const byId = {};
      for (const d of game.world.deposits) byId[d.id] = d;
      for (const saved of data.world.deposits || []) {
        const dep = byId[saved.id];
        if (!dep) continue;
        dep.remaining = saved.remaining;
        dep.claimedBy = saved.claimedBy || null;
      }
      const veinById = {};
      for (const v of (game.world.veins || [])) veinById[v.id] = v;
      for (const saved of data.world.veins || []) {
        const vein = veinById[saved.id];
        if (!vein) continue;
        vein.remaining = saved.remaining;
        vein.known = !!saved.known;
        vein.claimedBy = saved.claimedBy || null;
      }
    }

    /* Colonies are restored onto the objects createAll() just built, rather
     * than replacing the array: the Core positions come from the seed and are
     * already correct, and game.core has to keep pointing at the same object
     * the rest of the game holds a reference to. */
    if (data.colonies && data.colonies.length) {
      for (const saved of data.colonies) {
        const colony = game.coloniesById[saved.id];
        if (!colony) continue;
        Object.assign(colony, {
          name: saved.name, color: saved.color, strategyKey: saved.strategyKey,
          alive: saved.alive !== false, integrity: saved.integrity != null ? saved.integrity : 100,
          biomass: saved.biomass, energy: saved.energy,
          observations: saved.observations || {}, discovered: saved.discovered || {},
          currentDesign: saved.currentDesign || colony.currentDesign,
          designGeneration: saved.designGeneration || 1,
          losses: saved.losses || 0, kills: saved.kills || 0, deployed: saved.deployed || 0,
          standing: saved.standing || colony.standing
        });
        if (saved.x != null) { colony.x = saved.x; colony.y = saved.y; }
      }
    }
    game.core.biomass = data.core.biomass;
    game.core.energy = data.core.energy;
    if (data.camera) {
      game.camera.x = data.camera.x; game.camera.y = data.camera.y; game.camera.zoom = data.camera.zoom;
      game.camera.targetX = game.camera.x; game.camera.targetY = game.camera.y; game.camera.targetZoom = game.camera.zoom;
    }
    const disc = data.discovery || {};
    game.discovery.observations = disc.observations || {};
    game.discovery.discoveredTraits = disc.discoveredTraits || {};
    game.discovery.knownSpecies = disc.knownSpecies || {};
    game.discovery.events = disc.events || [];
    game.discovery.samples = disc.samples || [];
    game.discovery.knownFlora = disc.knownFlora || {};
    let maxEvtId = 0, maxSampleId = 0;
    for (const e of game.discovery.events) { const n = parseInt(String(e.id).split('_')[1], 10); if (n > maxEvtId) maxEvtId = n; }
    for (const s of game.discovery.samples) { const n = parseInt(String(s.id).split('_')[1], 10); if (n > maxSampleId) maxSampleId = n; }
    game.discovery.nextEventId = Math.max(maxEvtId, maxSampleId) + 1;

    game.designs = data.designs || [];
    game.nextDesignId = data.nextDesignId || 1;

    for (const od of data.organisms || []) {
      const org = CM.organism.create({
        ownerId: od.ownerId, speciesId: od.speciesId, designId: od.designId, name: od.name,
        generation: od.generation, x: od.x, y: od.y, heading: od.heading,
        traits: od.traits, diet: od.diet, color: od.color, directive: od.directive
      });
      org.age = od.age; org.health = od.health; org.energy = od.energy; org.hunger = od.hunger;
      org.thirst = od.thirst || 0;
      org.state = od.state; org.carrying = od.carrying || 0; org.reproCooldown = od.reproCooldown || 0;
      // A state saved mid-burrow (or from an older save) resumes above ground.
      if (org.state === 'SEEK_WATER' && !od.thirst) org.state = 'EXPLORE';
      CM.coremind.addOrganism(game, org);
    }
    return game;
  }

  /* Called on every notable event; only actually writes if the throttle
   * window has elapsed, so a burst of deaths/discoveries can't hammer
   * localStorage. */
  function maybeAutosave(game) {
    const now = performance.now();
    if (!game.__lastSaveAt || now - game.__lastSaveAt >= MIN_SAVE_INTERVAL_MS) writeNow(game);
  }

  function init(game, bus) {
    bus.on('event', evt => {
      if (evt.kind === 'discovery' || evt.kind === 'death' || evt.kind === 'system') maybeAutosave(game);
    });
  }

  CM.save = { hasSave, writeNow, readRaw, serialize, hydrate, maybeAutosave, init, PERIODIC_MS };
})(window.CM = window.CM || {});
