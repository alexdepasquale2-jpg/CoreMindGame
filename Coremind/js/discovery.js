/* Coremind — DISCOVER -> ANALYZE -> EXTRACT.
 *
 * Traits are never unlocked by a level-up; they're earned by watching wild
 * organisms use them. Every encounter between a player organism and a wild
 * one leaves partial evidence; killing a wild organism leaves a biological
 * sample the player can walk up to and extract for a much bigger dose of
 * evidence. Once a trait has enough evidence behind it, it becomes available
 * in the genome designer.
 */
(function (CM) {
  'use strict';

  const OBSERVATION_THRESHOLD = 4;
  const EXTRACT_CREDIT = 3;
  const ENCOUNTER_CREDIT = 1;
  const SAMPLE_TTL = 180; // seconds of sim time before an unclaimed sample decays

  function newDiscoveryState() {
    return {
      events: [],
      nextEventId: 1,
      observations: {},     // traitId -> count
      discoveredTraits: {},  // traitId -> true
      knownSpecies: {},      // speciesId -> true
      samples: []            // {id, x, y, speciesId, traits, name, ttl}
    };
  }

  function pushEvent(game, bus, evt) {
    const e = Object.assign({
      id: 'evt_' + (game.discovery.nextEventId++),
      time: game.simTime,
      read: false
    }, evt);
    game.discovery.events.unshift(e);
    if (game.discovery.events.length > 200) game.discovery.events.length = 200;
    bus.emit('event', e);
    return e;
  }

  function recordSighting(game, bus, speciesId, x, y) {
    const D = game.discovery;
    if (D.knownSpecies[speciesId]) return;
    D.knownSpecies[speciesId] = true;
    const sp = CM.traits.WILD_BY_ID[speciesId];
    pushEvent(game, bus, {
      kind: 'discovery', icon: sp && sp.tier === 'predator' ? '\u{1F439}' : '\u{1F43F}',
      message: `Your organism discovered a new ${sp ? sp.tier : 'species'}: ${sp ? sp.name : speciesId}.`,
      x, y, speciesId
    });
  }

  /* Watching counts as research.
   *
   * Discovery used to fire only from `resolveDeath`, which meant credit
   * existed on exactly two paths: your organism killed something, or
   * something killed your organism. A colony on GATHER does neither — and
   * GATHER is the opening directive — so a measured 1400 sim-seconds of
   * ordinary play produced an entirely empty observation ledger and not one
   * discovery. The brief's own loop starts with organisms *encountering*
   * species, so proximity has to be worth something.
   *
   * Only traits with an outward visual signature can be learned this way: a
   * shell or a set of claws is visible from across a meadow, but nothing
   * about standing near an animal reveals its biochemistry. Those still need
   * a fight or a sample, which is what keeps EXTRACT worth doing. */
  const SIGHTING_RATE = 0.05;     // credit per second of sustained proximity

  function observeNearby(game, bus, observer, targets, dt) {
    if (observer.ownerId !== 'player') return;   // only the player runs a lab
    for (const target of targets) {
      for (const traitId of target.traits) {
        const trait = CM.traits.TRAITS_BY_ID[traitId];
        if (!trait || !trait.visual_modifier) continue;
        creditTrait(game, bus, traitId, SIGHTING_RATE * dt);
      }
    }
  }

  function creditTrait(game, bus, traitId, amount) {
    const D = game.discovery;
    if (D.discoveredTraits[traitId]) return;
    D.observations[traitId] = (D.observations[traitId] || 0) + amount;
    if (D.observations[traitId] >= OBSERVATION_THRESHOLD) {
      D.discoveredTraits[traitId] = true;
      const t = CM.traits.TRAITS_BY_ID[traitId];
      pushEvent(game, bus, {
        kind: 'discovery', icon: '\u{1F9EC}',
        message: `Biological discovery: ${t.name.toUpperCase()} can now be designed into your organisms.`,
        traitId
      });
    }
  }

  /* What the Coremind can say about an organism from watching it fight —
   * the raw material of the OBSERVATION report below. Both read the
   * organism's real traits, so the report can never describe a creature
   * that isn't the one that was actually there. */
  const DAMAGE_TYPES = { venom: 'Neurotoxic', acid: 'Corrosive', claws: 'Physical (lacerating)', bite: 'Physical (crushing)' };
  const DEFENSE_NOTES = { armor: 'Heavy external shell', camouflage: 'Adaptive colouration', regeneration: 'Rapid tissue repair', burrowing: 'Subterranean evasion' };

  function observedDamageType(org) {
    for (const id of org.traits) if (DAMAGE_TYPES[id]) return DAMAGE_TYPES[id];
    return 'Physical (blunt)';
  }
  function observedDefense(org) {
    for (const id of org.traits) if (DEFENSE_NOTES[id]) return DEFENSE_NOTES[id];
    return 'None apparent';
  }

  /* outcome: 'player_killed' | 'wild_killed' | 'player_fled' | 'wild_fled' */
  function recordEncounter(game, bus, playerOrg, wildOrg, outcome, x, y) {
    recordSighting(game, bus, wildOrg.speciesId, x, y);
    for (const traitId of wildOrg.traits) {
      const t = CM.traits.TRAITS_BY_ID[traitId];
      if (!t) continue;
      const relevant = (outcome === 'player_killed' && (t.category === 'OFFENSE'))
        || (outcome === 'wild_killed' && (t.category === 'DEFENSE'))
        || t.category === 'SENSE' || t.category === 'BODY' || t.category === 'METABOLISM' || t.category === 'REPRODUCTION';
      if (relevant) creditTrait(game, bus, traitId, ENCOUNTER_CREDIT);
    }
    if (outcome === 'player_killed') {
      const identified = !!game.discovery.knownSpecies[wildOrg.speciesId];
      pushEvent(game, bus, {
        kind: 'death', icon: '☠',
        message: `${identified ? wildOrg.name : 'An unknown predator'} killed ${playerOrg.name}.`,
        // The report the player opens to work out what to build next. It is
        // the same data the trait ledger is accumulating, shown in plain
        // language at the moment it was earned.
        observation: {
          damageType: observedDamageType(wildOrg),
          defense: observedDefense(wildOrg),
          species: identified ? wildOrg.name : 'Unidentified'
        },
        x, y, orgId: playerOrg.id, speciesId: wildOrg.speciesId
      });
    }
  }

  function spawnSample(game, world, x, y, wildOrg) {
    const D = game.discovery;
    const sample = {
      id: 'sample_' + (game.discovery.nextEventId++),
      x, y, speciesId: wildOrg.speciesId, traits: wildOrg.traits.slice(),
      name: wildOrg.name, ttl: SAMPLE_TTL
    };
    D.samples.push(sample);
    return sample;
  }

  function tickSamples(game, dt) {
    const D = game.discovery;
    for (let i = D.samples.length - 1; i >= 0; i--) {
      D.samples[i].ttl -= dt;
      if (D.samples[i].ttl <= 0) D.samples.splice(i, 1);
    }
  }

  function extractSample(game, bus, sampleId) {
    const D = game.discovery;
    const i = D.samples.findIndex(s => s.id === sampleId);
    if (i < 0) return false;
    const sample = D.samples[i];
    D.samples.splice(i, 1);
    for (const traitId of sample.traits) creditTrait(game, bus, traitId, EXTRACT_CREDIT);
    pushEvent(game, bus, {
      kind: 'analysis', icon: '\u{1F52C}',
      message: `Extracted a biological sample from ${sample.name}.`,
      x: sample.x, y: sample.y
    });
    return true;
  }

  function observationProgress(game, traitId) {
    return Math.min(1, (game.discovery.observations[traitId] || 0) / OBSERVATION_THRESHOLD);
  }

  /* Every trait the Coremind has partial evidence for but hasn't identified
   * yet — the research backlog the ANALYZE tab renders, so progress toward a
   * discovery is visible while it accumulates instead of only at the moment
   * it completes. */
  function researchInProgress(game) {
    const out = [];
    for (const traitId in game.discovery.observations) {
      if (game.discovery.discoveredTraits[traitId]) continue;
      const trait = CM.traits.TRAITS_BY_ID[traitId];
      if (!trait) continue;
      out.push({
        traitId, trait,
        observations: game.discovery.observations[traitId],
        needed: OBSERVATION_THRESHOLD,
        progress: observationProgress(game, traitId)
      });
    }
    return out.sort((a, b) => b.progress - a.progress);
  }

  CM.discovery = {
    OBSERVATION_THRESHOLD, newDiscoveryState, pushEvent, recordSighting,
    recordEncounter, spawnSample, tickSamples, extractSample, observationProgress, observeNearby,
    SIGHTING_RATE,
    researchInProgress, observedDamageType, observedDefense
  };
})(window.CM = window.CM || {});
