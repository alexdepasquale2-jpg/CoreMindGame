/* Coremind — reusable utility AI. One function decides what any organism
 * wants to do next from its needs, senses and the player's directive; it
 * never knows about a specific species. Pure logic, no canvas/DOM — the
 * simulation gathers `ctx` (what's nearby) and executes the chosen state.
 */
(function (CM) {
  'use strict';
  const S = CM.organism.AI_STATE;

  /* How much a spotted threat scares this organism. Armor and defense make
   * standing ground more viable; a defense-heavy build flees later. */
  function fearMultiplier(org) {
    const stoutness = (org.stats.defense + org.stats.armor) / 120;
    return Math.max(0.35, 1.1 - stoutness);
  }

  function applyDirectiveBias(directive, u) {
    switch (directive) {
      case 'EXPLORE': u.EXPLORE *= 2.2; u.INVESTIGATE *= 1.4; break;
      case 'GATHER': u.SEEK_FOOD *= 2.4; u.RETURN_TO_CORE *= 1.3; break;
      case 'HUNT': u.HUNT *= 2.6; u.ATTACK *= 1.5; break;
      case 'DEFEND': u.FLEE *= 0.15; u.EXPLORE *= 0.3; break; // guard() below drives the actual behaviour
      case 'REPRODUCE': u.REPRODUCE *= 3; break;
      case 'INVESTIGATE': u.INVESTIGATE *= 3; break;
      case 'RETURN': u.RETURN_TO_CORE = 999; break;
      // The underground orders. DIG and EXPAND both mean "work the queue";
      // EXPAND additionally has the colony choose new sites on its own, which
      // happens in the colony tick rather than here.
      case 'DIG': u.EXCAVATE *= 3.2; break;
      case 'EXPAND': u.EXCAVATE *= 3.2; u.EXPLORE *= 1.3; break;
      case 'SHELTER': u.SHELTER *= 3.5; u.EXPLORE *= 0.25; break;
      default: break;
    }
  }

  /* ctx fields (all optional — absence just means "nothing sensed"):
   *   canEatPlants, canHunt: bool
   *   nearestThreat:  {dist, entity}
   *   nearestFood:    {dist, x, y}
   *   nearestWater:   {x, y}
   *   nearestPrey:    {dist, entity}
   *   nearestCuriosity: {dist, x, y, kind, ref}   // unknown species sighting or sample
   *   mateAvailable:  bool
   *   coreDist: number
   *   digSite: structure build site this organism could work on
   *   shelter: finished warren/redoubt in reach
   *   tempStress: current temperature stress (>1 means it is taking damage)
   *   defendRadius: number  (only meaningful with directive DEFEND)
   */
  function decide(org, ctx) {
    if (org.health <= 0) return { state: S.IDLE, target: null };

    const hungerFrac = CM.core.clamp01(org.hunger / 100);
    const thirstFrac = CM.core.clamp01(org.thirst / 100);
    const energyFrac = CM.core.clamp01(org.energy / org.stats.energyMax);
    const healthFrac = CM.core.clamp01(org.health / org.stats.health);
    const critical = hungerFrac > 0.92 || thirstFrac > 0.92 || healthFrac < 0.22;

    const u = { IDLE: 0.05, EXPLORE: 0.22, REST: 0, SEEK_FOOD: 0, SEEK_WATER: 0, HUNT: 0, FLEE: 0, RETURN_TO_CORE: 0, REPRODUCE: 0, INVESTIGATE: 0, ATTACK: 0, EXCAVATE: 0, SHELTER: 0 };

    if (ctx.nearestThreat) {
      const closeness = 1 - CM.core.clamp01(ctx.nearestThreat.dist / Math.max(1, org.stats.sense_radius));
      u.FLEE = closeness * 1.35 * fearMultiplier(org);
    }

    if (ctx.canEatPlants) {
      u.SEEK_FOOD = hungerFrac * hungerFrac * (ctx.nearestFood ? 1 : 0.45);
    }
    /* A gatherer forages for the Core, not only for itself. SEEK_FOOD was
     * driven purely by hunger, so an organism ordered to GATHER did nothing
     * at all until its own stomach was empty — which also meant it never
     * touched a biomass deposit, since deposits are harvested from inside
     * that state. The drive scales with how much room is left in its load,
     * so a full organism heads home instead of over-harvesting. */
    if (org.directive === 'GATHER' && ctx.canEatPlants) {
      const carryRoom = ctx.carryRoom != null ? ctx.carryRoom : 1;
      /* Deliberately tuned to sit *below* a small colony's breeding urge and
       * above a full one's. At 0.6 this drive dominated everything and a
       * GATHER colony filled its Core to the brim while dwindling to
       * extinction — it hauled instead of breeding. A young colony grows
       * first and turns to hauling once it has the numbers to spare. */
      u.SEEK_FOOD = Math.max(u.SEEK_FOOD, 0.28 * carryRoom * (ctx.nearestFood ? 1 : 0.4));
    }
    // Thirst curves the same way hunger does, so an organism engineered with a
    // high water_requirement genuinely spends more of its life walking to water
    // instead of doing what the player asked of it.
    u.SEEK_WATER = thirstFrac * thirstFrac * (ctx.nearestWater ? 1.05 : 0.4);
    if (ctx.canHunt && ctx.nearestPrey) {
      u.HUNT = (0.35 + hungerFrac * 0.75);
    }

    u.REST = Math.max(0, (1 - energyFrac) * 0.75 + (1 - healthFrac) * 0.25 - (ctx.nearestThreat ? 0.6 : 0));
    u.RETURN_TO_CORE = org.carrying > 0 ? 0.85 + Math.min(0.4, org.carrying / 40) : 0;
    /* Reproduction pressure scales with how far below its ceiling the colony
     * is. A colony of three is under real pressure to breed; one at its cap
     * has none. Without this, a standing directive simply outranked breeding
     * forever — an EXPLORE colony never replaced its losses and dwindled to
     * extinction, which is the last thing the *default* directive should do.
     * The simulation still enforces a hard ceiling on top of this; the drive
     * fading out first is what stops the colony from pressing against it. */
    const room = ctx.colonyRoom != null ? ctx.colonyRoom : 0.5;
    const canReproduce = energyFrac > 0.72 && healthFrac > 0.7 && (org.reproCooldown || 0) <= 0;
    u.REPRODUCE = canReproduce ? org.stats.reproduction_rate * 1.8 * (0.35 + room * 2.6) : 0;
    u.INVESTIGATE = ctx.nearestCuriosity ? 0.4 : 0;

    /* Digging. An organism only wants to excavate if there is somewhere to
     * dig and it is physically capable of the work — a creature with no
     * digging stat can be ordered underground but will make almost no
     * headway, which is the point of the trait. */
    if (ctx.digSite) {
      const capable = 0.35 + CM.core.clamp01((org.stats.digging || 0) / 45) * 0.9;
      u.EXCAVATE = capable;
    }
    /* Shelter is worth taking when something is hunting you, when the
     * climate is hurting, or simply to rest somewhere safe. */
    if (ctx.shelter) {
      const threatened = ctx.nearestThreat ? 0.9 : 0;
      const exposed = ctx.tempStress > 1 ? 0.7 * Math.min(2, ctx.tempStress - 1) : 0;
      u.SHELTER = Math.max(threatened, exposed, (1 - healthFrac) * 0.5);
    }

    // A fight in progress is not re-litigated every re-decision — without
    // this an ATTACK organism would be yanked back into HUNT (which
    // immediately re-enters ATTACK, but only *after* skipping this tick's
    // damage) every single time it re-decides, i.e. every tick for anything
    // near the camera.
    if (org.state === S.ATTACK && org.actionTarget && org.actionTarget.ref && org.actionTarget.ref.health > 0) {
      u.ATTACK = 2.2;
    }

    applyDirectiveBias(org.directive, u);

    /* Standing orders yield to physiology, progressively.
     *
     * The directive multipliers above are large by design, and EXPLORE's 2.2x
     * put it above SEEK_FOOD until hunger passed ~70% — so an exploring
     * organism sightsaw its way across the map on an empty stomach, arrived
     * somewhere far from food and water already weak, and died there. Measured
     * over three seeds: EXPLORE went extinct in two of them within ten minutes
     * while GATHER and DEFEND both reached the population cap. Since EXPLORE
     * is also the *default* directive, a player who opened the game and simply
     * watched lost their colony.
     *
     * The critical-needs override further down is a cliff at 92%; this is the
     * ramp that should have been there under it. Discretionary activity —
     * wandering, investigating, breeding — fades as need rises, so an organism
     * drifts back to feeding on its own long before it is desperate. */
    const needPressure = Math.max(hungerFrac, thirstFrac);
    const discretionary = 1 - needPressure * 0.85;
    u.EXPLORE *= discretionary;
    u.INVESTIGATE *= discretionary;
    u.REPRODUCE *= discretionary;

    // A guarding organism holds position near the Core and only leaves the
    // utility loop to fight something that gets close, or to flee if truly
    // overwhelmed (critical health always wins — see below).
    if (org.directive === 'DEFEND') {
      if (ctx.nearestThreat && ctx.defendRadius != null && ctx.nearestThreat.dist <= ctx.defendRadius) {
        u.HUNT = Math.max(u.HUNT, 1.6); // "hunt" the intruder, i.e. engage it
      } else {
        u.EXPLORE = 0.12; // stay close; movement code keeps DEFEND orbiting the Core
      }
    }

    /* Growth is an imperative too, when the conditions for it are plainly
     * met: a colony well below its ceiling, an organism healthy, fed and off
     * cooldown. Reproduction is a brief discrete act rather than a sustained
     * job, so making it out-compete a standing work order on raw utility puts
     * it in a knife-edge contest it loses to hysteresis — measured, a GATHER
     * colony sat at 0.67 (gather) versus 0.66 (breed) with every organism
     * eligible, and the "prefer what you're already doing" bonus locked all
     * fourteen of them into hauling forever while the colony dwindled. This
     * is deliberately narrow: healthy, unpressured, and real room to grow. */
    if (canReproduce && room > 0.25 && needPressure < 0.5 && !ctx.nearestThreat) {
      u.REPRODUCE = Math.max(u.REPRODUCE, 1.7);
    }

    // Critical needs are an imperative, not a suggestion — an organism must
    // never be argued out of eating or fleeing by a stale directive.
    if (critical) {
      if (healthFrac < 0.22 && ctx.nearestThreat) u.FLEE *= 2.2;
      if (hungerFrac > 0.92) u.SEEK_FOOD = Math.max(u.SEEK_FOOD, 1.5);
      if (thirstFrac > 0.92) u.SEEK_WATER = Math.max(u.SEEK_WATER, 1.55);
    }

    // Hysteresis: mildly prefer whatever we're already doing so utilities
    // that are nearly tied don't flap the organism between states every tick.
    if (u[org.state] != null) u[org.state] *= 1.12;

    let bestState = S.IDLE, bestScore = -Infinity;
    for (const st in u) {
      if (u[st] > bestScore) { bestScore = u[st]; bestState = st; }
    }

    return resolveTarget(org, bestState, ctx);
  }

  /* Turn the chosen state into something the simulation can act on. If the
   * ideal target isn't actually available (e.g. HUNT with no prey in range),
   * fall back to a search behaviour instead of an empty action. */
  function resolveTarget(org, state, ctx) {
    switch (state) {
      case S.FLEE:
        if (!ctx.nearestThreat) return { state: S.EXPLORE, target: null };
        return { state: S.FLEE, target: { type: 'flee_from', x: ctx.nearestThreat.entity.x, y: ctx.nearestThreat.entity.y } };
      case S.SEEK_FOOD:
        if (ctx.nearestFood) return { state: S.SEEK_FOOD, target: { type: 'food_cell', x: ctx.nearestFood.x, y: ctx.nearestFood.y } };
        return { state: S.EXPLORE, target: null };
      case S.SEEK_WATER:
        if (ctx.nearestWater) return { state: S.SEEK_WATER, target: { type: 'water_cell', x: ctx.nearestWater.x, y: ctx.nearestWater.y } };
        return { state: S.EXPLORE, target: null };
      case S.HUNT:
        if (org.directive === 'DEFEND' && ctx.nearestThreat) {
          return { state: S.HUNT, target: { type: 'organism', ref: ctx.nearestThreat.entity } };
        }
        if (ctx.nearestPrey) return { state: S.HUNT, target: { type: 'organism', ref: ctx.nearestPrey.entity } };
        return { state: S.EXPLORE, target: null };
      case S.ATTACK:
        // Only ever chosen by the hysteresis guard in decide() when already
        // mid-fight; keep the exact same target rather than re-resolving it.
        if (org.actionTarget && org.actionTarget.ref && org.actionTarget.ref.health > 0) {
          return { state: S.ATTACK, target: org.actionTarget };
        }
        return { state: S.EXPLORE, target: null };
      case S.RETURN_TO_CORE:
        return { state: S.RETURN_TO_CORE, target: { type: 'core' } };
      case S.REPRODUCE:
        return { state: S.REPRODUCE, target: null };
      case S.INVESTIGATE:
        if (org.directive === 'INVESTIGATE' && org.directiveTarget) {
          return { state: S.INVESTIGATE, target: { type: 'point', x: org.directiveTarget.x, y: org.directiveTarget.y, ref: org.directiveTarget.ref || null } };
        }
        if (ctx.nearestCuriosity) return { state: S.INVESTIGATE, target: { type: 'point', x: ctx.nearestCuriosity.x, y: ctx.nearestCuriosity.y, ref: ctx.nearestCuriosity.ref || null } };
        return { state: S.EXPLORE, target: null };
      case S.EXCAVATE:
        if (ctx.digSite) return { state: S.EXCAVATE, target: { type: 'dig_site', x: ctx.digSite.x, y: ctx.digSite.y, ref: ctx.digSite } };
        return { state: S.EXPLORE, target: null };
      case S.SHELTER:
        if (ctx.shelter) return { state: S.SHELTER, target: { type: 'shelter', x: ctx.shelter.x, y: ctx.shelter.y, ref: ctx.shelter } };
        return { state: S.REST, target: null };
      case S.REST:
        return { state: S.REST, target: null };
      default:
        return { state: S.EXPLORE, target: null };
    }
  }

  CM.ai = { decide, fearMultiplier };
})(window.CM = window.CM || {});
