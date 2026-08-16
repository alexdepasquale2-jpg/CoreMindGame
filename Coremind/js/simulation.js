/* Coremind — the simulation: ties world + organisms + ai together into one
 * fixed-step tick. Runs at a modest fixed rate (see main.js) independent of
 * render framerate, with LOD bands so cost stays bounded regardless of how
 * many organisms are alive.
 */
(function (CM) {
  'use strict';
  const K = CM.core;
  const W = CM.world;
  const O = CM.organism;
  const T = CM.traits;
  const D = CM.discovery;
  const S = O.AI_STATE;

  const MAX_ACTIVE = 500;
  const NEAR_R = 45, MID_R = 115;
  const SPEED_DIV = 9;             // stat speed -> cells/sec
  const ARRIVE_DIST = 0.65;
  const ATTACK_RANGE = 1.35;
  const ATTACK_LEASH = 2.4;
  const HUNT_GIVEUP = 12;
  const MAX_CARRY = 22;
  const PREY_TARGET = 70, PRED_TARGET = 22, MIN_PREY_FOR_PRED = 14;
  const WILD_CAP = 380;
  const PLAYER_REPRO_SOFT_CAP = 60;
  const WATER_SPEED_MUL = 0.4;
  const DRINK_DIST = 1.6;
  const BURROW_DURATION = 4.5, BURROW_COOLDOWN = 14;
  const UPKEEP_BASE = 0.022, UPKEEP_PER_TRAIT = 0.006;   // biomass/sec per organism
  const DIG_REACH = 1.4;

  // -- population seeding ---------------------------------------------------
  function randomLandSpot(world, minDistFromCore, maxTries) {
    for (let i = 0; i < maxTries; i++) {
      const x = Math.random() * world.size, y = Math.random() * world.size;
      const b = W.biomeAt(world, x, y);
      if (W.isWaterBiome(b) || b === W.BIOME.MOUNTAIN || b === W.BIOME.ICE) continue;
      if (minDistFromCore && K.dist(x, y, world.coreSpawn.x, world.coreSpawn.y) < minDistFromCore) continue;
      return { x, y };
    }
    return { x: world.coreSpawn.x + (Math.random() - 0.5) * 20, y: world.coreSpawn.y + (Math.random() - 0.5) * 20 };
  }

  function spawnWildOne(game, speciesId, spot) {
    const sp = T.WILD_BY_ID[speciesId];
    const org = O.create({
      ownerId: 'wild', speciesId, name: sp.name, x: spot.x, y: spot.y,
      traits: sp.traits, diet: sp.diet, color: sp.color, directive: null
    });
    CM.coremind.addOrganism(game, org);
    return org;
  }

  function spawnStarterWildlife(game) {
    const preySpecies = T.WILD_SPECIES.filter(s => s.tier === 'prey').map(s => s.id);
    const predSpecies = T.WILD_SPECIES.filter(s => s.tier === 'predator').map(s => s.id);
    for (let i = 0; i < 40; i++) {
      spawnWildOne(game, K.pick(Math.random, preySpecies), randomLandSpot(game.world, 12, 60));
    }
    for (let i = 0; i < 10; i++) {
      spawnWildOne(game, K.pick(Math.random, predSpecies), randomLandSpot(game.world, 25, 60));
    }
  }

  function spawnStarterColony(game, bus) {
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 2;
      const org = O.create({
        ownerId: 'player', traits: [], name: 'Scout-' + (i + 1),
        x: game.core.x + Math.cos(a) * r, y: game.core.y + Math.sin(a) * r,
        directive: game.globalDirective
      });
      CM.coremind.addOrganism(game, org);
    }
    D.pushEvent(game, bus, { kind: 'system', icon: '\u{1F4E1}', message: 'Coremind established. Three starter organisms are ready for a directive.', x: game.core.x, y: game.core.y });
  }

  // -- sensing ----------------------------------------------------------------
  /* Every predicate below is colony-relative rather than player-vs-wild.
   * "Mine" means the same colony; everything else is either prey, a rival, or
   * scenery, and the player's colony gets no special case in any of it. */
  const WILD = 'wild';
  function isWild(org) { return org.ownerId === WILD; }
  function sameColony(a, b) { return a.ownerId === b.ownerId && !isWild(a); }

  function isPredatorLike(org) {
    if (isWild(org)) return T.WILD_BY_ID[org.speciesId].diet === 'carnivore';
    return org.directive === 'HUNT' || org.directive === 'DEFEND';
  }
  function validHuntTarget(hunter, other, game) {
    if (sameColony(hunter, other)) return false;          // never eat your own
    if (isWild(hunter)) {
      if (!isWild(other)) return true;                    // any colonial organism is meat
      return T.WILD_BY_ID[other.speciesId].tier === 'prey';
    }
    if (isWild(other)) return true;                       // wild game is always fair
    /* Another colony's organisms are only prey once relations have actually
     * soured. Without this every colony attacks every other on sight from the
     * first contact, and standing — the whole point of tracking who has
     * wronged whom — never gets to mean anything. */
    return !game || CM.colony.areHostile(game, hunter.ownerId, other.ownerId);
  }
  function isThreatTo(org, other, game) {
    if (sameColony(org, other)) return false;
    if (!isWild(org)) {
      // Wild carnivores are always a threat; a rival's organisms are a threat
      // when they are postured to fight, or whenever the two colonies have
      // fallen into open hostility.
      if (isWild(other)) return T.WILD_BY_ID[other.speciesId].diet === 'carnivore';
      if (game && CM.colony.areHostile(game, org.ownerId, other.ownerId)) return true;
      return other.directive === 'HUNT' || other.directive === 'DEFEND';
    }
    if (T.WILD_BY_ID[org.speciesId].tier === 'prey') {
      return (isWild(other) && T.WILD_BY_ID[other.speciesId].diet === 'carnivore')
        || (!isWild(other) && other.directive === 'HUNT');
    }
    return false;
  }
  /* Camouflage/burrowing probabilistically keep an organism off a sensing
   * organism's radar — a mechanical payoff for those traits, not just flavour. */
  function isDetected(watcher, target) {
    if (target.burrowed) return false; // underground and out of play
    if (target.sheltered) return false; // inside a warren, and out of reach
    // Chemical sensing tracks a scent trail, which visual concealment does
    // nothing about — the counter that makes camouflage a choice, not a
    // strictly-correct default.
    if (watcher.behaviors.has('sense_through_walls')) return true;
    const cam = target.behaviors.has('reduce_detection') ? (target.stats.camouflage || 0) : 0;
    if (cam <= 0) return true;
    return Math.random() > cam / 140;
  }

  function gatherContext(game, org) {
    // Vibration sensing reaches further for *threats* specifically: it feels
    // footfalls through the ground rather than perceiving the whole scene.
    const senseR = org.stats.sense_radius;
    const threatR = org.behaviors.has('early_warning') ? senseR * 1.5 : senseR;
    const near = game.world.grid.queryRadius(org.x, org.y, Math.max(senseR, threatR), []);
    let nearestThreat = null, nearestPrey = null, nearestCuriosity = null;
    let bestThreatD = Infinity, bestPreyD = Infinity, bestCurD = Infinity;
    const newSightings = [];
    // Only the player's organisms feed the research ledger, so only they pay
    // for collecting the list.
    const observable = org.ownerId === CM.colony.PLAYER_ID ? [] : null;

    for (const other of near) {
      if (other === org || !O.isAlive(other)) continue;
      const d = K.dist(org.x, org.y, other.x, other.y);
      if (!isDetected(org, other)) continue;

      if (d <= threatR && isThreatTo(org, other, game) && d < bestThreatD) { bestThreatD = d; nearestThreat = { dist: d, entity: other }; }
      if (d <= senseR && validHuntTarget(org, other, game) && d < bestPreyD) {
        const canHuntNow = isPredatorLike(org);
        if (canHuntNow) { bestPreyD = d; nearestPrey = { dist: d, entity: other }; }
      }
      if (d <= senseR && isWild(other)) {
        if (!game.discovery.knownSpecies[other.speciesId]) newSightings.push({ speciesId: other.speciesId, x: other.x, y: other.y });
        if (observable) observable.push(other);
      }
    }

    for (const sample of game.discovery.samples) {
      const d = K.dist(org.x, org.y, sample.x, sample.y);
      if (d <= senseR && d < bestCurD) { bestCurD = d; nearestCuriosity = { dist: d, x: sample.x, y: sample.y, ref: sample }; }
    }

    const canEatPlants = org.diet !== 'carnivore';
    const canHunt = isPredatorLike(org);
    // Only a genuinely hungry organism will touch defended forage.
    const desperate = org.hunger > 78;
    let nearestFood = canEatPlants ? W.findNearestFood(game.world, org.x, org.y, senseR, 4, !desperate) : null;
    /* A gatherer prefers a deposit to grazing when one is in reach: it is
     * worth several times as much biomass to the Core, which is exactly why
     * deposits are worth contesting. Hunger is still served by ordinary
     * forage — a starving organism eats what is nearest. */
    let depositTarget = null;
    if (!isWild(org) && org.directive === 'GATHER' && org.hunger < 70) {
      depositTarget = W.findNearestDeposit(game.world, org.x, org.y, senseR * 2.2);
      if (depositTarget) nearestFood = { x: depositTarget.x, y: depositTarget.y, amount: depositTarget.remaining, deposit: depositTarget };
    }
    // Water is only looked up when the organism actually cares — this is a
    // grid scan, and running it for every organism every decision would cost
    // far more than the thirst system is worth.
    // Search range widens with thirst: a desperate animal ranges much further
    // for water than a comfortable one bothers to.
    let nearestWater = null;
    if (org.thirst > 25) {
      const reach = senseR * (1.6 + K.clamp01(org.thirst / 100) * 2.6);
      nearestWater = W.findNearestWater(game.world, org.x, org.y, reach);
      /* A cistern is water as far as thirst is concerned, and being closer
       * than the nearest lake is the entire reason to dig one. */
      if (!isWild(org)) {
        const cistern = CM.structures.findNearestCistern(game, org.ownerId, org.x, org.y, reach);
        if (cistern && (!nearestWater || K.dist(cistern.x, cistern.y, org.x, org.y) < K.dist(nearestWater.x, nearestWater.y, org.x, org.y))) {
          nearestWater = { x: cistern.x, y: cistern.y, cistern: true };
        }
      }
    }

    // Underground context, colonial organisms only — wildlife does not build.
    let digSite = null, shelter = null;
    if (!isWild(org)) {
      digSite = CM.structures.nearestSite(game, org.ownerId, org.x, org.y, senseR * 4);
      // Searched generously: an organism should be able to decide to run for
      // a warren it can reach, not only recognise one it is already inside.
      shelter = CM.structures.findShelter(game, org.ownerId, org.x, org.y, senseR * 4);
    }
    const tempStressNow = O.tempStress(org, W.tempAt(game.world, org.x, org.y));

    // How much room this organism's colony has left to grow, 0..1.
    let colonyRoom = 0.5;
    if (!isWild(org)) {
      const colony = colonyOf(game, org);
      if (colony) {
        const cap = CM.colony.populationCap(colony, game.simTime);
        colonyRoom = cap > 0 ? K.clamp01(1 - colony.pop / cap) : 0;
      }
    } else {
      const tier = T.WILD_BY_ID[org.speciesId].tier;
      const cap = tier === 'predator' ? PRED_TARGET * 2 : PREY_TARGET * 2;
      const cur = tier === 'predator' ? game.stats.predatorPop : game.stats.herbivorePop;
      colonyRoom = K.clamp01(1 - cur / cap);
    }

    return { nearestThreat, nearestPrey, nearestFood, nearestWater, nearestCuriosity, canEatPlants, canHunt,
      newSightings, observable, colonyRoom, carryRoom: K.clamp01(1 - org.carrying / MAX_CARRY),
      digSite, shelter, tempStress: tempStressNow, defendRadius: senseR };
  }

  // -- movement ---------------------------------------------------------------
  /* Open water is crossable but expensive, rather than a hard wall. A wall
   * needs pathfinding to look anything but stupid (organisms grinding along a
   * shoreline); a movement cost gets the same read — creatures go around
   * lakes, and the map's water genuinely shapes where life goes — with none
   * of the stuck-against-geometry failure modes. */
  function moveToward(world, org, tx, ty, dt, mul) {
    const dx = tx - org.x, dy = ty - org.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-4) return 0;
    const desired = Math.atan2(dy, dx);
    org.heading = K.turnToward(org.heading, desired, 5 * dt);
    const terrain = W.moveCostAt(world, org.x, org.y);
    const spd = (org.stats.speed / SPEED_DIV) * (mul || 1) * terrain;
    const step = Math.min(d, spd * dt);
    org.x += Math.cos(org.heading) * step;
    org.y += Math.sin(org.heading) * step;
    return d - step;
  }

  /* Wandering is random, except when the organism is thirsty — then it walks
   * up the humidity gradient. Large inland stretches of this map hold no
   * open water at all, so without a gradient to follow a thirsty organism
   * out there has no strategy but luck, and quietly dies. Following moisture
   * is both a real thing animals do and the reason droughts here produce
   * migration toward the wet regions rather than a silent die-off. */
  function pickWanderTarget(org, world, radius) {
    /* A rally point biases where an organism wanders. It is how a colony's
     * doctrine becomes visible on screen — predatory colonies drift toward
     * whoever they hate, entrenched ones never leave home. */
    const rally = org.rallyPoint;
    if (rally && Math.random() < 0.7) {
      for (let i = 0; i < 5; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * (rally.radius || 14);
        const x = K.clamp(rally.x + Math.cos(a) * r, 1, world.size - 1);
        const y = K.clamp(rally.y + Math.sin(a) * r, 1, world.size - 1);
        if (!W.isWaterAt(world, x, y)) return { x, y };
      }
    }
    const thirsty = org.thirst > 55;
    let best = null, bestMoisture = -1;
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * radius;
      const x = K.clamp(org.x + Math.cos(a) * r, 1, world.size - 1);
      const y = K.clamp(org.y + Math.sin(a) * r, 1, world.size - 1);
      if (W.isWaterAt(world, x, y)) continue;
      if (!thirsty) return { x, y };
      const m = W.moistureAt(world, x, y);
      if (m > bestMoisture) { bestMoisture = m; best = { x, y }; }
    }
    return best || { x: org.x, y: org.y };
  }

  // -- combat / death -----------------------------------------------------
  /* cause: 'combat' | 'starved' | 'thirst' | 'cold' | 'heat' | 'toxin' | null.
   * Rivals steer their next genome off this, so it is worth being accurate
   * about *why* something died rather than only that it did. */
  function resolveDeath(game, bus, victim, killer, cause) {
    const victimColony = colonyOf(game, victim);
    const killerColony = killer ? colonyOf(game, killer) : null;

    if (killer && !isWild(killer)) {
      // The killer's colony always feeds; only the player's colony builds a
      // sample and a discovery entry, because only the player has a lab.
      killer.carrying = Math.min(MAX_CARRY, killer.carrying + 9 + victim.stats.size * 0.25);
      if (killerColony) {
        killerColony.kills++;
        if (!killerColony.isPlayer) CM.colony.creditObservation(game, bus, killerColony, victim.traits, 1);
      }
      if (killerColony && victimColony) CM.colony.registerKill(game, bus, killerColony.id, victimColony.id);
    }

    if (isWild(victim)) {
      if (killer && killer.ownerId === CM.colony.PLAYER_ID) {
        D.spawnSample(game, game.world, victim.x, victim.y, victim);
        D.recordEncounter(game, bus, killer, victim, 'wild_killed', victim.x, victim.y);
      }
    } else if (victimColony) {
      if (victimColony.isPlayer) {
        if (killer) D.recordEncounter(game, bus, victim, killer, 'player_killed', victim.x, victim.y);
        else reportEnvironmentalDeath(game, bus, victim, cause);
      } else {
        CM.colony.recordLoss(game, victimColony, cause || (killer ? 'combat' : null));
        if (killer) CM.colony.creditObservation(game, bus, victimColony, killer.traits, 1);
        // A rival organism killed by the player is a sample too — this is how
        // the player steals a rival's biology instead of only the wildlife's.
        if (killer && killer.ownerId === CM.colony.PLAYER_ID) {
          D.spawnSample(game, game.world, victim.x, victim.y, victim);
          D.recordEncounter(game, bus, killer, victim, 'wild_killed', victim.x, victim.y);
        }
      }
    }
    CM.coremind.removeOrganism(game, victim);
  }

  function colonyOf(game, org) {
    if (!game.coloniesById || isWild(org)) return null;
    return game.coloniesById[org.ownerId] || null;
  }

  /* An organism that starves, dehydrates, freezes or poisons itself dies
   * silently otherwise — the colony just shrinks and the player is given no
   * reason. That is the single most useful thing the feed can tell them,
   * because it names the stat their design got wrong. Throttled per cause so
   * a mass die-off reports once rather than forty times. */
  const DEATH_CAUSE_TEXT = {
    starved: { icon: '\u{1F35D}', label: 'starved — it could not find enough to eat' },
    thirst: { icon: '\u{1F4A7}', label: 'died of thirst — too far from water for its needs' },
    heat: { icon: '\u{1F321}', label: 'died of heat stress — its temperature tolerance was too narrow' },
    cold: { icon: '\u{2744}', label: 'froze — its temperature tolerance was too narrow' },
    toxin: { icon: '\u{2620}', label: 'died of poisoning' }
  };
  const DEATH_REPORT_COOLDOWN = 25;

  function reportEnvironmentalDeath(game, bus, victim, cause) {
    const info = DEATH_CAUSE_TEXT[cause];
    if (!info) return;
    const seen = game.__deathReports || (game.__deathReports = {});
    if (game.simTime - (seen[cause] || -999) < DEATH_REPORT_COOLDOWN) return;
    seen[cause] = game.simTime;
    D.pushEvent(game, bus, {
      kind: 'death', icon: info.icon,
      message: `${victim.name} ${info.label}.`,
      observation: {
        species: victim.name,
        damageType: 'Environmental (' + cause + ')',
        defense: 'n/a — not a combat loss'
      },
      x: victim.x, y: victim.y
    });
  }

  /* "Plant produces chemical defense" is one of the brief's own example
   * observations. Reported once per plant species so a colony grazing a
   * bitterleaf meadow does not bury the feed. */
  function noteFloraDefense(game, bus, org, plantId) {
    if (org.ownerId !== CM.colony.PLAYER_ID) return;
    game.discovery.knownFlora = game.discovery.knownFlora || {};
    if (game.discovery.knownFlora[plantId]) return;
    game.discovery.knownFlora[plantId] = true;
    const plant = CM.flora.get(plantId);
    D.pushEvent(game, bus, {
      kind: 'discovery', icon: '\u{1F33F}',
      message: `${plant.name} is chemically defended — ${org.name} was injured feeding on it.`,
      observation: {
        species: plant.name,
        damageType: plant.toxicity > 0 ? 'Toxin (ingested)' : 'Physical (thorns)',
        defense: plant.toxicity > 0 ? 'Chemical deterrent' : 'Structural spines'
      },
      x: org.x, y: org.y
    });
  }

  function meleeTick(game, bus, org, dt) {
    const target = org.actionTarget && org.actionTarget.ref;
    if (!target || !O.isAlive(target)) { org.state = S.EXPLORE; org.actionTarget = null; org.aiCounter = 0; return; }
    const d = K.dist(org.x, org.y, target.x, target.y);
    if (d > ATTACK_LEASH) { org.state = S.HUNT; return; }

    const pierce = org.behaviors.has('armor_pierce') ? 0.5 : 1;
    const venomMul = org.behaviors.has('damage_over_time') ? 1.28 : 1;
    const effDef = target.stats.defense * pierce;
    const dmg = Math.max(1, org.stats.attack - effDef * 0.5) * venomMul * dt;
    target.health -= dmg;
    if (org.behaviors.has('passive_heal')) target.__attackedThisTick = true;

    const retaliates = (isWild(target) && T.WILD_BY_ID[target.speciesId].diet === 'carnivore')
      || (!isWild(target) && (target.directive === 'DEFEND' || target.directive === 'HUNT'));
    let retaliationDealt = 0;
    if (retaliates && target.health > 0) {
      const rEffDef = org.stats.defense;
      const rDmg = Math.max(1, target.stats.attack - rEffDef * 0.5) * dt;
      org.health -= rDmg;
      retaliationDealt = rDmg;
    }

    if (target.health <= 0) { resolveDeath(game, bus, target, org, 'combat'); org.state = S.EXPLORE; org.actionTarget = null; org.aiCounter = 0; }
    // Credit the kill to the target only if it actually fought back. An
    // attacker that was already starving or dehydrated can cross zero during
    // its own attack, and blaming whatever it happened to be biting produced
    // reports like "Grazer killed Scout" — a herbivore that never deals
    // damage. Those reports are the evidence the player designs from, so a
    // false one is worse than none.
    if (org.health <= 0) resolveDeath(game, bus, org, retaliationDealt > 0 ? target : null, retaliationDealt > 0 ? 'combat' : org.deathCause);
  }

  // -- per-organism step ------------------------------------------------------
  function executeState(game, bus, org, dt) {
    const world = game.world;
    switch (org.state) {
      case S.EXPLORE: {
        if (!org.actionTarget || K.dist(org.x, org.y, org.actionTarget.x, org.actionTarget.y) < ARRIVE_DIST) {
          const radius = (!isWild(org) && org.directive === 'EXPLORE') ? 17 : 10;
          org.actionTarget = pickWanderTarget(org, world, radius);
        }
        moveToward(world, org, org.actionTarget.x, org.actionTarget.y, dt, 0.55);
        break;
      }
      case S.SEEK_FOOD: {
        const tgt = org.actionTarget;
        if (!tgt) { org.state = S.EXPLORE; break; }
        const d = moveToward(world, org, tgt.x, tgt.y, dt, 0.8);
        // A deposit under the organism is harvested instead of grazed.
        const deposit = (!isWild(org) && org.directive === 'GATHER')
          ? W.findNearestDeposit(world, org.x, org.y, W.DEPOSIT_REACH) : null;
        if (deposit) {
          const taken = W.harvestDeposit(deposit, 14 * dt);
          org.carrying = Math.min(MAX_CARRY, org.carrying + taken);
          org.hunger = Math.max(0, org.hunger - taken * 0.6);
          const home = colonyOf(game, org);
          if (home) deposit.claimedBy = home.id;
          if (org.carrying >= MAX_CARRY * 0.95) { org.actionTarget = null; org.aiCounter = 0; }
          break;
        }
        if (d < ARRIVE_DIST) {
          const plantId = world.flora[W.idx(K.clamp(Math.floor(tgt.x), 0, world.size - 1), K.clamp(Math.floor(tgt.y), 0, world.size - 1))];
          const taken = W.consumeFood(world, tgt.x, tgt.y, 16);
          const bite = CM.flora.biteOutcome(plantId, org, taken);
          org.hunger = Math.max(0, org.hunger - bite.food * 3.2);
          org.energy = Math.min(org.stats.energyMax, org.energy + bite.food * 0.6);
          if (bite.water) org.thirst = Math.max(0, org.thirst - bite.water);
          // A defended plant is a real encounter: it costs health, and for the
          // player it is evidence of a chemical defense worth understanding.
          if (bite.toxin > 0 || bite.physical > 0) {
            org.health -= (bite.toxin + bite.physical);
            if (bite.toxin > 0) org.deathCause = 'toxin';
            noteFloraDefense(game, bus, org, plantId);
          }
          if (!isWild(org) && org.directive === 'GATHER') {
            org.carrying = Math.min(MAX_CARRY, org.carrying + bite.food * 0.5);
          }
          org.actionTarget = null; org.aiCounter = 0;
        }
        break;
      }
      case S.SEEK_WATER: {
        const tgt = org.actionTarget;
        if (!tgt) { org.state = S.EXPLORE; break; }
        // Drinking happens from the shore, so arriving *next to* the water
        // cell is enough — walking into the lake would only cost speed.
        moveToward(world, org, tgt.x, tgt.y, dt, 0.85);
        if (W.atWaterEdge(world, org.x, org.y) || K.dist(org.x, org.y, tgt.x, tgt.y) < DRINK_DIST) {
          org.thirst = Math.max(0, org.thirst - 55 * dt);
          if (org.thirst <= 0) { org.actionTarget = null; org.aiCounter = 0; }
        }
        break;
      }
      case S.HUNT: {
        const tgt = org.actionTarget && org.actionTarget.ref;
        if (!tgt || !O.isAlive(tgt)) { org.state = S.EXPLORE; org.actionTarget = null; org.aiCounter = 0; break; }
        const d = K.dist(org.x, org.y, tgt.x, tgt.y);
        org.huntTimer = (org.huntTimer || 0) + dt;
        if (d <= ATTACK_RANGE) { org.state = S.ATTACK; org.huntTimer = 0; break; }
        if (org.huntTimer > HUNT_GIVEUP) { org.state = S.EXPLORE; org.actionTarget = null; org.aiCounter = 0; org.huntTimer = 0; break; }
        moveToward(world, org, tgt.x, tgt.y, dt, 1.05);
        break;
      }
      case S.ATTACK:
        meleeTick(game, bus, org, dt);
        break;
      case S.FLEE: {
        const away = org.actionTarget;
        // A digger that can't outrun the threat goes under instead. This is
        // what `digging` buys: burrowing beats being slow, which is the whole
        // reason the trait's speed penalty is affordable.
        if (org.behaviors.has('can_burrow_flee') && !org.burrowed && org.burrowCooldown <= 0
            && away && K.dist(org.x, org.y, away.x, away.y) < 7
            && !W.isWaterAt(world, org.x, org.y)) {
          org.burrowed = true;
          org.burrowTimer = BURROW_DURATION * (0.6 + org.stats.digging / 90);
          break;
        }
        if (away) {
          const a = Math.atan2(org.y - away.y, org.x - away.x);
          moveToward(world, org, org.x + Math.cos(a) * 6, org.y + Math.sin(a) * 6, dt, 1.15);
        }
        break;
      }
      case S.REST:
        org.energy = Math.min(org.stats.energyMax, org.energy + org.stats.energyMax * 0.08 * dt);
        org.health = Math.min(org.stats.health, org.health + org.stats.health * 0.02 * dt);
        break;
      case S.EXCAVATE: {
        const site = org.actionTarget && org.actionTarget.ref;
        if (!site || site.done) { org.state = S.EXPLORE; org.actionTarget = null; org.aiCounter = 0; break; }
        const d = moveToward(world, org, site.x, site.y, dt, 0.85);
        if (d < DIG_REACH) {
          CM.structures.addWork(game, bus, site, org, dt);
          // Excavation is work: it burns energy faster than walking.
          org.energy = Math.max(0, org.energy - (org.stats.metabolism / 11) * 0.6 * dt);
          if (site.done) { org.actionTarget = null; org.aiCounter = 0; }
        }
        break;
      }
      case S.SHELTER: {
        const den = org.actionTarget && org.actionTarget.ref;
        if (!den) { org.state = S.REST; break; }
        const d = moveToward(world, org, den.x, den.y, dt, 1);
        if (d < CM.structures.TYPES[den.type].radius * 0.5) {
          // Inside: recover quickly and safely.
          org.energy = Math.min(org.stats.energyMax, org.energy + org.stats.energyMax * 0.12 * dt);
          org.health = Math.min(org.stats.health, org.health + org.stats.health * 0.05 * dt);
          org.sheltered = true;
        }
        break;
      }
      case S.RETURN_TO_CORE: {
        // An organism returns to *its own* colony's Core. Routing this through
        // game.core meant every rival's gatherers walked their harvest across
        // the map and handed it to the player.
        const home = colonyOf(game, org);
        if (!home || !home.alive) { org.state = S.EXPLORE; org.actionTarget = null; org.aiCounter = 0; break; }
        const d = moveToward(world, org, home.x, home.y, dt, 1);
        if (d < home.radius) {
          if (org.carrying > 0) {
            // Overflow past the Core's storage is simply lost, which is what
            // makes "keep gathering" stop being the answer to everything.
            home.biomass = Math.min(home.biomassCap, home.biomass + org.carrying);
            home.energy = Math.min(home.energyCap, home.energy + org.carrying * 0.25);
            org.carrying = 0;
          }
          /* The Core sustains the organisms that feed it. Without this a
           * gatherer never recovers: hauling keeps it moving, moving keeps
           * its energy low, and reproduction needs 72% energy — so a GATHER
           * colony filled its Core to the brim while dwindling to extinction,
           * having hauled instead of bred. Refuelling at home closes the loop
           * gather -> deliver -> recover -> reproduce. */
          if (home.biomass > 5) {
            org.energy = Math.min(org.stats.energyMax, org.energy + org.stats.energyMax * 0.5 * dt);
            org.hunger = Math.max(0, org.hunger - 12 * dt);
          }
          org.aiCounter = 0;
        }
        break;
      }
      case S.REPRODUCE: {
        if (org.reproTimer == null) org.reproTimer = 3.5 + org.stats.size * 0.06;
        org.reproTimer -= dt;
        if (org.reproTimer <= 0) {
          attemptReproduce(game, bus, org);
          org.reproTimer = null; org.reproCooldown = 22 + Math.random() * 10; org.aiCounter = 0;
        }
        break;
      }
      case S.INVESTIGATE: {
        const tgt = org.actionTarget;
        if (!tgt) { org.state = S.EXPLORE; break; }
        const d = moveToward(world, org, tgt.x, tgt.y, dt, 0.7);
        if (d < ARRIVE_DIST) { org.directiveTarget = null; org.actionTarget = null; org.aiCounter = 0; }
        break;
      }
      default: break;
    }
  }

  function attemptReproduce(game, bus, org) {
    if (game.organisms.length >= MAX_ACTIVE) return;
    // Wild reproduction has its own soft ceiling (double the target density)
    // so the ecosystem plateaus instead of one tier filling the entire
    // active-organism cap and crowding out everything else, including the
    // player's own designs.
    if (org.ownerId === 'wild') {
      const tier = T.WILD_BY_ID[org.speciesId].tier;
      if (tier === 'prey' && game.stats.herbivorePop >= PREY_TARGET * 2) return;
      if (tier === 'predator' && game.stats.predatorPop >= PRED_TARGET * 2) return;
    } else {
      // Auto-reproduction pauses once a colony is at its own ceiling so it
      // never crowds out the wildlife or the colony's room to deploy fresh
      // designs — deliberate deployment spend is never blocked by this.
      const colony = colonyOf(game, org);
      const cap = colony ? CM.colony.populationCap(colony, game.simTime) : PLAYER_REPRO_SOFT_CAP;
      if ((colony ? colony.pop : game.stats.playerPop) >= cap) return;
    }
    org.energy -= org.stats.energyMax * 0.42;
    org.health -= org.stats.health * 0.08;
    const jitter = () => (Math.random() - 0.5) * 2.4;
    let traits = org.traits.slice();
    if (isWild(org) && Math.random() < 0.08) {
      const cat = K.pick(Math.random, T.CATEGORIES);
      const options = T.TRAITS_BY_CATEGORY[cat];
      if (options.length) traits = traits.filter(id => T.TRAITS_BY_ID[id].category !== cat).concat([K.pick(Math.random, options).id]);
    }
    const child = O.create({
      ownerId: org.ownerId, speciesId: org.speciesId, designId: org.designId,
      name: org.name,
      traits, diet: org.diet, color: org.color,
      x: K.clamp(org.x + jitter(), 1, game.world.size - 1),
      y: K.clamp(org.y + jitter(), 1, game.world.size - 1),
      generation: org.generation + 1,
      directive: isWild(org) ? null : org.directive
    });
    CM.coremind.addOrganism(game, child);
    return child;
  }

  // -- wild population maintenance --------------------------------------------
  function maybeSpawnWild(game, dt) {
    game.wildSpawnAcc = (game.wildSpawnAcc || 0) + dt;
    if (game.wildSpawnAcc < 1.4) return;
    game.wildSpawnAcc = 0;
    if (game.organisms.length >= MAX_ACTIVE) return;
    const wildCount = game.stats.herbivorePop + game.stats.predatorPop;
    if (wildCount >= WILD_CAP) return;

    if (game.stats.herbivorePop < PREY_TARGET && Math.random() < 0.55) {
      const species = T.WILD_SPECIES.filter(s => s.tier === 'prey').map(s => s.id);
      spawnWildOne(game, K.pick(Math.random, species), randomLandSpot(game.world, 8, 30));
    } else if (game.stats.predatorPop < PRED_TARGET && game.stats.herbivorePop > MIN_PREY_FOR_PRED && Math.random() < 0.28) {
      const species = T.WILD_SPECIES.filter(s => s.tier === 'predator').map(s => s.id);
      spawnWildOne(game, K.pick(Math.random, species), randomLandSpot(game.world, 20, 30));
    }
  }

  /* --- the deep is not empty ------------------------------------------------
   * Subterranean fauna are drawn to excavation. The pressure scales with how
   * deep a colony has cut and how much it has built there, so the underground
   * is contested ground rather than a safe basement — and the abyssal tier,
   * where the endgame sits, is the most dangerous place on the map. */
  const DEEP_SPAWN_INTERVAL = 9;
  function deepFaunaTick(game, bus, dt) {
    game.__deepAcc = (game.__deepAcc || 0) + dt;
    if (game.__deepAcc < DEEP_SPAWN_INTERVAL) return;
    game.__deepAcc = 0;
    if (game.organisms.length >= MAX_ACTIVE) return;

    const chambers = CM.structures.all(game).filter(s => s.done && s.depth >= 1);
    if (!chambers.length) return;

    // Weight by depth: deep works attract worse things, more often.
    const target = chambers[Math.floor(Math.random() * chambers.length)];
    const depth = target.depth || 1;
    if (Math.random() > 0.22 * depth) return;

    const candidates = T.WILD_SPECIES.filter(sp => sp.subterranean && sp.subterranean <= depth);
    if (!candidates.length) return;
    // Prefer the deepest thing that belongs at this stratum.
    candidates.sort((a, b) => b.subterranean - a.subterranean);
    const species = Math.random() < 0.6 ? candidates[0] : candidates[Math.floor(Math.random() * candidates.length)];

    const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 4;
    const org = spawnWildOne(game, species.id, {
      x: K.clamp(target.x + Math.cos(a) * r, 1, game.world.size - 1),
      y: K.clamp(target.y + Math.sin(a) * r, 1, game.world.size - 1)
    });
    org.depth = depth;
    /* Deep fauna are drawn to the excavation that woke them, not merely near
     * it. Without this they wandered off within seconds of spawning and the
     * chamber's integrity healed faster than they could chew it — the deep
     * looked dangerous and was not. Rallying them to the chamber reuses the
     * same bias a colony's own doctrine uses, so a besieged chamber genuinely
     * has to be defended by standing organisms in it. */
    org.rallyPoint = { x: target.x, y: target.y, radius: 3 };
    const colony = game.coloniesById[target.colonyId];
    if (colony && colony.isPlayer && !game.__deepWarned) {
      game.__deepWarned = true;
      D.pushEvent(game, bus, {
        kind: 'warn', icon: '\u{1F573}',
        message: `Something came up out of the rock near your workings: ${species.name}. The deep is inhabited.`,
        x: org.x, y: org.y, speciesId: species.id
      });
    }
  }

  /* Chambers can be chewed open. A subterranean predator standing on a
   * finished chamber grinds its integrity down; at zero the chamber collapses
   * and everything it was providing stops. Without this the underground would
   * be permanent once built, and there would be nothing to defend down there. */
  function chamberSiegeTick(game, bus, dt) {
    game.__chamberAcc = (game.__chamberAcc || 0) + dt;
    if (game.__chamberAcc < 1.5) return;
    const step = game.__chamberAcc;
    game.__chamberAcc = 0;

    const list = CM.structures.all(game);
    for (let i = list.length - 1; i >= 0; i--) {
      const site = list[i];
      if (!site.done) continue;
      const near = game.world.grid.queryRadius(site.x, site.y, 3.5, []);
      let gnawers = 0, guards = 0;
      for (const o of near) {
        if (!o.alive) continue;
        if (o.ownerId === site.colonyId) { guards++; continue; }
        if (isWild(o) && (T.WILD_BY_ID[o.speciesId] || {}).subterranean) gnawers++;
      }
      if (gnawers > guards) {
        // Hardened ground bleeds slower. A redoubt in the middle of a network
        // protects the chambers around it, not just the organisms.
        const hardness = 1 + CM.structures.defenseAt(game, site.colonyId, site.x, site.y);
        site.integrity = (site.integrity == null ? 100 : site.integrity) - (gnawers - guards) * 2.2 * step / hardness;
        if (site.integrity <= 0) {
          const colony = game.coloniesById[site.colonyId];
          // Whatever was besieging this chamber loses its reason to stand
          // here; it goes back to roaming rather than milling over a hole.
          for (const o of near) {
            if (o.rallyPoint && o.rallyPoint.x === site.x && o.rallyPoint.y === site.y) o.rallyPoint = null;
          }
          CM.structures.destroy(game, site);
          if (colony && colony.isPlayer) {
            D.pushEvent(game, bus, {
              kind: 'death', icon: '\u{1F4A5}',
              message: `${CM.structures.TYPES[site.type].name} has been chewed open and collapsed.`,
              x: site.x, y: site.y
            });
          }
        }
      } else if (site.integrity != null && site.integrity < 100) {
        site.integrity = Math.min(100, site.integrity + 1.5 * step);
      }
    }
  }

  // -- main tick ----------------------------------------------------------
  function tick(game, bus, dt) {
    game.simTime += dt;

    W.tickFood(game.world, 3200);
    D.tickSamples(game, dt);
    W.tickDeposits(game.world, dt);
    maybeSpawnWild(game, dt);

    const camX = game.camera.x, camY = game.camera.y;
    let playerPop = 0, herbivorePop = 0, predatorPop = 0, plantTotal = 0;
    const colonyPop = {};
    if (game.colonies) for (const c of game.colonies) colonyPop[c.id] = 0;

    const colonyUpkeep = {};
    if (game.colonies) for (const c of game.colonies) colonyUpkeep[c.id] = 0;

    function countOrganism(org) {
      if (isWild(org)) {
        const sp = T.WILD_BY_ID[org.speciesId];
        if (sp && sp.tier === 'predator') predatorPop++; else herbivorePop++;
        return;
      }
      if (colonyPop[org.ownerId] != null) {
        colonyPop[org.ownerId]++;
        colonyUpkeep[org.ownerId] += UPKEEP_BASE + org.traits.length * UPKEEP_PER_TRAIT;
      }
      if (org.ownerId === CM.colony.PLAYER_ID) playerPop++;
    }

    // Snapshot the roster before iterating: resolveDeath() splices
    // game.organisms as organisms die (natural causes below, or combat
    // inside executeState/meleeTick), and mutating an array mid-`for...of`
    // silently skips whatever shifts into the current index.
    const roster = game.organisms.slice();

    for (const org of roster) {
      if (!org.alive) continue; // already resolveDeath'd earlier this tick (e.g. to a faster predator)
      org.age += dt;

      const distCam = K.dist(org.x, org.y, camX, camY);
      org.lod = distCam < NEAR_R ? 'near' : distCam < MID_R ? 'mid' : 'far';

      // A burrowed organism is out of play: safe, still, and recovering. It
      // skips sensing, deciding and acting entirely, which also makes
      // burrowing the cheapest thing in the sim rather than the priciest.
      if (org.burrowed) {
        org.burrowTimer -= dt;
        org.energy = Math.min(org.stats.energyMax, org.energy + org.stats.energyMax * 0.03 * dt);
        org.hunger = K.clamp(org.hunger + (org.stats.metabolism / 11) * 0.4 * dt, 0, 100);
        if (org.burrowTimer <= 0) {
          org.burrowed = false;
          org.burrowCooldown = BURROW_COOLDOWN;
          org.state = S.EXPLORE; org.actionTarget = null; org.aiCounter = 0;
        }
        countOrganism(org);
        continue;
      }
      if (org.burrowCooldown > 0) org.burrowCooldown -= dt;

      // needs
      const metaRate = org.stats.metabolism / 11;
      org.hunger = K.clamp(org.hunger + metaRate * 1.05 * dt, 0, 100);
      /* Cultivated fungus feeds whoever is standing in it. This is what makes
       * the deep liveable: below the second stratum there is no forage, so a
       * colony without a fungarium can dig the abyssal reach but cannot hold
       * it. */
      if (!isWild(org)) {
        const fungus = CM.structures.fungariumFeed(game, org);
        if (fungus) org.hunger = Math.max(0, org.hunger - fungus * dt);
      }
      org.thirst = K.clamp(org.thirst + metaRate * org.stats.water_requirement * 1.6 * dt, 0, 100);
      const moving = org.state === S.EXPLORE || org.state === S.HUNT || org.state === S.FLEE || org.state === S.SEEK_FOOD || org.state === S.SEEK_WATER || org.state === S.RETURN_TO_CORE;
      org.energy = K.clamp(org.energy - metaRate * (moving ? 0.9 : 0.35) * dt, 0, org.stats.energyMax);
      if (org.hunger >= 100) { org.health -= org.stats.health * 0.03 * dt; org.deathCause = 'starved'; }
      if (org.thirst >= 100) { org.health -= org.stats.health * 0.035 * dt; org.deathCause = 'thirst'; }
      if (org.energy <= 0) org.health -= org.stats.health * 0.015 * dt;

      const localTemp = W.tempAt(game.world, org.x, org.y);
      /* Being inside a warren is the point of digging one: the chamber holds
       * a workable temperature whatever the surface is doing, which is what
       * lets a colony hold ground its genome could not otherwise survive. */
      let stress = O.tempStress(org, localTemp);
      if (org.sheltered) stress *= 0.15;
      if (stress > 1) {
        org.health -= org.stats.health * 0.02 * (stress - 1) * dt;
        // Heat drives thirst: a badly-adapted organism in the wrong climate
        // dies of the heat *and* of the water it costs to cope with it.
        org.thirst = K.clamp(org.thirst + (stress - 1) * 1.2 * dt, 0, 100);
        org.deathCause = localTemp > O.COMFORT_TEMP ? 'heat' : 'cold';
      }

      // Hazards: standing in a vent field or a toxic bog hurts continuously.
      // Armor blunts the physical ones, so terrain is another thing a genome
      // can be designed against rather than only avoided.
      const hz = W.hazardAt(game.world, org.x, org.y);
      if (hz) {
        const info = W.HAZARD_INFO[hz];
        const resist = 1 - K.clamp01((org.stats.armor || 0) / 60) * 0.5;
        org.health -= info.damage * resist * dt;
        org.deathCause = hz === W.HAZARD.TOXIC_BOG ? 'toxin' : (info.tempDelta > 0 ? 'heat' : 'cold');
      }

      if (org.behaviors.has('passive_heal') && org.hunger < 85 && !org.__attackedThisTick) {
        org.health = Math.min(org.stats.health, org.health + org.stats.health * 0.045 * dt);
      }
      org.__attackedThisTick = false;

      /* A nursery speeds the colony back into breeding condition. */
      if (org.reproCooldown > 0) {
        const nursery = !isWild(org) && CM.structures.nurseryAt(game, org);
        org.reproCooldown -= dt * (nursery ? 2.6 : 1);
      }
      // sheltered is recomputed every tick by the SHELTER state itself.
      org.sheltered = false;

      // Resolve a needs death here, before the organism gets to sense, decide
      // or act. Letting a corpse take another swing is both wrong and the
      // source of misattributed kills further down.
      if (org.health <= 0) { resolveDeath(game, bus, org, null, org.deathCause); continue; }

      // AI re-decision, throttled by LOD
      org.aiCounter = (org.aiCounter || 0) - 1;
      if (org.aiCounter <= 0) {
        const interval = org.lod === 'near' ? 1 : org.lod === 'mid' ? 4 : 12;
        org.aiCounter = interval;
        const ctx = gatherContext(game, org);
        for (const s of ctx.newSightings) D.recordSighting(game, bus, s.speciesId, s.x, s.y);
        // Scaled by the decision interval so an organism's research rate does
        // not depend on how close the camera happens to be to it.
        if (ctx.observable && ctx.observable.length) {
          D.observeNearby(game, bus, org, ctx.observable, interval * dt * CM.structures.researchMultiplier(game, org));
        }
        const decision = CM.ai.decide(org, ctx);
        const transitioning = decision.state !== org.state;
        if (transitioning) { org.state = decision.state; org.huntTimer = 0; }
        // A null target on an unchanged state (e.g. still EXPLORE) means
        // "nothing new to report" — keep whatever in-progress target
        // executeState is working toward instead of wiping it every
        // re-decision, which for a near-camera organism is every tick.
        if (decision.target !== null || transitioning) org.actionTarget = decision.target;
      }

      executeState(game, bus, org, dt);
      // Deliberately org.alive, not O.isAlive(): isAlive also factors in
      // health, which is true both for "combat already resolveDeath'd this
      // organism inside meleeTick" (alive=false — skip) and for "hunger/temp
      // damage above just dropped health to 0 and hasn't been resolved yet"
      // (alive still true — must fall through to the health<=0 check below,
      // or the organism becomes a permanent zombie: dead in every practical
      // sense but never removed from the roster).
      if (!org.alive) continue;

      org.x = K.clamp(org.x, 0.1, game.world.size - 0.1);
      org.y = K.clamp(org.y, 0.1, game.world.size - 0.1);
      game.world.grid.update(org);

      if (org.health <= 0) { resolveDeath(game, bus, org, null, org.deathCause); continue; }

      countOrganism(org);
    }

    for (let i = 0; i < game.world.food.length; i += 733) plantTotal += game.world.food[i]; // sampled estimate, cheap
    game.stats = { playerPop, herbivorePop, predatorPop, plantTotal: Math.round(plantTotal), colonyPop };
    if (game.colonies) for (const c of game.colonies) {
      c.pop = colonyPop[c.id] || 0;
      c.upkeepRate = colonyUpkeep[c.id] || 0;
      // Granaries are how a colony grows past the Core's own storage.
      c.biomassCap = CM.colony.BIOMASS_CAP + CM.structures.storageBonus(game, c.id);
    }

    // slow passive core regeneration — the Coremind's own baseline metabolism
    game.core.energy = Math.min(game.core.energyCap, game.core.energy + 0.9 * dt);

    /* Upkeep. Without it a colony's income scales with its population while
     * nothing scales against it, so biomass runs away into the thousands and
     * every design cost becomes a rounding error — the genome designer stops
     * being a decision. Charging per organism, weighted by how elaborate that
     * organism is, means a big colony of heavy builds is genuinely expensive
     * to sustain, and expanding is a choice rather than a free action. */
    for (const colony of (game.colonies || [])) {
      if (!colony.alive) continue;
      colony.biomass = Math.max(0, colony.biomass - colony.upkeepRate * dt);
    }

    playerAutoExpand(game, bus, dt);
    reseedEmptyColonies(game, bus, dt);
    CM.climate.tick(game, bus, dt);
    CM.colony.tick(game, bus, dt);
    deepFaunaTick(game, bus, dt);
    chamberSiegeTick(game, bus, dt);
    structureIncomeTick(game, bus, dt);
    coreSiegeTick(game, bus, dt);
    narrateEcosystem(game, bus, dt);
  }

  /* Chambers that pay out do so here, once per colony per second rather than
   * per structure per tick. */
  function structureIncomeTick(game, bus, dt) {
    game.__incomeAcc = (game.__incomeAcc || 0) + dt;
    if (game.__incomeAcc < 1) return;
    const step = game.__incomeAcc;
    game.__incomeAcc = 0;
    for (const colony of (game.colonies || [])) {
      if (!colony.alive) continue;
      const inc = CM.structures.colonyIncome(game, colony.id);
      if (inc.biomass) colony.biomass = Math.min(colony.biomassCap, colony.biomass + inc.biomass * step);
      if (inc.energy) colony.energy = Math.min(colony.energyCap, colony.energy + inc.energy * step);
    }
  }

  /* The EXPAND directive hands site selection to the colony itself: the
   * player says "grow the network" and the Coremind picks where, using the
   * same shortfall reasoning the rivals use. DIG, by contrast, only works
   * sites the player placed by hand. */
  function playerAutoExpand(game, bus, dt) {
    const colony = game.core;
    if (!colony || !colony.alive || game.globalDirective !== 'EXPAND') return;
    colony.autoDigTimer = (colony.autoDigTimer || 0) - dt;
    if (colony.autoDigTimer > 0) return;
    colony.autoDigTimer = 12;
    const pending = CM.structures.ofColony(game, colony.id).filter(s => !s.done).length;
    if (pending >= 2) return;
    const plan = CM.structures.suggestExpansion(game, colony);
    if (plan) CM.structures.queue(game, bus, colony, plan.typeKey, plan.x, plan.y);
  }

  /* A Core with biomass left is never a dead end. If a colony loses every
   * organism it can still grow one more, slowly, from what it has stored.
   *
   * Without this, losing the last organism is unrecoverable no matter how
   * much biomass the Core is sitting on — and an unattended colony *does*
   * get ground down eventually by predators and rivals, so a player who
   * looked away came back to a game that could not be resumed. The Coremind
   * is a distributed intelligence; the Core regrowing a body is what that
   * means. Applied to every colony on the same terms, so a mauled rival can
   * also come back rather than being quietly out of the game forever. */
  const RESEED_INTERVAL = 18;
  function reseedEmptyColonies(game, bus, dt) {
    if (!game.colonies) return;
    for (const colony of game.colonies) {
      if (!colony.alive || colony.pop > 0) { colony.reseedTimer = 0; continue; }
      if (!colony.isPlayer && !CM.colony.isAwake(colony, game.simTime)) continue;
      const cost = T.resolveCost([]);
      if (colony.biomass < cost.biomass || colony.energy < cost.energy) continue;

      colony.reseedTimer = (colony.reseedTimer || 0) + dt;
      if (colony.reseedTimer < RESEED_INTERVAL) continue;
      colony.reseedTimer = 0;
      colony.biomass -= cost.biomass;
      colony.energy -= cost.energy;

      const a = Math.random() * Math.PI * 2;
      const org = O.create({
        ownerId: colony.id, traits: [],
        name: (colony.isPlayer ? 'Scout' : colony.name) + '-' + (++colony.deployed),
        x: K.clamp(colony.x + Math.cos(a) * 2, 1, game.world.size - 1),
        y: K.clamp(colony.y + Math.sin(a) * 2, 1, game.world.size - 1),
        color: colony.color,
        diet: colony.isPlayer ? 'omnivore' : 'omnivore',
        directive: colony.isPlayer ? game.globalDirective : 'GATHER'
      });
      CM.coremind.addOrganism(game, org);
      if (colony.isPlayer) {
        D.pushEvent(game, bus, {
          kind: 'warn', icon: '\u{1F9EB}',
          message: 'Your last organism was lost. The Core has grown a replacement from stored biomass.',
          x: colony.x, y: colony.y, orgId: org.id
        });
      }
    }
  }

  /* A Core under siege. Hostile organisms standing on an enemy Core grind its
   * integrity down; a Core with defenders present holds. This is the only way
   * a colony is removed from the game, and it applies to the player's Core on
   * exactly the same terms as everyone else's. */
  function coreSiegeTick(game, bus, dt) {
    if (!game.colonies) return;
    game.__siegeAcc = (game.__siegeAcc || 0) + dt;
    if (game.__siegeAcc < 1) return;
    const step = game.__siegeAcc;
    game.__siegeAcc = 0;

    for (const colony of game.colonies) {
      if (!colony.alive) continue;
      const near = game.world.grid.queryRadius(colony.x, colony.y, colony.radius, []);
      let attackers = 0, defenders = 0;
      for (const o of near) {
        if (!o.alive) continue;
        if (o.ownerId === colony.id) { defenders++; continue; }
        if (isWild(o)) continue;                    // wildlife does not besiege
        if (o.directive === 'HUNT' || o.directive === 'DEFEND') attackers++;
      }
      /* A redoubt covering the Core makes its defenders count for more —
       * fortified ground is the whole reason to dig one. */
      const fortified = 1 + CM.structures.defenseAt(game, colony.id, colony.x, colony.y);
      const pressure = attackers - defenders * 0.8 * fortified;
      if (pressure > 0) {
        CM.colony.damageCore(game, bus, colony, pressure * 1.4 * step);
        if (colony.alive && !colony.__siegeWarned) {
          colony.__siegeWarned = true;
          D.pushEvent(game, bus, {
            kind: colony.isPlayer ? 'warn' : 'rival', icon: '\u{2694}',
            message: colony.isPlayer
              ? 'Your Core is under attack.'
              : `${colony.name}'s Core is under attack.`,
            x: colony.x, y: colony.y, colonyId: colony.id
          });
        }
      } else {
        colony.__siegeWarned = false;
        // A Core that is not being pressed slowly knits itself back together.
        if (colony.integrity < 100) colony.integrity = Math.min(100, colony.integrity + 0.8 * step);
      }
    }
  }

  /* The food web has to visibly react on its own, not just in the player's
   * organisms. Rather than scripting it, watch the population numbers the
   * simulation already produces and say something when they cross a
   * threshold — each flag latches so one crossing narrates once, not every
   * tick it stays crossed. */
  function narrateEcosystem(game, bus, dt) {
    const eco = game.eco || (game.eco = { acc: 0, prevHerb: 0, prevPred: 0, shortage: false, predSurge: false, herbCrash: false });
    eco.acc += dt;
    if (eco.acc < 16) return;
    eco.acc = 0;

    const s = game.stats;
    const plantFrac = K.clamp01(s.plantTotal / 3200);

    if (plantFrac < 0.18 && !eco.shortage) {
      eco.shortage = true;
      D.pushEvent(game, bus, { kind: 'warn', icon: '\u{1F342}', message: 'Food shortage detected — plant coverage is critically low.' });
    } else if (plantFrac > 0.35) eco.shortage = false;

    if (eco.prevPred > 4 && s.predatorPop > eco.prevPred * 1.4 && !eco.predSurge) {
      eco.predSurge = true;
      D.pushEvent(game, bus, { kind: 'warn', icon: '\u{1F43A}', message: 'Predator population increasing.' });
    } else if (s.predatorPop < eco.prevPred * 1.15) eco.predSurge = false;

    /* The colony's own economy is an ecological signal too. A colony left on
     * HUNT gathers almost nothing while upkeep keeps running, and without
     * this the player just finds the CREATE ORGANISM button greyed out with
     * no idea why. */
    if (game.core.biomass < 1 && !eco.bankrupt) {
      eco.bankrupt = true;
      D.pushEvent(game, bus, {
        kind: 'warn', icon: '\u{1FA78}',
        message: 'Core biomass exhausted — upkeep is outrunning what your organisms bring home. Send some to GATHER.',
        x: game.core.x, y: game.core.y
      });
    } else if (game.core.biomass > 25) eco.bankrupt = false;

    if (eco.prevHerb > 10 && s.herbivorePop < eco.prevHerb * 0.55 && !eco.herbCrash) {
      eco.herbCrash = true;
      D.pushEvent(game, bus, { kind: 'warn', icon: '\u{26A0}', message: 'Herbivore population crashing — predators will follow.' });
    } else if (s.herbivorePop > eco.prevHerb * 0.85) eco.herbCrash = false;

    eco.prevHerb = s.herbivorePop; eco.prevPred = s.predatorPop;
  }

  CM.simulation = {
    MAX_ACTIVE, tick, spawnStarterColony, spawnStarterWildlife, spawnWildOne, randomLandSpot, gatherContext
  };
})(window.CM = window.CM || {});
