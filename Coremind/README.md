# Coremind

A mobile-first, single-player biological evolution sandbox. You are
**Coremind**, a distributed biological intelligence: you don't control
individual creatures directly, you **discover → analyze → extract → design →
deploy → adapt**, engineering organisms to survive an ecosystem that reacts
on its own.

**Stack:** vanilla JS + Canvas2D, no build step, no dependencies, no backend.
Runs offline from `index.html`.

---

## Why not Godot

The brief's default is Godot 4.x. This container has no Godot binary and no
network path to install one (the outbound proxy blocks
`godotengine.org`/GitHub release downloads), so a Godot project here could be
written but never *run* — and this project's own build order explicitly
requires running and testing after every phase, not assuming the code works.

This repo already has a working precedent for exactly this constraint:
`PrimalIsle` and `SkyWorld` are mobile-first Canvas2D games with zero build
dependencies, developed and tested the same way this one was — loaded in the
sandbox's pre-installed Chromium via Playwright, driven with real touch
gestures, screenshotted, and iterated on. Coremind follows the same pattern
so every system in the build order below was actually exercised end-to-end,
not just written and hoped for. `index.html` is also a legitimate mobile
target on its own (installable as a PWA / wrapped in a WebView via
Capacitor/Cordova for a real Android package) — `tools/build.mjs` produces
the single self-contained HTML file that kind of wrapping needs.

## Running it

```
python3 -m http.server 8000    # from this directory
# open http://localhost:8000/index.html on a phone or in a browser
```

Or open `index.html` directly — it has no external dependencies.

```
node tools/simtest.js          # headless test of world/AI/sim/discovery, no DOM
node tools/build.mjs           # -> dist/coremind.html, one self-contained file
```

## What's implemented

The full core loop from the brief, playable end to end:

- **World**: a seeded, deterministic 256×256 cell ecosystem generated as a
  named pipeline of stages, each drawing from its own seed offset so changing
  one cannot silently shift the others — `js/world.js`.
  - **14 biomes** classified jointly from elevation, temperature and
    moisture: deep water, shallows, marsh, sands, desert, savanna, grassland,
    forest, jungle, taiga, tundra, ice sheet, rocky waste, mountains. Each
    carries its own food ceiling, movement cost, and shelter from temperature
    extremes.
  - **Rivers** traced from high ground to the sea by steepest descent, adding
    moisture along their length. They are what makes the interior habitable —
    without them every inland region is a death sentence for anything that
    needs to drink.
  - **Named regions** (~40–55 per map) flood-filled from contiguous biome
    areas, so the map has places worth talking about rather than coordinates.
  - **Hazards** (thermal vents, toxic bogs, frost hollows) that shift local
    temperature and injure whatever stands in them, and **biomass deposits**
    placed only on productive ground so contested land is also land worth
    holding.
- **Flora**: nine plant species distributed by biome and low-frequency noise,
  differing in nutrition, regrowth rate, and how hard they fight back —
  `js/flora.js`. Bitterleaf and bloodcap are toxic; thornscrub and succulents
  are physically defended. Venom-producing organisms resist ingested toxins
  and armor blunts thorns, so a defended meadow is a design problem rather
  than a wall. Organisms avoid defended forage unless genuinely hungry.
- **Climate**: a four-season cycle plus weather events (drought, rains, cold
  snap, heatwave) that shift the whole map's temperature and plant growth —
  `js/climate.js`. This is the main engine of "a new ecological problem
  emerges": a colony bred entirely for heat is in real trouble when Deep Cold
  arrives.
- **Organisms**: one reusable data-driven system for every creature, player-
  designed or wild — every stat the brief lists (health, energy, hunger,
  speed, size, vision, sense_radius, attack, defense, temperature_tolerance,
  water_requirement, reproduction_rate, metabolism, camouflage, venom,
  armor, digging) is base stats + summed trait deltas, nothing hard-coded
  per species — `js/organism.js`, `js/traits.js`. **Every one of those stats
  drives something**: `water_requirement` sets how fast thirst climbs (and
  thirst kills), `digging` sets how long a burrowing organism can stay
  underground.
- **17 traits** across the 6 designer categories (Body/Sense/Metabolism/
  Defense/Offense/Reproduction), each with real stat tradeoffs, an energy/
  biomass cost, and a visual modifier the procedural renderer actually
  draws (shell, venom glands, streamlined body, digging limbs, eyes,
  antennae, camouflage mottling, brood sac, …).
- **Traits interact**, which is where the design game lives:
  - **Declared incompatibilities are enforced.** Armor and Fast Movement
    can't coexist; the designer disables the option, marks it `⊘`, and says
    what it conflicts with.
  - **Declared compatibilities pay off.** A satisfied pairing (Armor +
    Claws, Burrowing + Camouflage, Chemical Sensing + Venom, …) boosts both
    traits' *benefits* by 15% and never deepens their costs. The designer
    names the pairing when it goes live. Wild species get this too — that's
    why Shellfang (armor + claws) is genuinely tough rather than just the
    sum of two parts.
  - **Counters exist.** Camouflage hides an organism probabilistically, and
    Chemical Sensing defeats it outright — so camouflage is a choice rather
    than a strictly-correct default. Vibration Sensing extends threat
    detection 50% further than ordinary senses. Acid halves the target's
    effective armor.
  - **Burrowing is an escape, not a stat line.** A cornered digger drops
    underground: untargetable, immobile, recovering, and drawn as the mound
    it left behind. That's what makes its speed penalty affordable.
  - **Digging also builds.** The `digging` stat sets how fast an organism
    excavates, so the trait is what makes the underground reachable at all —
    a colony with no burrowers can site chambers but will crawl through them,
    and the deeper chamber types refuse to be cut without it.
- **The underground** — a colony's second body, `js/structures.js`. Twelve
  modular chamber types across **three strata**, each answering a pressure the
  surface game already applies rather than being a generic upgrade.

  A chamber may only link to one within a *single depth level* of itself.
  That one rule is what makes depth a campaign instead of a menu: you cannot
  reach the abyssal reach without holding deep galleries, and you cannot hold
  those without shallow works above them.

  - **Shallow Works (level 1)** — **Access Shaft** (the only chamber that can
    be sunk on open ground; everything else must connect to a *finished*
    chamber within reach, which is what makes the network a shape the player
    designs rather than a list of purchases), **Warren** (organisms inside
    cannot be sensed by predators and the chamber holds a workable temperature
    whatever the surface is doing), **Cistern** (taps groundwater, so dry
    inland ground becomes survivable), **Granary** (raises the Core's biomass
    ceiling past its own limit).
  - **Deep Galleries (level 2)** — **Descent** (cuts down; everything at this
    depth hangs off one), **Nursery** (organisms nearby come off reproduction
    cooldown far faster), **Analysis Vault** (speeds observations into
    discoveries), **Redoubt** (fortified ground — its defenders count for more
    in a siege *and* the chambers around it resist being chewed open),
    **Fungarium** (feeds whoever stands in it, which is what severs a colony
    from the surface: below this depth there is no forage).
  - **Abyssal Reach (level 3)** — **Geothermal Tap** (a large permanent energy
    income), **Veinworks** (mines a buried biomass seam; must be cut directly
    onto one, and the seam is finite), **Deep Sanctum** (a second seat for the
    Coremind — losing the surface Core no longer ends the colony, it falls
    back and rebuilds from below).
  - **Prospecting.** Abyssal seams are placed at world generation and are
    invisible until a colony finishes a level-2-or-deeper chamber near one.
    Finding them is a consequence of digging rather than a separate action,
    and because they are fixed points on the map the deep tier is contested
    ground rather than a shop.
  - **The deep is inhabited.** Three subterranean species — Rock Gnawer,
    Shalefang, Hollow Serpent — one per stratum, drawn to excavation and
    rallied to the chamber that woke them. Unguarded chambers are chewed open
    and collapse; the pressure scales with how deep the colony has cut, so the
    abyssal tier is the most dangerous ground on the map.
  - Three orders drive it: **DIG** (work the sites you placed), **EXPAND**
    (the Coremind chooses its own sites from what the colony is short of), and
    **SHELTER** (retreat underground). Rivals dig too, using the same
    shortfall reasoning and walking the same depth ladder — an inland rival
    ends up with cisterns, a besieged one with redoubts — and a collapsed
    colony's network dies with it.
- **The underground view** — `SURF / I / II / III` down the left of the stage
  switches between the surface map and each stratum, rendered as an actual
  excavated space rather than markers on a map: banded rock baked once per
  depth (one blit per frame, same as the terrain), chambers as irregular lit
  caverns cut out of it, corridors between them, and shafts marked where the
  network changes level. Only ground the colony has opened is lit — the rest
  of the stratum is dark, because an underground map that showed the whole
  world would make prospecting pointless. Chambers one level away are ghosted
  so the strata read as stacked rather than as unrelated maps, and tapping a
  room opens its details. A stratum you have not reached yet is visible but
  disabled, so the deep tier is something the player can see waiting.
- **Utility AI**: all 10 states from the brief (IDLE, EXPLORE, SEEK_FOOD,
  FLEE, HUNT, ATTACK, REST, RETURN_TO_CORE, REPRODUCE, INVESTIGATE) plus
  SEEK_WATER, scored from needs + senses + the player's directive, with a
  hard floor so critical hunger/thirst/health can't be argued away by a
  stale directive — `js/ai.js`. Thirsty organisms with no water in range
  walk up the terrain's humidity gradient, so a drought produces migration
  rather than a silent die-off.
- **Food web**: plants → herbivores → predators, all through the same
  organism/AI system. Overhunting measurably drops herbivore population,
  which drops predator food, which drops predator population — watch it
  happen in `js/simulation.js`, narrated by `narrateEcosystem()`.
- **Discover → Analyze → Extract**: every encounter between your organisms
  and a wild one is partial evidence toward that wild organism's traits;
  killing one leaves a biological sample you walk up to (or tap) and
  extract for a much bigger dose of evidence. Traits become available in
  the designer only once you've actually earned them — `js/discovery.js`.
  Two things make this read as investigation rather than a hidden counter:
  - **Observation reports.** A death produces the brief's report verbatim —
    species (or "Unidentified"), damage type, observed defense — derived
    from the *individual* that did the killing, so a mutated wild organism
    is described as what it actually is, not as its species archetype.
  - **A visible research backlog.** The ANALYZE tab lists every partially
    observed trait with its progress (`Basic Legs ▓▓▓░ 3/4`), so watching a
    predator fight is visibly *doing* something long before the discovery
    lands.
- **Genome designer**: 6 trait slots, live procedural preview, a stat panel
  with explicit +/- deltas against the baseline (coloured by whether the
  change is *good*, so a metabolism increase reads as the cost it is), a
  conflict/synergy readout, cost gating, and one button — CREATE ORGANISM —
  `js/ui.js` (designer section) + `js/coremind.js`.
- **Saved strains**: a proven genome can be saved and reloaded with one tap,
  so iterating is "deploy that one again, with one change" rather than
  rebuilding it slot by slot from memory.
- **Event feed**: clickable, focuses the camera on the relevant location
  and opens the relevant detail (organism / species / trait).
- **Touch controls**: one-finger drag pan, two-finger pinch zoom, tap to
  select/inspect, mouse wheel for desktop dev — `js/input.js`. In build mode
  a tap is a construction order and short-circuits selection, so aiming at
  crowded ground still places the chamber.
- **Transient sheets, not full-screen menus.** The designer, inspector and
  excavation palette are bottom sheets: the world stays visible and running
  above them, and any of tap-outside, swipe-the-grip-down, or the close
  button dismisses them. Choosing a chamber closes the palette and leaves a
  slim banner, so the player is picking a spot while watching real ground
  rather than a menu.
- **Performance**: object pooling for organisms, a uniform spatial grid for
  neighbor queries, simulation LOD (near organisms re-decide every tick,
  mid every 4th, far every 12th — spatial queries only happen at decision
  time, not every frame), the whole 256×256 terrain baked into one offscreen
  canvas and blitted with a single `drawImage` regardless of zoom, and a
  soft population ceiling per ecosystem tier so the world plateaus instead
  of one species filling the entire active-organism cap.
- **Rival Coreminds**: three other colonies run the same loop the player
  does — `js/colony.js`. Each gathers biomass into its own Core, keeps its
  own ledger of what it has fought, unlocks traits from those observations,
  and designs an organism by scoring its known traits against its doctrine
  *and* the conditions it can actually perceive around its own Core. A rival
  on cold ground reaches for cold resistance; one that keeps losing organisms
  to combat reaches for armor. They redesign when their losses tell them to,
  and the feed reports it.
  - Four doctrines — Expansionist, Entrenched, Predatory, Adaptive — which are
    weights rather than scripts, so two colonies sharing a doctrine on
    different ground still diverge.
  - Rivals **wake on a stagger** (~4/5.5/7 minutes) and grow into their
    ceiling, so the brief's quiet opening survives and rivals are the
    escalation that follows it.
  - **Territory** is a coarse influence field fed by Cores and living
    organisms; where two colonies overlap comparably the cell is *contested*,
    which is the border friction that produces raids without a scripted war.
  - **Hostility is earned, not assigned.** Every colony starts wary; kills
    drive standing down and quiet years let it drift back up. Past a
    threshold two colonies treat each other as targets on sight, which turns
    a border incident into a running feud with no scripted war declaration.
  - **Biomass deposits** are finite, slow to recover, and claimed by whoever
    works them — the concrete thing colonies fight over.
  - **Cores can fall.** Hostile organisms standing on a Core with no
    defenders grind its integrity down; at zero the colony collapses and its
    organisms go feral rather than vanishing. This applies to the player's
    Core on exactly the same terms. A Core with biomass left can always
    regrow one organism, so losing your last body is never a dead end.
- **Save/load**: autosaves on discoveries/deaths/creation (throttled) plus
  every 20s and on tab-hide/page-hide; `Continue` on the boot screen
  restores seed, discovered species/traits (with partial observation
  progress), samples, designs, every living organism, Core resources, every
  colony's identity/knowledge/genome, the climate state, the whole underground
  network with its depths and integrity, and what play changed about the world
  itself — how far each biomass deposit has been stripped, who claimed it, and
  which abyssal seams have been prospected and how much is left in them. The
  terrain is never saved because it regenerates exactly from the seed; that
  used to mean the *mutable* parts of it regenerated too, so a stripped
  deposit came back full and an hour of prospecting came back unknown. The
  format is versioned and loads v1 and v2 saves forward rather than discarding
  a campaign.

### What's deliberately out of scope for this pass

- **Android packaging** (APK/AAB via Gradle): no Android SDK in this
  container to build or verify one. `tools/build.mjs` produces the single
  bundled HTML file a Capacitor/Cordova/TWA wrapper would need next.
- **Render-tick interpolation**: the simulation runs a fixed 10 Hz tick
  decoupled from the render loop (which runs every frame); organism motion
  is not interpolated between ticks, so it reads as slightly stepped rather
  than perfectly smooth at high zoom. Rendering itself runs every
  `requestAnimationFrame`.
- Sound/particle effects (brief's Phase 7 polish) — not started.

## Debugging

`window.__CM_GAME__` is the live game state object once a world is running
— never read by game logic itself, it's there so you (or a test script) can
inspect `.organisms`, `.discovery`, `.core`, etc. from the console.

## Testing notes

Every system above was driven through actual gameplay during development,
not just unit-tested in isolation:

- `tools/simtest.js` boots a real game, runs 4000 fixed-step ticks (400
  sim-seconds) with a full starter colony + wildlife, and asserts no NaNs,
  a bounded population, real resource/event/discovery activity, and that
  combat (`ATTACK` state) actually occurs.
- The full boot → new world → pan/zoom → issue directive → fast-forward →
  discover → open designer → pick a real discovered trait through the
  actual `<select>` → CREATE ORGANISM → save → reload → continue path was
  driven in the sandbox's Chromium via Playwright, screenshotted at each
  step, with zero uncaught page errors.

That process caught several bugs that a design read-through wouldn't have:
organisms stuck flapping between HUNT and ATTACK and never actually landing
a hit; a stale action-target shape producing NaN positions on a state
transition; mutating the organism array while iterating it, silently
skipping whoever shifted into the current slot; every organism starting at
zero reproduction cooldown, so almost the entire starting population gave
birth in near-perfect sync a few seconds in; and — the sharpest one — a
death check that used "alive AND health > 0" to mean "already handled",
which also matched "just died of starvation and hasn't been handled yet",
producing organisms that were dead in every practical sense but never
removed, silently corrupting the population counts.

The second pass (traits interacting, thirst, burrowing) caught three more:

- **Armor was −13 speed against a base of 13**, so every armored build hit
  the speed floor. Shellfang, an armored predator, could not chase anything
  — the ecosystem looked balanced only because one of its predators was
  effectively furniture.
- **Kills were misattributed.** An organism that starved mid-swing was
  recorded as killed by whatever it was biting, producing reports like
  "Grazer killed Scout" — a herbivore that deals no damage. Those reports
  are the evidence the player designs from, so a false one is worse than
  none. Now a death is credited to the target only if the target actually
  fought back, and a needs death resolves before the organism can act at
  all. Verified across 5 seeds: 107 death events, 0 misattributed.
- **Thirst had no strategy behind it.** Large inland regions of these maps
  hold no open water, so thirsty organisms there simply died. They now
  follow the humidity gradient and range further as they get more desperate.

Two of those were found only because a test asserted the *causal* claim
rather than the symptom — the burrow test checks that the same organism is
detected when exposed and not when burrowed, which is what caught that an
earlier version of the check was passing for the wrong reason (the two test
organisms were simply out of each other's range).
