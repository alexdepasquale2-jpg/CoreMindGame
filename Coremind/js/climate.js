/* Coremind — climate. A season cycle plus occasional weather events shift
 * the whole map's temperature and plant growth over a session.
 *
 * This exists so that a design that was correct an hour ago can stop being
 * correct: a cold snap punishes a colony bred entirely for heat, a drought
 * turns a comfortable grassland into a contested one. It is the engine's
 * main source of "a new ecological problem emerges" without scripting one.
 */
(function (CM) {
  'use strict';
  const K = CM.core;

  const SEASON_LENGTH = 260;                   // sim-seconds per season
  const SEASONS = ['Thaw', 'High Sun', 'Fade', 'Deep Cold'];
  const SEASON_TEMP = [2, 9, 0, -9];           // degrees added to the whole map
  const SEASON_GROWTH = [1.15, 1.0, 0.85, 0.55];

  const EVENTS = {
    DROUGHT:   { key: 'DROUGHT',   name: 'Drought',    temp: 5,   growth: 0.25, minDur: 90, maxDur: 200,
                 icon: '\u{1F525}', message: 'A drought has set in — plant growth is collapsing.' },
    RAINS:     { key: 'RAINS',     name: 'Rains',      temp: -2,  growth: 1.9,  minDur: 70, maxDur: 150,
                 icon: '\u{1F327}', message: 'Heavy rains — the land is growing back fast.' },
    COLD_SNAP: { key: 'COLD_SNAP', name: 'Cold Snap',  temp: -14, growth: 0.6,  minDur: 60, maxDur: 130,
                 icon: '\u{2744}',  message: 'A cold snap is sweeping the region.' },
    HEATWAVE:  { key: 'HEATWAVE',  name: 'Heatwave',   temp: 13,  growth: 0.7,  minDur: 60, maxDur: 130,
                 icon: '\u{1F321}', message: 'A heatwave is pushing temperatures past what most life tolerates.' }
  };
  const EVENT_KEYS = Object.keys(EVENTS);

  function newState(seed) {
    return {
      rngSeed: (seed ^ 0x7f4a7c15) >>> 0,
      seasonIndex: 0,
      seasonTimer: 0,
      event: null,          // {key, remaining}
      nextEventIn: 120 + Math.random() * 180
    };
  }

  function seasonName(state) { return SEASONS[state.seasonIndex]; }

  /* The two numbers the rest of the simulation actually reads:
   *   world.climateOffset — degrees added to every temperature lookup
   *   world.growthScale   — multiplier on plant regrowth
   * Keeping it to exactly two channels is deliberate: every system that
   * cares about weather already cares about temperature or food, and a
   * third channel would mean auditing all of them again. */
  function apply(game) {
    const c = game.climate;
    const season = c.seasonIndex;
    let temp = SEASON_TEMP[season];
    let growth = SEASON_GROWTH[season];
    if (c.event) {
      const info = EVENTS[c.event.key];
      temp += info.temp;
      growth *= info.growth;
    }
    game.world.climateOffset = temp;
    game.world.growthScale = growth;
  }

  function tick(game, bus, dt) {
    const c = game.climate;
    if (!c) return;

    c.seasonTimer += dt;
    if (c.seasonTimer >= SEASON_LENGTH) {
      c.seasonTimer -= SEASON_LENGTH;
      c.seasonIndex = (c.seasonIndex + 1) % SEASONS.length;
      CM.discovery.pushEvent(game, bus, {
        kind: 'climate', icon: '\u{1F5D3}',
        message: `The season turns: ${SEASONS[c.seasonIndex]}.`
      });
    }

    if (c.event) {
      c.event.remaining -= dt;
      if (c.event.remaining <= 0) {
        const ended = EVENTS[c.event.key];
        c.event = null;
        c.nextEventIn = 200 + Math.random() * 320;
        CM.discovery.pushEvent(game, bus, {
          kind: 'climate', icon: '\u{1F324}',
          message: `The ${ended.name.toLowerCase()} has broken.`
        });
      }
    } else {
      c.nextEventIn -= dt;
      if (c.nextEventIn <= 0) {
        // Weight the roll by season, so a drought in Deep Cold is unlikely
        // and a cold snap in High Sun is a genuine surprise rather than noise.
        const key = rollEvent(c.seasonIndex);
        const info = EVENTS[key];
        c.event = { key, remaining: info.minDur + Math.random() * (info.maxDur - info.minDur) };
        CM.discovery.pushEvent(game, bus, {
          kind: 'warn', icon: info.icon, message: info.message
        });
      }
    }

    apply(game);
  }

  function rollEvent(seasonIndex) {
    const weights = {
      DROUGHT:   [0.8, 1.8, 0.9, 0.15],
      RAINS:     [1.5, 0.9, 1.4, 0.5],
      COLD_SNAP: [0.9, 0.2, 1.0, 1.9],
      HEATWAVE:  [0.5, 1.9, 0.6, 0.1]
    };
    let total = 0;
    for (const k of EVENT_KEYS) total += weights[k][seasonIndex];
    let roll = Math.random() * total;
    for (const k of EVENT_KEYS) {
      roll -= weights[k][seasonIndex];
      if (roll <= 0) return k;
    }
    return EVENT_KEYS[0];
  }

  function describe(game) {
    const c = game.climate;
    if (!c) return '';
    const season = SEASONS[c.seasonIndex];
    if (!c.event) return season;
    return `${season} · ${EVENTS[c.event.key].name}`;
  }

  CM.climate = { SEASONS, SEASON_LENGTH, EVENTS, newState, seasonName, tick, apply, describe };
})(window.CM = window.CM || {});
