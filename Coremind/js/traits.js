/* Coremind — the trait catalog and the base organism schema.
 *
 * Every organism, player-designed or wild, is built the same way: a base
 * stat block plus the summed deltas of up to six traits (one per category
 * slot). Nothing here hard-codes a species' behaviour — wild species (below)
 * are just trait combinations with a default AI disposition, exactly like a
 * player design.
 */
(function (CM) {
  'use strict';

  const CATEGORIES = ['BODY', 'SENSE', 'METABOLISM', 'DEFENSE', 'OFFENSE', 'REPRODUCTION'];

  /* The intentionally weak, generic starting point. Every stat an organism
   * can have is listed here — traits only ever add a delta on top. */
  const BASE_STATS = {
    health: 40, energyMax: 40, speed: 13, size: 10, vision: 16, sense_radius: 9,
    attack: 5, defense: 3, temperature_tolerance: 9, water_requirement: 0.55,
    reproduction_rate: 0.16, metabolism: 11, camouflage: 4, venom: 0, armor: 0, digging: 0
  };

  const STAT_KEYS = Object.keys(BASE_STATS);
  const STAT_MIN = { health: 5, energyMax: 5, speed: 2, size: 3, vision: 2, sense_radius: 2, attack: 0, defense: 0, temperature_tolerance: 2, water_requirement: 0.1, reproduction_rate: 0.02, metabolism: 3, camouflage: 0, venom: 0, armor: 0, digging: 0 };

  /* stat_modifiers are additive deltas over BASE_STATS. energy_cost / biomass_cost
   * are paid once, at CREATE ORGANISM time (see genome.js). compatibility /
   * incompatibility are informational pairings shown in the designer — they
   * tell the player which traits play well together, they don't hide extra
   * math the UI can't explain. */
  const TRAITS = [
    // -- BODY (movement) --
    { id: 'basic_legs', name: 'Basic Legs', category: 'BODY',
      description: 'Sturdier limbs for covering ground.',
      stat_modifiers: { speed: 10, metabolism: 2 }, energy_cost: 4, biomass_cost: 6,
      compatibility: ['fast_movement'], incompatibility: [],
      visual_modifier: 'legs', behavior_modifier: null },
    { id: 'fast_movement', name: 'Fast Movement', category: 'BODY',
      description: 'A streamlined build built for speed, at a metabolic cost.',
      stat_modifiers: { speed: 24, metabolism: 8, water_requirement: 0.15 }, energy_cost: 8, biomass_cost: 10,
      compatibility: ['vibration_sense'], incompatibility: ['armor'],
      visual_modifier: 'streamlined', behavior_modifier: null },
    { id: 'burrowing', name: 'Burrowing', category: 'BODY',
      description: 'Digging limbs that let this organism vanish underground to escape danger.',
      stat_modifiers: { digging: 45, speed: -6, defense: 6, water_requirement: -0.18 }, energy_cost: 6, biomass_cost: 9,
      compatibility: ['camouflage'], incompatibility: ['fast_movement'],
      visual_modifier: 'digger', behavior_modifier: 'can_burrow_flee' },

    // -- SENSE --
    { id: 'vision', name: 'Vision', category: 'SENSE',
      description: 'Larger eyes — spots food and threats from further away.',
      stat_modifiers: { vision: 26, sense_radius: 6 }, energy_cost: 3, biomass_cost: 5,
      compatibility: ['fast_movement'], incompatibility: [],
      visual_modifier: 'eyes', behavior_modifier: null },
    { id: 'chem_sense', name: 'Chemical Sensing', category: 'SENSE',
      description: 'Detects food and creatures by scent, even without line of sight.',
      stat_modifiers: { sense_radius: 11, vision: 4 }, energy_cost: 4, biomass_cost: 6,
      compatibility: ['venom'], incompatibility: [],
      visual_modifier: 'antennae', behavior_modifier: 'sense_through_walls' },
    { id: 'vibration_sense', name: 'Vibration Sensing', category: 'SENSE',
      description: 'Feels footsteps through the ground — an early warning against predators.',
      stat_modifiers: { sense_radius: 9 }, energy_cost: 4, biomass_cost: 6,
      compatibility: ['burrowing'], incompatibility: [],
      visual_modifier: 'whiskers', behavior_modifier: 'early_warning' },

    // -- DEFENSE --
    { id: 'armor', name: 'Armor', category: 'DEFENSE',
      description: 'A heavy external shell. Excellent protection, but slow and hungry.',
      // -7, not -13: the base speed is 13, so a -13 penalty drove every
      // armored build straight into the speed floor. That made armor read as
      // "this organism is now furniture" rather than as a tradeoff, and left
      // armored wild predators unable to chase anything at all.
      stat_modifiers: { defense: 32, armor: 32, speed: -7, metabolism: 7, water_requirement: 0.12 }, energy_cost: 6, biomass_cost: 14,
      compatibility: ['regeneration'], incompatibility: ['fast_movement', 'burrowing'],
      visual_modifier: 'shell', behavior_modifier: null },
    { id: 'camouflage', name: 'Camouflage', category: 'DEFENSE',
      description: 'Colouration that blends with the environment, reducing detection.',
      stat_modifiers: { camouflage: 38, speed: -3 }, energy_cost: 5, biomass_cost: 10,
      compatibility: ['burrowing'], incompatibility: [],
      visual_modifier: 'mottled', behavior_modifier: 'reduce_detection' },
    { id: 'regeneration', name: 'Regeneration', category: 'DEFENSE',
      description: 'Slowly heals wounds over time, at a steady energy and water cost.',
      stat_modifiers: { metabolism: 10, water_requirement: 0.15 }, energy_cost: 8, biomass_cost: 12,
      compatibility: ['armor'], incompatibility: [],
      visual_modifier: 'veined', behavior_modifier: 'passive_heal' },

    // -- OFFENSE --
    { id: 'bite', name: 'Bite', category: 'OFFENSE',
      description: 'Basic jaws. Reliable, low-cost damage.',
      stat_modifiers: { attack: 16 }, energy_cost: 3, biomass_cost: 6,
      compatibility: [], incompatibility: [],
      visual_modifier: 'jaws', behavior_modifier: null },
    { id: 'claws', name: 'Claws', category: 'OFFENSE',
      description: 'Sharp claws for tearing. Strong, but a little slower.',
      stat_modifiers: { attack: 25, speed: -2 }, energy_cost: 5, biomass_cost: 9,
      compatibility: ['armor'], incompatibility: [],
      visual_modifier: 'claws', behavior_modifier: null },
    { id: 'venom', name: 'Venom', category: 'OFFENSE',
      description: 'A toxic bite that keeps damaging the target after contact.',
      stat_modifiers: { venom: 36, attack: 9 }, energy_cost: 7, biomass_cost: 13,
      compatibility: ['chem_sense'], incompatibility: [],
      visual_modifier: 'venom_glands', behavior_modifier: 'damage_over_time' },
    { id: 'acid', name: 'Acid', category: 'OFFENSE',
      description: 'A corrosive attack that eats through armor.',
      stat_modifiers: { attack: 19 }, energy_cost: 7, biomass_cost: 12,
      compatibility: [], incompatibility: ['armor'],
      visual_modifier: 'acid_sacs', behavior_modifier: 'armor_pierce' },

    // -- METABOLISM --
    { id: 'efficient_metabolism', name: 'Efficient Metabolism', category: 'METABOLISM',
      description: 'Burns energy and water more slowly — needs to eat and drink less often.',
      stat_modifiers: { metabolism: -19, water_requirement: -0.2 }, energy_cost: 4, biomass_cost: 8,
      compatibility: ['prolific_broodsac'], incompatibility: ['armor'],
      visual_modifier: 'lean', behavior_modifier: null },
    { id: 'heat_resistance', name: 'Heat Resistance', category: 'METABOLISM',
      description: 'Tolerates a much wider range of hot climates, and retains water better.',
      stat_modifiers: { temperature_tolerance: 19, water_requirement: -0.15 }, energy_cost: 3, biomass_cost: 7,
      compatibility: [], incompatibility: ['cold_resistance'],
      visual_modifier: 'warm_hued', behavior_modifier: null },
    { id: 'cold_resistance', name: 'Cold Resistance', category: 'METABOLISM',
      description: 'Tolerates a much wider range of cold climates.',
      stat_modifiers: { temperature_tolerance: 19 }, energy_cost: 3, biomass_cost: 7,
      compatibility: [], incompatibility: ['heat_resistance'],
      visual_modifier: 'cool_hued', behavior_modifier: null },

    // -- REPRODUCTION --
    { id: 'prolific_broodsac', name: 'Prolific Broodsac', category: 'REPRODUCTION',
      description: 'Produces offspring far more readily, at the cost of a smaller body.',
      stat_modifiers: { reproduction_rate: 0.4, size: -4 }, energy_cost: 6, biomass_cost: 10,
      compatibility: ['efficient_metabolism'], incompatibility: [],
      visual_modifier: 'brood_sac', behavior_modifier: null }
  ];

  const TRAITS_BY_ID = {};
  const TRAITS_BY_CATEGORY = {};
  for (const cat of CATEGORIES) TRAITS_BY_CATEGORY[cat] = [];
  for (const t of TRAITS) { TRAITS_BY_ID[t.id] = t; TRAITS_BY_CATEGORY[t.category].push(t); }

  const BASE_CREATE_COST = { biomass: 15, energy: 10 };

  /* Stats where a *lower* number is the better outcome. Everything that
   * reasons about whether a modifier is a benefit or a cost — the synergy
   * bonus below, and the designer's +/- colouring — has to consult this, or
   * it will cheerfully report a metabolism increase as an improvement. */
  const LOWER_IS_BETTER = new Set(['metabolism', 'water_requirement']);
  function isBenefit(statKey, delta) {
    return LOWER_IS_BETTER.has(statKey) ? delta < 0 : delta > 0;
  }

  /* Each satisfied `compatibility` pairing amplifies both traits' upsides by
   * this much. Deliberately one-directional: synergy never deepens a trait's
   * own costs, so pairing traits is always a reward for noticing the
   * relationship, never a hidden penalty. */
  const SYNERGY_BONUS = 0.15;

  /* Which declared pairings are actually live in this set of traits. Pure and
   * cheap (<=6 traits), so the designer can call it on every change. */
  function checkCombination(traitIds) {
    const ids = traitIds.filter(Boolean);
    const set = new Set(ids);
    const conflicts = [], synergies = [], seen = new Set();
    for (const id of ids) {
      const t = TRAITS_BY_ID[id];
      if (!t) continue;
      for (const other of t.incompatibility) {
        if (!set.has(other)) continue;
        const key = [id, other].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push({ a: id, b: other });
      }
      for (const other of t.compatibility) {
        if (!set.has(other)) continue;
        const key = 's:' + [id, other].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        synergies.push({ a: id, b: other });
      }
    }
    return { conflicts, synergies };
  }

  /* True when `candidate` could be added to `traitIds` without creating a
   * declared incompatibility. The designer uses this to disable the option
   * rather than letting the player build something the rules forbid. */
  function conflictsWith(traitIds, candidate) {
    const t = TRAITS_BY_ID[candidate];
    if (!t) return null;
    for (const id of traitIds) {
      if (!id || id === candidate) continue;
      const other = TRAITS_BY_ID[id];
      if (!other) continue;
      if (t.incompatibility.includes(id) || other.incompatibility.includes(candidate)) return id;
    }
    return null;
  }

  /* Compute the full stat block for a set of trait ids (one per category,
   * nulls allowed). Pure function — the designer calls this on every tap. */
  function resolveStats(traitIds) {
    const ids = traitIds.filter(Boolean);
    const stats = Object.assign({}, BASE_STATS);

    // Count each trait's live synergy partners first, so the boost applies to
    // every contributor of a pairing rather than depending on iteration order.
    const partners = {};
    for (const { a, b } of checkCombination(ids).synergies) {
      partners[a] = (partners[a] || 0) + 1;
      partners[b] = (partners[b] || 0) + 1;
    }

    for (const id of ids) {
      const t = TRAITS_BY_ID[id];
      if (!t) continue;
      const boost = 1 + SYNERGY_BONUS * (partners[id] || 0);
      for (const k in t.stat_modifiers) {
        const v = t.stat_modifiers[k];
        stats[k] = (stats[k] || 0) + (isBenefit(k, v) ? v * boost : v);
      }
    }
    for (const k of STAT_KEYS) stats[k] = Math.max(STAT_MIN[k] || 0, stats[k]);
    return stats;
  }

  function resolveCost(traitIds) {
    let biomass = BASE_CREATE_COST.biomass, energy = BASE_CREATE_COST.energy;
    for (const id of traitIds) {
      const t = TRAITS_BY_ID[id];
      if (!t) continue;
      biomass += t.biomass_cost; energy += t.energy_cost;
    }
    return { biomass, energy };
  }

  function behaviorModifiers(traitIds) {
    const set = new Set();
    for (const id of traitIds) {
      const t = TRAITS_BY_ID[id];
      if (t && t.behavior_modifier) set.add(t.behavior_modifier);
    }
    return set;
  }

  // --- wild species: the same trait system, an authored preset each --------
  const WILD_SPECIES = [
    { id: 'grazer', name: 'Grazer', tier: 'prey', diet: 'herbivore',
      traits: ['basic_legs', 'vision'], color: '#8fd15a' },
    { id: 'tunnel_mole', name: 'Tunnel Mole', tier: 'prey', diet: 'herbivore',
      traits: ['burrowing', 'basic_legs', 'vibration_sense'], color: '#9a7b5a' },
    { id: 'thistleback', name: 'Thistleback', tier: 'prey', diet: 'herbivore',
      traits: ['armor', 'basic_legs'], color: '#c9b25a' },
    { id: 'stalker', name: 'Stalker', tier: 'predator', diet: 'carnivore',
      traits: ['fast_movement', 'bite'], color: '#d16b5a' },
    // Carries legs deliberately: an armored predator without them cannot
    // close on anything, and a predator that never hunts is not a predator.
    { id: 'shellfang', name: 'Shellfang', tier: 'predator', diet: 'carnivore',
      traits: ['armor', 'claws', 'basic_legs'], color: '#a15ad1' },
    { id: 'needler', name: 'Needler', tier: 'predator', diet: 'carnivore',
      traits: ['venom', 'vibration_sense'], color: '#5ad1c4' },

    /* Subterranean fauna. These never appear on the surface — they are drawn
     * out of the rock by excavation itself, which is what stops the deep
     * tiers from being a safe basement the player retreats into. Depth is the
     * stratum they haunt; the deeper the colony cuts, the worse it meets. */
    { id: 'gnawer', name: 'Rock Gnawer', tier: 'predator', diet: 'carnivore',
      traits: ['burrowing', 'bite', 'vibration_sense'], color: '#b08968', subterranean: 1 },
    { id: 'shalefang', name: 'Shalefang', tier: 'predator', diet: 'carnivore',
      traits: ['armor', 'claws', 'vibration_sense'], color: '#7d6b8f', subterranean: 2 },
    { id: 'hollow_serpent', name: 'Hollow Serpent', tier: 'predator', diet: 'carnivore',
      traits: ['venom', 'fast_movement', 'chem_sense'], color: '#c1557f', subterranean: 3 }
  ];
  const WILD_BY_ID = {};
  for (const s of WILD_SPECIES) WILD_BY_ID[s.id] = s;

  CM.traits = {
    CATEGORIES, TRAITS, TRAITS_BY_ID, TRAITS_BY_CATEGORY,
    BASE_STATS, STAT_KEYS, STAT_MIN, BASE_CREATE_COST,
    LOWER_IS_BETTER, isBenefit, SYNERGY_BONUS, checkCombination, conflictsWith,
    resolveStats, resolveCost, behaviorModifiers,
    WILD_SPECIES, WILD_BY_ID
  };
})(window.CM = window.CM || {});
