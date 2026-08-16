/* Coremind — flora. Plants are not one undifferentiated "food" number: each
 * biome grows particular species, and those species differ in how much they
 * feed a grazer, how fast they come back, and how hard they fight back.
 *
 * Defended plants are what make herbivory a design problem rather than a
 * formality — and they are a discovery source in their own right, since an
 * organism poisoned by a toxin has observed a real chemical defense.
 */
(function (CM) {
  'use strict';
  const K = CM.core;

  /* Ids are indices into this array and are written into a Uint8Array per
   * cell, so this list is append-only. 0 is reserved for "nothing grows". */
  const PLANTS = [
    { id: 0, key: 'none', name: 'Barren', nutrition: 0, regrowth: 0, toxicity: 0, thorns: 0,
      color: [0, 0, 0], biomes: [] },

    { id: 1, key: 'grass', name: 'Meadow Grass', nutrition: 1, regrowth: 0.022, toxicity: 0, thorns: 0,
      color: [122, 168, 74],
      biomes: ['GRASSLAND', 'SAVANNA'] },

    { id: 2, key: 'fernbed', name: 'Fernbed', nutrition: 1.25, regrowth: 0.016, toxicity: 0, thorns: 0,
      color: [76, 136, 78],
      biomes: ['FOREST', 'TAIGA'] },

    { id: 3, key: 'bitterleaf', name: 'Bitterleaf', nutrition: 1.5, regrowth: 0.014, toxicity: 0.55, thorns: 0,
      color: [110, 154, 196],
      biomes: ['FOREST', 'JUNGLE', 'MARSH'] },

    { id: 4, key: 'thornscrub', name: 'Thornscrub', nutrition: 1.7, regrowth: 0.011, toxicity: 0, thorns: 0.6,
      color: [150, 126, 66],
      biomes: ['SAVANNA', 'DESERT', 'ROCK'] },

    { id: 5, key: 'succulent', name: 'Water Succulent', nutrition: 1.1, regrowth: 0.008, toxicity: 0, thorns: 0.25,
      // The desert's compromise: feeds badly, but drinking from it is the
      // difference between crossing a waste and dying in it.
      water: 26,
      color: [128, 176, 140],
      biomes: ['DESERT', 'BEACH'] },

    { id: 6, key: 'canopy_fruit', name: 'Canopy Fruit', nutrition: 2.4, regrowth: 0.013, toxicity: 0, thorns: 0,
      color: [206, 138, 74],
      biomes: ['JUNGLE'] },

    { id: 7, key: 'bloodcap', name: 'Bloodcap Fungus', nutrition: 2.0, regrowth: 0.02, toxicity: 0.85, thorns: 0,
      color: [172, 66, 74],
      biomes: ['MARSH', 'JUNGLE', 'TAIGA'] },

    { id: 8, key: 'lichen', name: 'Frost Lichen', nutrition: 0.8, regrowth: 0.006, toxicity: 0, thorns: 0,
      color: [168, 180, 168],
      biomes: ['TUNDRA', 'ICE', 'MOUNTAIN'] },

    { id: 9, key: 'reedmat', name: 'Reed Mat', nutrition: 1.15, regrowth: 0.026, toxicity: 0, thorns: 0,
      water: 14,
      color: [96, 148, 104],
      biomes: ['MARSH', 'SHALLOWS'] }
  ];

  const BY_ID = PLANTS;
  const BY_KEY = {};
  for (const p of PLANTS) BY_KEY[p.key] = p;

  // biome key -> candidate plant ids, built once
  const BY_BIOME = {};
  for (const p of PLANTS) {
    for (const b of p.biomes) (BY_BIOME[b] || (BY_BIOME[b] = [])).push(p.id);
  }

  function get(id) { return BY_ID[id] || BY_ID[0]; }
  function regrowthRate(id) { return (BY_ID[id] || BY_ID[0]).regrowth; }
  function isDefended(id) { const p = get(id); return p.toxicity > 0 || p.thorns > 0; }

  /* Assign a plant species and a food capacity to every cell. Which of a
   * biome's candidate species grows where is driven by low-frequency noise,
   * so species form patches a player can actually learn the shape of rather
   * than salt-and-pepper randomness. */
  function populate(world, seed) {
    const W = CM.world;
    const n = world.size * world.size;
    for (let y = 0; y < world.size; y++) {
      for (let x = 0; x < world.size; x++) {
        const i = W.idx(x, y);
        const info = W.BIOME_INFO[world.biome[i]];
        const candidates = BY_BIOME[info.key];
        if (!candidates || !candidates.length || info.foodCap <= 0) {
          world.flora[i] = 0; world.foodCap[i] = 0; world.food[i] = 0;
          continue;
        }
        // fbm rather than a single noise2 octave: raw value noise is
        // axis-aligned and paints visible vertical banding into the terrain.
        const pick = K.clamp01(K.fbm(seed + 9100, x * 0.045, y * 0.045, 3));
        const plant = candidates[Math.min(candidates.length - 1, Math.floor(pick * candidates.length))];
        world.flora[i] = plant;

        // Capacity blends the biome's ceiling with local moisture/warmth, so
        // the same biome is richer in its wetter, milder parts.
        const m = world.moisture[i];
        const t = K.clamp01(K.invLerp(-8, 30, world.temp[i]));
        const quality = 0.45 + m * 0.35 + t * 0.2;
        const cap = info.foodCap * quality;
        world.foodCap[i] = cap;
        world.food[i] = cap * (0.45 + 0.55 * K.clamp01(K.fbm(seed + 5000, x * 0.09, y * 0.09, 3)));
      }
    }
  }

  /* What eating one mouthful of this plant does. Nutrition scales the food
   * value; toxin and thorn damage are returned separately so the caller can
   * decide who resists them — that is where traits get to matter. */
  function biteOutcome(plantId, eater, amount) {
    const p = get(plantId);
    const food = amount * p.nutrition;
    let toxin = 0, physical = 0;
    if (p.toxicity > 0) {
      // Venom-producing organisms have the biochemistry to handle toxins;
      // this is the payoff for a trait that otherwise only does damage.
      const resist = eater.behaviors && eater.behaviors.has('damage_over_time') ? 0.25 : 1;
      toxin = p.toxicity * amount * 0.12 * resist;
    }
    if (p.thorns > 0) {
      // Armor is literally for this.
      const armor = K.clamp01((eater.stats.armor || 0) / 40);
      physical = p.thorns * amount * 0.10 * (1 - armor);
    }
    return { food, toxin, physical, water: (p.water || 0) * (amount / 16) };
  }

  CM.flora = {
    PLANTS, BY_KEY, get, regrowthRate, isDefended, populate, biteOutcome
  };
})(window.CM = window.CM || {});
