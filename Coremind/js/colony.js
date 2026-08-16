/* Coremind — colonies. The player is one Coremind among several.
 *
 * A rival is not a spawner with a hostile flag: it runs the same loop the
 * player does. It gathers biomass, accumulates observations of what it has
 * fought, unlocks traits from those observations, designs an organism against
 * the pressures it can actually perceive near its own Core, deploys it, and
 * changes its mind when the design fails. The player's advantage is judgement,
 * not information.
 *
 * `game.colonies[0]` is always the player, and `game.core` aliases it, so the
 * rest of the simulation can keep treating "the Core" as one object.
 */
(function (CM) {
  'use strict';
  const K = CM.core;
  const T = CM.traits;
  const W = CM.world;

  const PLAYER_ID = 'player';
  const WILD_ID = 'wild';

  /* Strategy archetypes. These are weights, not scripts — two colonies with
   * the same strategy on different ground still end up with different
   * organisms, because the design scorer reads local conditions. */
  const STRATEGIES = {
    EXPANSIONIST: {
      key: 'EXPANSIONIST', label: 'Expansionist',
      blurb: 'Spreads fast and thin, claiming ground before it can be contested.',
      deployRate: 0.72, aggression: 0.4, expansion: 1.5, defense: 0.6,
      favor: { BODY: 1.5, SENSE: 1.2, METABOLISM: 1.3, DEFENSE: 0.6, OFFENSE: 0.8, REPRODUCTION: 1.6 },
      directiveMix: { EXPLORE: 0.4, GATHER: 0.4, HUNT: 0.1, DEFEND: 0.1 }
    },
    ENTRENCHED: {
      key: 'ENTRENCHED', label: 'Entrenched',
      blurb: 'Builds heavy, slow organisms and refuses to yield ground near its Core.',
      deployRate: 0.5, aggression: 0.2, expansion: 0.4, defense: 1.8,
      favor: { BODY: 0.7, SENSE: 0.9, METABOLISM: 1.1, DEFENSE: 2.0, OFFENSE: 1.1, REPRODUCTION: 0.7 },
      directiveMix: { EXPLORE: 0.15, GATHER: 0.4, HUNT: 0.05, DEFEND: 0.4 }
    },
    PREDATORY: {
      key: 'PREDATORY', label: 'Predatory',
      blurb: 'Feeds by killing. Treats neighbours as a food source.',
      deployRate: 0.62, aggression: 1.6, expansion: 0.9, defense: 0.7,
      favor: { BODY: 1.2, SENSE: 1.3, METABOLISM: 0.9, DEFENSE: 0.8, OFFENSE: 2.1, REPRODUCTION: 0.8 },
      directiveMix: { EXPLORE: 0.2, GATHER: 0.2, HUNT: 0.55, DEFEND: 0.05 }
    },
    ADAPTIVE: {
      key: 'ADAPTIVE', label: 'Adaptive',
      blurb: 'Slow to commit, but rebuilds its organisms around whatever is killing them.',
      deployRate: 0.55, aggression: 0.7, expansion: 0.9, defense: 1.1,
      favor: { BODY: 1.1, SENSE: 1.5, METABOLISM: 1.4, DEFENSE: 1.2, OFFENSE: 1.1, REPRODUCTION: 1.0 },
      directiveMix: { EXPLORE: 0.3, GATHER: 0.35, HUNT: 0.2, DEFEND: 0.15 }
    }
  };
  const STRATEGY_KEYS = Object.keys(STRATEGIES);

  const RIVAL_NAMES = ['Thren', 'Ossuary', 'Kel-Var', 'Sable Choir', 'Meridian', 'Umbral Host', 'Cassiel'];
  const RIVAL_COLORS = ['#e0714f', '#a26bd6', '#4fa9e0', '#d6b34f', '#5fd67f', '#d64f9e'];

  const DEPLOY_INTERVAL = 11;      // sim-seconds between deploy decisions
  const REDESIGN_INTERVAL = 46;    // how often a rival reconsiders its genome
  /* A Core can only hold so much living matter. Without a ceiling, income
   * scales with population while nothing scales against it, biomass runs to
   * five figures, and every design cost becomes a rounding error — the
   * genome designer stops being a decision at all. Capping storage makes
   * hoarding pointless and spending the obvious move. */
  const BIOMASS_CAP = 500, ENERGY_CAP = 500;
  const TERR_CELL = 8;             // world cells per territory cell
  const TERR_SIZE = 32;            // 32*8 = 256

  function newColony(opts) {
    return {
      id: opts.id,
      name: opts.name,
      isPlayer: !!opts.isPlayer,
      x: opts.x, y: opts.y,
      radius: 7,
      biomass: opts.biomass != null ? opts.biomass : 80,
      energy: opts.energy != null ? opts.energy : 70,
      biomassCap: BIOMASS_CAP,
      energyCap: ENERGY_CAP,
      color: opts.color || '#33e6b0',
      strategyKey: opts.strategyKey || 'ADAPTIVE',
      alive: true,
      integrity: 100,                 // Core health; rivals collapse at 0
      // Rivals run their own discovery ledger — they know what they have met,
      // not what the player has met.
      observations: {},
      discovered: Object.assign({}, opts.discovered || {}),
      currentDesign: null,            // {BODY, SENSE, ...}
      designGeneration: 1,
      deployTimer: Math.random() * DEPLOY_INTERVAL,
      redesignTimer: Math.random() * REDESIGN_INTERVAL,
      losses: 0, kills: 0, deployed: 0,
      lastLossCause: null,            // drives ADAPTIVE redesign
      pop: 0,
      standing: {}                    // colonyId -> -1..1 (negative = hostile)
    };
  }

  function strategyOf(colony) { return STRATEGIES[colony.strategyKey] || STRATEGIES.ADAPTIVE; }

  /* Place the player plus `rivalCount` rivals, each on its own viable site. */
  function createAll(game, rivalCount) {
    const world = game.world;
    const rng = K.rngFrom(world.seed ^ 0x1b873593);
    const taken = [{ x: world.coreSpawn.x, y: world.coreSpawn.y }];

    const player = newColony({
      id: PLAYER_ID, name: 'Coremind', isPlayer: true,
      x: world.coreSpawn.x, y: world.coreSpawn.y, color: '#33e6b0'
    });
    const colonies = [player];

    for (let i = 0; i < rivalCount; i++) {
      const site = W.findColonySite(world, rng, taken);
      taken.push(site);
      const strategyKey = STRATEGY_KEYS[Math.floor(rng() * STRATEGY_KEYS.length)];
      const rival = newColony({
        id: 'rival_' + (i + 1),
        name: RIVAL_NAMES[Math.floor(rng() * RIVAL_NAMES.length)] + ' ' + romanNumeral(i + 1),
        x: site.x, y: site.y,
        color: RIVAL_COLORS[i % RIVAL_COLORS.length],
        strategyKey,
        biomass: 70, energy: 60,
        // A rival starts knowing a little, so it is a going concern from the
        // first minute rather than a colony of blank starter organisms.
        discovered: seedKnowledge(rng, strategyKey)
      });
      rival.awakenAt = RIVAL_WAKE_BASE + i * RIVAL_WAKE_STAGGER;
      rival.announced = false;
      rival.currentDesign = chooseDesign(game, rival);
      colonies.push(rival);
    }

    game.colonies = colonies;
    game.coloniesById = {};
    for (const c of colonies) game.coloniesById[c.id] = c;
    game.core = player;

    // pairwise standing, mildly hostile by default
    for (const a of colonies) {
      for (const b of colonies) {
        if (a.id !== b.id) a.standing[b.id] = -0.25;
      }
    }
    initTerritory(game);
    return colonies;
  }

  function romanNumeral(n) { return ['I', 'II', 'III', 'IV', 'V', 'VI'][n - 1] || String(n); }

  function seedKnowledge(rng, strategyKey) {
    const base = { basic_legs: true, bite: true };
    const extras = {
      EXPANSIONIST: ['vision', 'prolific_broodsac'],
      ENTRENCHED: ['armor', 'regeneration'],
      PREDATORY: ['claws', 'fast_movement'],
      ADAPTIVE: ['chem_sense', 'efficient_metabolism']
    }[strategyKey] || [];
    for (const id of extras) base[id] = true;
    // plus one wildcard, so two colonies of the same strategy still differ
    const all = T.TRAITS.map(t => t.id);
    base[all[Math.floor(rng() * all.length)]] = true;
    return base;
  }

  // --- rival design ---------------------------------------------------------
  /* Score every discovered trait against the strategy's preferences and the
   * conditions the colony can actually observe around its own Core, then take
   * the best legal trait per slot. This is why a rival on an ice sheet builds
   * differently from the same strategy on a savanna. */
  function chooseDesign(game, colony) {
    const strategy = strategyOf(colony);
    const world = game.world;
    const localTemp = W.tempAt(world, colony.x, colony.y);
    const localWater = W.findNearestWater(world, colony.x, colony.y, 26) ? 1 : 0;
    const threat = perceivedThreat(game, colony);

    const draft = {};
    for (const cat of T.CATEGORIES) {
      let best = null, bestScore = 0;
      for (const trait of T.TRAITS_BY_CATEGORY[cat]) {
        if (!colony.discovered[trait.id]) continue;
        if (T.conflictsWith(Object.values(draft), trait.id)) continue;

        let score = strategy.favor[cat] || 1;
        const mods = trait.stat_modifiers;

        // environmental fit
        if (trait.id === 'cold_resistance') score *= localTemp < 8 ? 3.2 : 0.25;
        if (trait.id === 'heat_resistance') score *= localTemp > 27 ? 3.2 : 0.25;
        if (trait.id === 'efficient_metabolism') score *= localWater ? 1.1 : 1.9;
        if (mods.water_requirement) score *= localWater ? 1 : (mods.water_requirement < 0 ? 1.8 : 0.5);

        // pressure fit: something is killing us, build against it
        if (threat > 0.5 && (cat === 'DEFENSE' || cat === 'OFFENSE')) score *= 1 + threat;
        if (colony.lastLossCause === 'combat' && cat === 'DEFENSE') score *= 1.6;
        if (colony.lastLossCause === 'starved' && trait.id === 'efficient_metabolism') score *= 2.2;
        if (colony.lastLossCause === 'thirst' && mods.water_requirement < 0) score *= 2.4;
        if (colony.lastLossCause === 'cold' && trait.id === 'cold_resistance') score *= 2.6;
        if (colony.lastLossCause === 'heat' && trait.id === 'heat_resistance') score *= 2.6;

        // synergy with what is already slotted
        const withDraft = Object.values(draft).concat([trait.id]);
        score *= 1 + T.checkCombination(withDraft).synergies.length * 0.35;

        // cheaper traits are more attractive when poor
        const afford = colony.biomass / Math.max(1, trait.biomass_cost * 4);
        score *= K.clamp(afford, 0.35, 1.4);

        score *= 0.9 + Math.random() * 0.2;   // keep colonies from converging

        /* Incumbency bonus. The jitter above exists so two colonies don't
         * converge on identical genomes, but without stickiness it also makes
         * a colony flip between two near-equal designs every single review —
         * which reads in the feed as an intelligence that cannot make up its
         * mind, and churns the announcement channel. A design has to be
         * clearly better to displace the one already in service. */
        if (colony.currentDesign && colony.currentDesign[cat] === trait.id) score *= 1.35;

        if (score > bestScore) { bestScore = score; best = trait.id; }
      }
      // Leaving a slot empty is a legitimate choice: it is cheaper, and a
      // colony that fills every slot on principle deploys half as often.
      if (best && bestScore > 0.75) draft[cat] = best;
    }
    for (const cat of T.CATEGORIES) if (!draft[cat]) draft[cat] = null;
    return draft;
  }

  function designTraitIds(design) {
    return design ? T.CATEGORIES.map(c => design[c]).filter(Boolean) : [];
  }

  /* How dangerous the colony's surroundings look right now, 0..1+. Read from
   * the same spatial grid everything else uses. */
  function perceivedThreat(game, colony) {
    const near = game.world.grid.queryRadius(colony.x, colony.y, 32, []);
    let hostile = 0;
    for (const o of near) {
      if (!o.alive) continue;
      if (o.ownerId === colony.id) continue;
      if (o.ownerId === WILD_ID) {
        const sp = T.WILD_BY_ID[o.speciesId];
        if (sp && sp.tier === 'predator') hostile += 0.5;
      } else hostile += 1;
    }
    return K.clamp01(hostile / 12) + (colony.losses > 4 ? 0.3 : 0);
  }

  // --- rival economy + deployment ------------------------------------------
  function tick(game, bus, dt) {
    if (!game.colonies) return;
    for (const colony of game.colonies) {
      if (colony.isPlayer || !colony.alive) continue;
      if (!isAwake(colony, game.simTime)) continue;
      if (!colony.announced) {
        colony.announced = true;
        CM.discovery.pushEvent(game, bus, {
          kind: 'rival', icon: '\u{1F4E1}',
          message: `Another Coremind has become active: ${colony.name}. Doctrine reads as ${strategyOf(colony).label.toLowerCase()}.`,
          x: colony.x, y: colony.y, colonyId: colony.id
        });
      }

      // Rivals get a modest passive income so they remain a going concern
      // even when their gatherers are being picked off; the bulk of their
      // economy still comes from organisms returning to their Core.
      colony.biomass = Math.min(colony.biomassCap, colony.biomass + 0.55 * dt);
      colony.energy = Math.min(colony.energyCap, colony.energy + 0.7 * dt);

      decayStanding(colony, dt);
      colony.redesignTimer -= dt;
      if (colony.redesignTimer <= 0) {
        colony.redesignTimer = REDESIGN_INTERVAL * (0.7 + Math.random() * 0.6);
        const next = chooseDesign(game, colony);
        const changed = T.CATEGORIES.filter(c => next[c] !== (colony.currentDesign || {})[c]).length;
        if (changed > 0) {
          colony.currentDesign = next;
          colony.designGeneration++;
          /* Only a substantive revision is worth the player's attention, and
           * never more than once every couple of minutes per colony. The feed
           * is the game's narration channel; a rival muttering about a single
           * swapped slot every 46 seconds drowns out actual news. */
          const now = game.simTime;
          if (changed >= 2 && now - (colony.lastAnnouncedAt || -999) > 120) {
            colony.lastAnnouncedAt = now;
            announceRedesign(game, bus, colony);
          }
        }
        colony.lastLossCause = null;
      }

      /* Rivals dig too. They queue one chamber at a time against whatever
       * they are currently short of, so an inland rival ends up with cisterns
       * and a besieged one with redoubts — the same reasoning the player
       * applies, run on their own state. */
      colony.digTimer = (colony.digTimer || 0) - dt;
      if (colony.digTimer <= 0) {
        colony.digTimer = 30 + Math.random() * 40;
        const pending = CM.structures.ofColony(game, colony.id).filter(s => !s.done).length;
        if (pending < 2) {
          const plan = CM.structures.suggestExpansion(game, colony);
          if (plan) CM.structures.queue(game, bus, colony, plan.typeKey, plan.x, plan.y);
        }
      }

      colony.deployTimer -= dt;
      if (colony.deployTimer <= 0) {
        colony.deployTimer = DEPLOY_INTERVAL / Math.max(0.2, strategyOf(colony).deployRate);
        tryDeploy(game, bus, colony);
      }
    }
    updateTerritory(game, dt);
  }

  function announceRedesign(game, bus, colony) {
    const ids = designTraitIds(colony.currentDesign);
    const names = ids.map(id => T.TRAITS_BY_ID[id].name).join(', ') || 'a stripped-down form';
    CM.discovery.pushEvent(game, bus, {
      kind: 'rival', icon: '\u{1F9EC}',
      message: `${colony.name} has redesigned its organisms: ${names}.`,
      x: colony.x, y: colony.y, colonyId: colony.id
    });
  }

  /* Rivals wake up on a stagger and grow into their ceiling rather than
   * starting at full strength.
   *
   * With rivals fully operational from t=0 — five known traits, deploying
   * immediately, capped at 34 — the player's three trait-less scouts were
   * simply erased inside the first fifteen minutes, measured. The brief's
   * opening is meant to be a quiet stretch of exploration, a first death
   * around minute three, and a discovery around minute five; a rival army at
   * minute one deletes that entirely. Rivals are the escalation *after* the
   * player has found their footing, so they arrive on a timer and ramp. */
  const RIVAL_WAKE_BASE = 360;    // sim-seconds before the first rival deploys
  const RIVAL_WAKE_STAGGER = 120; // and each subsequent one waits longer
  const RIVAL_GROWTH_PERIOD = 150; // how often a rival's ceiling rises

  function isAwake(colony, simTime) {
    return colony.isPlayer || simTime >= (colony.awakenAt || 0);
  }

  function populationCap(colony, simTime) {
    if (colony.isPlayer) return 60;
    const t = simTime == null ? 1e9 : simTime;
    if (t < (colony.awakenAt || 0)) return 0;
    const grown = 6 + Math.floor((t - colony.awakenAt) / RIVAL_GROWTH_PERIOD) * 5;
    return Math.max(0, Math.min(34, grown));
  }

  function tryDeploy(game, bus, colony) {
    if (colony.pop >= populationCap(colony, game.simTime)) return;
    if (game.organisms.length >= CM.simulation.MAX_ACTIVE) return;
    if (!colony.currentDesign) colony.currentDesign = chooseDesign(game, colony);

    const traits = designTraitIds(colony.currentDesign);
    const cost = T.resolveCost(traits);
    if (colony.biomass < cost.biomass || colony.energy < cost.energy) return;
    colony.biomass -= cost.biomass;
    colony.energy -= cost.energy;

    const a = Math.random() * Math.PI * 2, r = 1.5 + Math.random() * 2.5;
    const directive = rollDirective(colony);
    const org = CM.organism.create({
      ownerId: colony.id,
      traits,
      name: colony.name + '-' + (++colony.deployed),
      x: K.clamp(colony.x + Math.cos(a) * r, 1, game.world.size - 1),
      y: K.clamp(colony.y + Math.sin(a) * r, 1, game.world.size - 1),
      color: colony.color,
      diet: 'omnivore',
      directive
    });
    org.rallyPoint = pickRally(game, colony, directive);
    CM.coremind.addOrganism(game, org);
  }

  /* Where a newly deployed organism is sent. This is what actually makes the
   * doctrines legible on screen: a Predatory colony's organisms converge on
   * whoever it hates, an Expansionist's fan outward toward unheld ground, and
   * an Entrenched one's never leave the porch. Without it every colony
   * behaved identically and `aggression`/`expansion`/`defense` were decorative. */
  function pickRally(game, colony, directive) {
    const strategy = strategyOf(colony);
    if (directive === 'DEFEND' || strategy.defense > 1.4) {
      return { x: colony.x, y: colony.y, radius: 10 };
    }
    if (directive === 'HUNT' && strategy.aggression > 0.6) {
      // Head for the colony it likes least that is actually reachable.
      let target = null, worst = 1;
      for (const other of game.colonies) {
        if (other.id === colony.id || !other.alive) continue;
        const s = standingBetween(game, colony, other);
        if (s < worst) { worst = s; target = other; }
      }
      if (target) {
        const t = 0.55 + Math.random() * 0.35;    // stop short of the Core itself
        return { x: colony.x + (target.x - colony.x) * t, y: colony.y + (target.y - colony.y) * t, radius: 18 };
      }
    }
    // Expansion: push outward from the Core, further the more expansionist.
    const ang = Math.random() * Math.PI * 2;
    const dist = 14 + strategy.expansion * 26 * Math.random();
    return {
      x: K.clamp(colony.x + Math.cos(ang) * dist, 2, game.world.size - 2),
      y: K.clamp(colony.y + Math.sin(ang) * dist, 2, game.world.size - 2),
      radius: 14
    };
  }

  function rollDirective(colony) {
    const mix = strategyOf(colony).directiveMix;
    let total = 0;
    for (const k in mix) total += mix[k];
    let roll = Math.random() * total;
    for (const k in mix) { roll -= mix[k]; if (roll <= 0) return k; }
    return 'EXPLORE';
  }

  /* Rivals learn the way the player does — from what their organisms meet.
   * Called by the simulation whenever one of their organisms is in a fight. */
  function creditObservation(game, bus, colony, traitIds, amount) {
    if (!colony || colony.isPlayer || !colony.alive) return;
    for (const traitId of traitIds) {
      if (colony.discovered[traitId]) continue;
      colony.observations[traitId] = (colony.observations[traitId] || 0) + amount;
      if (colony.observations[traitId] >= CM.discovery.OBSERVATION_THRESHOLD + 2) {
        colony.discovered[traitId] = true;
        colony.redesignTimer = Math.min(colony.redesignTimer, 6); // reconsider soon
      }
    }
  }

  function recordLoss(game, colony, cause) {
    if (!colony) return;
    colony.losses++;
    if (colony.isPlayer) return;
    colony.lastLossCause = cause;
    // A colony bleeding organisms rethinks sooner than its normal cadence.
    if (colony.losses % 3 === 0) colony.redesignTimer = Math.min(colony.redesignTimer, 8);
  }

  /* --- standing -------------------------------------------------------------
   * Hostility is earned rather than assigned. Every colony starts mildly wary
   * of every other; killing their organisms drives it down, and time with no
   * incidents lets it drift back up. Below HOSTILE_AT the two treat each other
   * as targets on sight rather than only when posturing, which is what turns a
   * border incident into a running feud without any scripted war declaration. */
  const HOSTILE_AT = -0.55;
  const STANDING_PER_KILL = 0.12;

  function standingBetween(game, a, b) {
    if (!a || !b || a === b) return 0;
    const colA = typeof a === 'string' ? game.coloniesById[a] : a;
    if (!colA || !colA.standing) return 0;
    const bId = typeof b === 'string' ? b : b.id;
    return colA.standing[bId] != null ? colA.standing[bId] : 0;
  }

  function areHostile(game, aId, bId) {
    if (!aId || !bId || aId === bId) return false;
    if (aId === WILD_ID || bId === WILD_ID) return false;
    return standingBetween(game, aId, bId) <= HOSTILE_AT
        || standingBetween(game, bId, aId) <= HOSTILE_AT;
  }

  /* Both sides move: the victim resents the killer, and the killer's own
   * regard for a colony it keeps preying on also drops, so predation is
   * self-reinforcing rather than one-sided. */
  function registerKill(game, bus, killerColonyId, victimColonyId) {
    if (!killerColonyId || !victimColonyId || killerColonyId === victimColonyId) return;
    if (killerColonyId === WILD_ID || victimColonyId === WILD_ID) return;
    const victim = game.coloniesById[victimColonyId];
    const killer = game.coloniesById[killerColonyId];
    if (!victim || !killer) return;
    const before = areHostile(game, killerColonyId, victimColonyId);
    victim.standing[killerColonyId] = K.clamp((victim.standing[killerColonyId] || 0) - STANDING_PER_KILL, -1, 1);
    killer.standing[victimColonyId] = K.clamp((killer.standing[victimColonyId] || 0) - STANDING_PER_KILL * 0.4, -1, 1);
    if (!before && areHostile(game, killerColonyId, victimColonyId)) {
      const involvesPlayer = victim.isPlayer || killer.isPlayer;
      CM.discovery.pushEvent(game, bus, {
        kind: involvesPlayer ? 'warn' : 'rival', icon: '\u{2694}',
        message: involvesPlayer
          ? `${(victim.isPlayer ? killer : victim).name} is now openly hostile to you.`
          : `${victim.name} and ${killer.name} have turned on each other.`,
        x: victim.x, y: victim.y, colonyId: victim.isPlayer ? killer.id : victim.id
      });
    }
  }

  /* Standing recovers slowly when nothing is happening, so an old grudge can
   * cool if both sides leave each other alone. */
  function decayStanding(colony, dt) {
    for (const id in colony.standing) {
      const v = colony.standing[id];
      if (v < -0.25) colony.standing[id] = Math.min(-0.25, v + 0.004 * dt);
    }
  }

  // --- territory -------------------------------------------------------------
  function initTerritory(game) {
    game.territory = {
      cell: TERR_CELL, size: TERR_SIZE,
      owner: new Int8Array(TERR_SIZE * TERR_SIZE).fill(-1),  // colony index, -1 unclaimed
      strength: new Float32Array(TERR_SIZE * TERR_SIZE),
      contested: new Uint8Array(TERR_SIZE * TERR_SIZE),
      timer: 0
    };
  }

  /* Recomputed on a slow cadence rather than per tick: it is a coarse 32x32
   * field and nothing about it needs to be frame-accurate. Influence comes
   * from Cores (strong, fixed) and from living organisms (weak, mobile), so
   * territory follows where a colony actually *is*, not where it claims. */
  function updateTerritory(game, dt) {
    const terr = game.territory;
    if (!terr) return;
    terr.timer -= dt;
    if (terr.timer > 0) return;
    terr.timer = 2.5;

    const n = TERR_SIZE * TERR_SIZE;
    const colonies = game.colonies;
    const influence = [];
    for (let c = 0; c < colonies.length; c++) influence.push(new Float32Array(n));

    for (let c = 0; c < colonies.length; c++) {
      const colony = colonies[c];
      if (!colony.alive) continue;
      stamp(influence[c], colony.x, colony.y, 5, 9);
    }
    for (const org of game.organisms) {
      if (!org.alive || org.ownerId === WILD_ID) continue;
      const ci = colonies.findIndex(c => c.id === org.ownerId);
      if (ci < 0) continue;
      stamp(influence[ci], org.x, org.y, 2, 1.1);
    }

    for (let i = 0; i < n; i++) {
      let bestC = -1, best = 0, second = 0;
      for (let c = 0; c < colonies.length; c++) {
        const v = influence[c][i];
        if (v > best) { second = best; best = v; bestC = c; }
        else if (v > second) second = v;
      }
      terr.owner[i] = best > 0.8 ? bestC : -1;
      terr.strength[i] = best;
      // "Contested" means two colonies have comparable presence here — the
      // border friction that drives raids without any scripted war.
      terr.contested[i] = (best > 0.8 && second > best * 0.55) ? 1 : 0;
    }

    function stamp(field, wx, wy, radius, weight) {
      const cx = Math.floor(wx / TERR_CELL), cy = Math.floor(wy / TERR_CELL);
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const tx = cx + dx, ty = cy + dy;
          if (tx < 0 || ty < 0 || tx >= TERR_SIZE || ty >= TERR_SIZE) continue;
          const d = Math.hypot(dx, dy);
          if (d > radius) continue;
          field[ty * TERR_SIZE + tx] += weight * (1 - d / (radius + 1));
        }
      }
    }
  }

  function territoryOwnerAt(game, x, y) {
    const terr = game.territory;
    if (!terr) return null;
    const tx = Math.floor(x / TERR_CELL), ty = Math.floor(y / TERR_CELL);
    if (tx < 0 || ty < 0 || tx >= TERR_SIZE || ty >= TERR_SIZE) return null;
    const owner = terr.owner[ty * TERR_SIZE + tx];
    return owner >= 0 ? game.colonies[owner] : null;
  }

  function territoryCounts(game) {
    const terr = game.territory;
    const out = {};
    if (!terr) return out;
    for (const c of game.colonies) out[c.id] = 0;
    for (let i = 0; i < terr.owner.length; i++) {
      const o = terr.owner[i];
      if (o >= 0 && game.colonies[o]) out[game.colonies[o].id]++;
    }
    return out;
  }

  /* A Core takes damage when hostile organisms stand on it with nothing left
   * to stop them. A colony whose Core reaches zero collapses: its organisms
   * are released as wild rather than vanishing, because a population does not
   * evaporate when its leadership does. */
  function damageCore(game, bus, colony, amount) {
    if (!colony.alive) return;
    colony.integrity -= amount;
    if (colony.integrity > 0) return;
    /* A Deep Sanctum is a second seat for the Coremind, buried past anything
     * that can reach it from the surface. Losing the surface Core no longer
     * ends the colony — it falls back to the sanctum and rebuilds from there.
     * That is what the abyssal tier is *for*: the endgame is not a bigger
     * number, it is becoming impossible to kill from above. */
    if (CM.structures.hasSanctum(game, colony.id)) {
      const seat = CM.structures.all(game)
        .find(s => s.done && s.colonyId === colony.id && CM.structures.TYPES[s.type].endgame);
      colony.integrity = 55;
      if (seat && !colony.__fellBack) {
        colony.__fellBack = true;
        colony.x = seat.x; colony.y = seat.y;
        CM.discovery.pushEvent(game, bus, {
          kind: colony.isPlayer ? 'warn' : 'rival', icon: '\u{1F52E}',
          message: colony.isPlayer
            ? 'Your surface Core is gone. The Coremind falls back to the Deep Sanctum — you are still here.'
            : `${colony.name}'s Core fell, but it survives in a Deep Sanctum.`,
          x: seat.x, y: seat.y, colonyId: colony.id
        });
      }
      return;
    }
    collapse(game, bus, colony);
  }

  function collapse(game, bus, colony) {
    colony.alive = false;
    colony.integrity = 0;
    // The tunnels go with it — an abandoned network is not a prize another
    // colony can simply walk into.
    CM.structures.removeStructuresOf(game, colony.id);
    let released = 0;
    for (const org of game.organisms) {
      if (org.ownerId === colony.id) {
        org.ownerId = WILD_ID;
        org.speciesId = org.speciesId || 'grazer';
        org.directive = null;
        released++;
      }
    }
    CM.discovery.pushEvent(game, bus, {
      kind: 'rival', icon: '\u{1F480}',
      message: `${colony.name} has collapsed. ${released} of its organisms are now feral.`,
      x: colony.x, y: colony.y, colonyId: colony.id
    });
  }

  function livingRivals(game) {
    return game.colonies ? game.colonies.filter(c => !c.isPlayer && c.alive) : [];
  }

  CM.colony = {
    PLAYER_ID, WILD_ID, STRATEGIES, STRATEGY_KEYS, TERR_CELL, TERR_SIZE,
    BIOMASS_CAP, ENERGY_CAP,
    newColony, createAll, strategyOf, chooseDesign, designTraitIds,
    tick, tryDeploy, creditObservation, recordLoss, perceivedThreat, isAwake,
    HOSTILE_AT, standingBetween, areHostile, registerKill, pickRally,
    initTerritory, updateTerritory, territoryOwnerAt, territoryCounts,
    damageCore, collapse, livingRivals, populationCap
  };
})(window.CM = window.CM || {});
