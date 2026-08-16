/* Coremind — bootstrap. Wires world/sim/render/input/ui/save together and
 * runs the game loop: a fixed-step simulation accumulator decoupled from
 * rendering, so physics stays stable regardless of frame rate or the
 * player's chosen simulation speed.
 */
(function (CM) {
  'use strict';
  const SIM_DT = 0.1;
  const MAX_STEPS_PER_FRAME = 8;

  let game = null, canvas = null, ctx = null, acc = 0, lastT = 0, rafId = null, periodicAcc = 0;

  function wireInput() {
    CM.input.attach(canvas, game, {
      onSelectOrganism(org) {
        CM.coremind.selectOrganism(game, org.id);
        CM.ui.renderSelection(game);
        CM.render.focusOn(game, org.x, org.y);
      },
      onTapSample(sample) { CM.ui.showInspect(game, 'sample', { sample }); },
      onTapCore() { CM.ui.showInspect(game, 'core', {}); },
      onTapStructure(site) { CM.ui.showInspect(game, 'structure', { site }); },
      onTapEmpty(world) {
        /* Placing a chamber takes priority over clearing the selection: while
         * build mode is armed a tap on the ground is a construction order. */
        if (game.buildMode) {
          const res = CM.structures.queue(game, game.__bus, game.core, game.buildMode, world.x, world.y);
          if (res.ok) {
            CM.ui.toast({ kind: 'system', icon: CM.structures.TYPES[game.buildMode].icon,
              message: `${CM.structures.TYPES[game.buildMode].name} sited. Order your colony to Dig.` });
            game.buildMode = null;
            CM.ui.renderBuildBanner(game);
          } else {
            CM.ui.toast({ kind: 'warn', icon: '\u{26A0}', message: res.reason });
          }
          return;
        }
        CM.coremind.selectOrganism(game, null);
        CM.ui.renderSelection(game);
      }
    });
  }

  function startCommon() {
    canvas = document.getElementById('world-canvas');
    ctx = canvas.getContext('2d');
    window.__CM_GAME__ = game; // debug/inspection hook only — never read by game logic
    CM.save.init(game, game.__bus);
    CM.ui.init(game, game.__bus);
    CM.ui.renderFeed(game);
    CM.ui.updateBadges(game);
    wireInput();
    window.addEventListener('resize', () => CM.render.resizeCanvas(canvas));
    document.addEventListener('visibilitychange', () => { if (document.hidden) CM.save.writeNow(game); });
    window.addEventListener('pagehide', () => CM.save.writeNow(game));
    acc = 0; periodicAcc = 0; lastT = 0;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
  }

  function newWorld() {
    const seed = (Math.random() * 0xffffffff) >>> 0;
    game = CM.coremind.newGame(seed);
    game.__bus = CM.core.makeBus();
    CM.simulation.spawnStarterColony(game, game.__bus);
    CM.simulation.spawnStarterWildlife(game);
    startCommon();
    CM.save.writeNow(game);
  }

  function continueGame() {
    const data = CM.save.readRaw();
    if (!data) { newWorld(); return; }
    game = CM.save.hydrate(data);
    game.__bus = CM.core.makeBus();
    startCommon();
  }

  function loop(tMs) {
    rafId = requestAnimationFrame(loop);
    if (!lastT) lastT = tMs;
    let frameDt = (tMs - lastT) / 1000;
    lastT = tMs;
    frameDt = Math.min(frameDt, 0.25); // guard against tab-backgrounding spikes

    acc += frameDt * game.speed;
    let steps = 0;
    while (acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      CM.simulation.tick(game, game.__bus, SIM_DT);
      acc -= SIM_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) acc = 0; // device can't keep up — drop the backlog rather than spiral

    CM.render.updateCamera(game, frameDt);
    CM.render.draw(game, canvas, ctx);
    CM.ui.render(game);
    CM.ui.renderSelection(game);

    periodicAcc += frameDt;
    if (periodicAcc * 1000 >= CM.save.PERIODIC_MS) { periodicAcc = 0; CM.save.writeNow(game); }
  }

  function boot() {
    const bootOverlay = document.getElementById('boot-overlay');
    const continueBtn = document.getElementById('btn-continue');
    if (CM.save.hasSave()) continueBtn.classList.remove('hidden');
    continueBtn.addEventListener('click', () => { bootOverlay.classList.add('hidden'); continueGame(); });
    document.getElementById('btn-new-world').addEventListener('click', () => { bootOverlay.classList.add('hidden'); newWorld(); });
  }

  CM.main = { newWorld, continueGame, boot };
  document.addEventListener('DOMContentLoaded', CM.main.boot);
})(window.CM = window.CM || {});
