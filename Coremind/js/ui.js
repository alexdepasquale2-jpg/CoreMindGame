/* Coremind — DOM UI: HUD, tabs, directive bar, event feed, genome designer,
 * inspect overlay. Rendering (canvas) stays in render.js; this file only
 * touches the DOM layer on top of it.
 */
(function (CM) {
  'use strict';
  const K = CM.core;
  const T = CM.traits;
  const D = CM.discovery;
  const CORE = CM.coremind;

  const DIRECTIVE_META = {
    EXPLORE: { icon: '\u{1F9ED}', label: 'Explore' },
    GATHER: { icon: '\u{1F33F}', label: 'Gather' },
    HUNT: { icon: '\u{1F3F9}', label: 'Hunt' },
    DEFEND: { icon: '\u{1F6E1}', label: 'Defend' },
    REPRODUCE: { icon: '\u{1F95A}', label: 'Reproduce' },
    INVESTIGATE: { icon: '\u{1F50D}', label: 'Investigate' },
    RETURN: { icon: '\u{1F3E0}', label: 'Return' },
    DIG: { icon: '\u{26CF}', label: 'Dig' },
    SHELTER: { icon: '\u{1F573}', label: 'Shelter' },
    EXPAND: { icon: '\u{1F578}', label: 'Expand' }
  };

  const STAT_ROWS = [
    ['health', 'Health'], ['energyMax', 'Energy'], ['speed', 'Speed'], ['size', 'Size'],
    ['vision', 'Vision'], ['sense_radius', 'Sense'], ['attack', 'Attack'], ['defense', 'Defense'],
    ['armor', 'Armor'], ['venom', 'Venom'], ['camouflage', 'Camo'], ['digging', 'Dig'],
    ['temperature_tolerance', 'Temp.Tol'], ['water_requirement', 'Water'],
    ['reproduction_rate', 'Repro'], ['metabolism', 'Metab.']
  ];
  const STAT_MAXES = { health: 140, energyMax: 100, speed: 60, size: 40, vision: 70, sense_radius: 45, attack: 70, defense: 70, armor: 45, venom: 45, camouflage: 45, digging: 55, temperature_tolerance: 55, water_requirement: 1.2, reproduction_rate: 1.2, metabolism: 40 };

  function el(id) { return document.getElementById(id); }

  /* --- sheets ---------------------------------------------------------------
   * One controller for every transient panel. Only one sheet is open at a
   * time, and opening any of them arms the catcher so a tap anywhere on the
   * world dismisses it. Sheets are deliberately not modal: the simulation
   * keeps running and stays visible above them, which is the point — the
   * previous full-screen overlays meant opening the designer blinded you to
   * whatever was happening to your colony. */
  const SHEETS = ['designer-overlay', 'inspect-overlay', 'build-overlay'];
  let openSheetId = null;

  function openSheet(game, id) {
    if (openSheetId && openSheetId !== id) closeSheet(game, openSheetId, true);
    const node = el(id);
    node.classList.remove('hidden', 'closing');
    node.style.transform = '';
    el('sheet-catcher').classList.remove('hidden');
    openSheetId = id;
  }

  function closeSheet(game, id, immediate) {
    id = id || openSheetId;
    if (!id) return;
    const node = el(id);
    if (openSheetId === id) {
      openSheetId = null;
      el('sheet-catcher').classList.add('hidden');
    }
    if (immediate) { node.classList.add('hidden'); node.classList.remove('closing'); }
    else {
      node.classList.add('closing');
      setTimeout(() => { node.classList.add('hidden'); node.classList.remove('closing'); node.style.transform = ''; }, 190);
    }
    if (id === 'designer-overlay') stopPreviewLoop(game);
  }

  function anySheetOpen() { return !!openSheetId; }

  /* Swipe the grip (or the sheet head) downward to dismiss — the gesture a
   * bottom sheet is expected to answer to on a phone. */
  function initSheetGestures(game) {
    el('sheet-catcher').addEventListener('pointerdown', () => closeSheet(game));
    for (const id of SHEETS) {
      const node = el(id);
      const grip = node.querySelector('.sheet-grip');
      const head = node.querySelector('.sheet-head');
      let startY = null, dy = 0;
      const onDown = evt => { startY = evt.clientY; dy = 0; node.style.transition = 'none'; };
      const onMove = evt => {
        if (startY == null) return;
        dy = Math.max(0, evt.clientY - startY);
        node.style.transform = `translateY(${dy}px)`;
      };
      const onUp = () => {
        if (startY == null) return;
        node.style.transition = '';
        node.style.transform = '';
        if (dy > 60) closeSheet(game, id);
        startY = null;
      };
      for (const handle of [grip, head]) {
        if (!handle) continue;
        handle.addEventListener('pointerdown', onDown);
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
      }
    }
  }
  function fmt1(n) { return (Math.round(n * 10) / 10).toString(); }

  function init(game, bus) {
    const ui = {
      dnaBadgeSeen: 0, unreadAnalyze: 0, previewRaf: null, previewAngle: 0,
      inspectTarget: null, canvas: el('world-canvas')
    };
    game.ui = ui;

    initTabs(game);
    initDirectiveBar(game, bus);
    initCamControls(game);
    initDesigner(game, bus);
    initInspect(game);
    initBuild(game, bus);
    initDepthControls(game);
    initSheetGestures(game);

    el('btn-open-build').addEventListener('click', () => openBuild(game));

    el('btn-speed').addEventListener('click', () => {
      game.speed = game.speed >= 3 ? 1 : (game.speed === 1 ? 2 : 3);
      el('btn-speed').textContent = game.speed + 'x';
    });

    bus.on('event', evt => onEvent(game, evt));

    render(game);
    return ui;
  }

  // -- tabs -----------------------------------------------------------------
  function initTabs(game) {
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (tab === 'dna') { openDesigner(game); return; }
        document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
        if (tab === 'analyze') { game.ui.unreadAnalyze = 0; renderFeed(game); updateBadges(game); }
        if (tab === 'world') renderWorldPanel(game);
      });
    });
  }

  // -- directive bar ----------------------------------------------------------
  function initDirectiveBar(game, bus) {
    const bar = el('directive-bar');
    bar.innerHTML = '';
    for (const d of CM.organism.DIRECTIVES) {
      const meta = DIRECTIVE_META[d];
      const btn = document.createElement('button');
      btn.className = 'dirbtn'; btn.dataset.directive = d;
      btn.innerHTML = `<i>${meta.icon}</i>${meta.label}`;
      btn.addEventListener('click', () => {
        const scope = CORE.issueDirective(game, d);
        const who = scope === 'selected' ? (game.byId[game.selection] || {}).name : 'Your colony';
        toast({ kind: 'system', icon: meta.icon, message: `${who} directed to ${meta.label}.` });
        renderDirectiveBar(game);
        renderSelection(game);
      });
      bar.appendChild(btn);
    }
    renderDirectiveBar(game);
  }
  function renderDirectiveBar(game) {
    const active = game.selection && game.byId[game.selection] ? game.byId[game.selection].directive : game.globalDirective;
    document.querySelectorAll('#directive-bar .dirbtn').forEach(b => b.classList.toggle('active', b.dataset.directive === active));
  }

  // -- camera controls ---------------------------------------------------
  function initCamControls(game) {
    el('btn-focus-core').addEventListener('click', () => CM.input.focusCore(game));
    el('btn-zoom-in').addEventListener('click', () => CM.input.zoomBy(game, 1.35));
    el('btn-zoom-out').addEventListener('click', () => CM.input.zoomBy(game, 1 / 1.35));
  }

  /* --- depth switching -----------------------------------------------------
   * Surface plus one button per stratum. Levels below what the colony has cut
   * stay disabled rather than hidden, because the whole point of the deep tier
   * is that the player can see it waiting. */
  function initDepthControls(game) {
    const box = el('depth-controls');
    box.addEventListener('click', evt => {
      const btn = evt.target.closest('.depthbtn');
      if (!btn || btn.disabled) return;
      setViewDepth(game, parseInt(btn.dataset.depth, 10));
    });
    renderDepthControls(game);
  }

  function setViewDepth(game, depth) {
    if (game.viewDepth === depth) return;
    game.viewDepth = depth;
    // Placing a chamber is a surface action — the build banner would otherwise
    // sit over a view the tap does not apply to.
    if (depth && game.buildMode) setBuildMode(game, null);
    // No toast: the view itself changes completely and carries its own banner.
    // Announcing it as well just buried the map under notifications every time
    // the player flicked between levels.
    renderDepthControls(game);
  }

  const DEPTH_LABEL = ['SURF', 'I', 'II', 'III'];
  function renderDepthControls(game) {
    const box = el('depth-controls');
    const deepest = game.core ? CM.structures.deepestOf(game, game.core.id) : 0;
    const view = game.viewDepth || 0;
    let html = '';
    for (let d = 0; d <= CM.structures.MAX_DEPTH; d++) {
      // A level is viewable once the colony holds the level above it: you can
      // look into the rock you are about to cut, but not three strata down.
      const open = d === 0 || d <= deepest + 1;
      const info = d ? CM.structures.DEPTHS[d] : null;
      const title = d === 0 ? 'Surface' : (open ? info.name : `${info.name} — dig deeper to see it`);
      html += `<button class="depthbtn${view === d ? ' active' : ''}" data-depth="${d}"
        ${open ? '' : 'disabled'} title="${title}">${DEPTH_LABEL[d]}</button>`;
    }
    box.innerHTML = html;
  }

  /* The Sanctum readout. Only appears once the colony is actually cutting one
   * — before that it would be a promise the game has not made yet. */
  function renderSanctumMeter(game) {
    const box = el('sanctum-meter');
    if (!game.core) return;
    const done = CM.structures.hasSanctum(game, game.core.id);
    const prog = CM.structures.sanctumProgress(game, game.core.id);
    if (prog <= 0) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.classList.toggle('secured', done);
    box.innerHTML = done
      ? '\u{1F52E} <b>Sanctum secured.</b><br>The Coremind cannot be killed from the surface.'
      : `\u{1F52E} Deep Sanctum ${Math.round(prog * 100)}%<div class="bar"><i style="width:${Math.round(prog * 100)}%"></i></div>`;
  }

  // -- selection panel ------------------------------------------------------
  function renderSelection(game) {
    const panel = el('selection-panel');
    const summary = el('selection-summary');
    const org = game.selection && game.byId[game.selection];
    if (!org) {
      panel.classList.add('hidden');
      summary.textContent = 'Tap an organism to select it, or issue a directive to your whole colony.';
      renderDirectiveBar(game);
      return;
    }
    panel.classList.remove('hidden');
    const hf = Math.round(100 * org.health / org.stats.health);
    const ef = Math.round(100 * org.energy / org.stats.energyMax);
    // Distress flags name the thing that is actually killing this organism,
    // so a failed design reads as a diagnosis instead of a mystery.
    const flags = [];
    if (org.burrowed) flags.push('<span style="color:var(--warn)">BURROWED</span>');
    if (org.hunger > 80) flags.push('<span style="color:var(--danger)">STARVING</span>');
    if (org.thirst > 80) flags.push('<span style="color:var(--danger)">DEHYDRATED</span>');
    const stress = CM.organism.tempStress(org, CM.world.tempAt(game.world, org.x, org.y));
    if (stress > 1) flags.push('<span style="color:var(--danger)">TEMP STRESS</span>');
    panel.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
      <b>${org.name}</b><span style="color:var(--fg-dim);font-size:11px">${org.ownerId === 'player' ? 'Gen ' + org.generation : org.name}</span></div>
      <div style="font-size:11.5px;color:var(--fg-dim);margin-top:2px">${org.state} &middot; HP ${hf}% &middot; Energy ${ef}% &middot; Thirst ${Math.round(org.thirst)}%</div>
      ${flags.length ? `<div style="font-size:10.5px;margin-top:3px;letter-spacing:.05em">${flags.join(' ')}</div>` : ''}`;
    summary.textContent = `${org.name} selected — directives below apply to it only.`;
    renderDirectiveBar(game);
  }

  // -- events / feed / toasts ---------------------------------------------
  function onEvent(game, evt) {
    game.ui.unreadAnalyze++;
    updateBadges(game);
    if (evt.kind === 'discovery' || evt.kind === 'death' || evt.kind === 'warn' || evt.kind === 'rival') toast(evt);
    if (el('panel-analyze').classList.contains('active')) renderFeed(game);
  }

  function toast(evt) {
    const layer = el('toast-layer');
    const div = document.createElement('div');
    div.className = 'toast' + (evt.kind === 'death' ? ' danger' : evt.kind === 'warn' ? ' warn' : '');
    div.textContent = (evt.icon ? evt.icon + ' ' : '') + evt.message;
    layer.appendChild(div);
    setTimeout(() => { div.style.transition = 'opacity .4s'; div.style.opacity = '0'; setTimeout(() => div.remove(), 400); }, 3600);
    while (layer.children.length > 3) layer.removeChild(layer.firstChild);
  }

  /* The research backlog: traits the Coremind has partial evidence for.
   * Without this the player only ever sees the moment a discovery lands and
   * has no idea that watching a predator fight is *doing* anything. */
  function renderResearch(game) {
    const wrap = el('research-list');
    const rows = D.researchInProgress(game);
    if (!rows.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = '<div class="research-head">ANALYSIS IN PROGRESS</div>';
    for (const r of rows.slice(0, 6)) {
      const row = document.createElement('div');
      row.className = 'research-row';
      row.innerHTML = `<div class="rname">${r.trait.name}</div>
        <div class="rbar"><i style="width:${Math.round(r.progress * 100)}%"></i></div>
        <div class="rcount">${r.observations}/${r.needed}</div>`;
      wrap.appendChild(row);
    }
  }

  function renderFeed(game) {
    renderResearch(game);
    const feed = el('event-feed');
    const events = game.discovery.events;
    if (!events.length) { feed.innerHTML = '<div class="event-empty">Nothing observed yet. Send an organism to EXPLORE.</div>'; return; }
    feed.innerHTML = '';
    for (const evt of events.slice(0, 80)) {
      const row = document.createElement('button');
      row.className = 'event-row' + (evt.kind === 'discovery' ? ' discovery' : evt.kind === 'death' ? ' death'
        : evt.kind === 'warn' ? ' warn' : evt.kind === 'rival' ? ' rival' : evt.kind === 'climate' ? ' climate' : '');
      const mins = Math.floor(evt.time / 60), secs = Math.floor(evt.time % 60);
      const obs = evt.observation
        ? `<div class="obs">Species: <b>${evt.observation.species}</b><br>Damage type: <b>${evt.observation.damageType}</b><br>Observed defense: <b>${evt.observation.defense}</b></div>`
        : '';
      row.innerHTML = `<div class="ico">${evt.icon || '•'}</div><div class="body"><div class="msg">${evt.message}</div>${obs}<div class="time">t+${mins}:${String(secs).padStart(2, '0')}</div></div>`;
      row.addEventListener('click', () => onEventClick(game, evt));
      feed.appendChild(row);
    }
  }

  function onEventClick(game, evt) {
    if (evt.x != null && evt.y != null) CM.render.focusOn(game, evt.x, evt.y, 22);
    if (evt.traitId) { openDesigner(game); return; }
    if (evt.orgId && game.byId[evt.orgId]) { CORE.selectOrganism(game, evt.orgId); renderSelection(game); switchTab('explore'); return; }
    if (evt.colonyId && game.coloniesById && game.coloniesById[evt.colonyId]) {
      showInspect(game, 'colony', { colony: game.coloniesById[evt.colonyId] }); return;
    }
    if (evt.speciesId) showInspect(game, 'species', { speciesId: evt.speciesId });
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  }

  function updateBadges(game) {
    const ab = el('badge-analyze');
    if (game.ui.unreadAnalyze > 0) { ab.textContent = Math.min(99, game.ui.unreadAnalyze); ab.classList.remove('hidden'); }
    else ab.classList.add('hidden');

    const discovered = Object.keys(game.discovery.discoveredTraits).length;
    const db = el('badge-dna');
    if (discovered > game.ui.dnaBadgeSeen) { db.classList.remove('hidden'); db.classList.add('warn'); }
    else db.classList.add('hidden');
  }

  // -- genome designer -----------------------------------------------------
  function initDesigner(game, bus) {
    el('btn-designer-close').addEventListener('click', () => closeDesigner(game));
    el('btn-create-organism').addEventListener('click', () => {
      const org = CORE.createOrganismFromDraft(game, bus);
      if (org) { renderDesigner(game); toast({ kind: 'system', icon: '\u{1F9EA}', message: `${org.name} deployed near the Core.` }); }
    });
    el('btn-save-design').addEventListener('click', () => {
      const design = CORE.saveDesign(game);
      if (design) { renderDesignerDesigns(game); toast({ kind: 'system', icon: '\u{1F4BE}', message: `Saved ${design.name}.` }); }
    });
  }

  function openDesigner(game) {
    openSheet(game, 'designer-overlay');
    game.ui.dnaBadgeSeen = Object.keys(game.discovery.discoveredTraits).length;
    updateBadges(game);
    renderDesigner(game);
    startPreviewLoop(game);
  }
  function closeDesigner(game) { closeSheet(game, 'designer-overlay'); }

  function renderDesignerSlots(game) {
    const wrap = el('designer-slots');
    wrap.innerHTML = '';
    for (const cat of T.CATEGORIES) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      const current = game.designerDraft[cat];
      const currentTrait = current && T.TRAITS_BY_ID[current];
      const select = document.createElement('select');
      const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = 'None'; select.appendChild(noneOpt);
      const otherSlots = T.CATEGORIES.filter(c => c !== cat).map(c => game.designerDraft[c]);
      for (const t of T.TRAITS_BY_CATEGORY[cat]) {
        const opt = document.createElement('option');
        opt.value = t.id;
        const known = !!game.discovery.discoveredTraits[t.id];
        const blockedBy = known ? T.conflictsWith(otherSlots, t.id) : null;
        if (!known) opt.textContent = '\u{1F512} ' + t.name;               // not discovered yet
        else if (blockedBy) opt.textContent = '\u{2298} ' + t.name;        // biologically incompatible
        else opt.textContent = t.name;
        opt.disabled = !known || !!blockedBy;
        if (blockedBy) opt.title = `Incompatible with ${T.TRAITS_BY_ID[blockedBy].name}`;
        if (t.id === current) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener('change', () => {
        CORE.setDesignSlot(game, cat, select.value || null);
        renderDesigner(game);
      });
      slot.innerHTML = `<div class="cat">${cat}</div>`;
      const nameDiv = document.createElement('div');
      nameDiv.className = 'trait' + (currentTrait ? '' : ' empty');
      nameDiv.textContent = currentTrait ? currentTrait.name : 'Empty';
      slot.appendChild(nameDiv);
      slot.appendChild(select);
      wrap.appendChild(slot);
    }
  }

  function renderDesignerStats(game) {
    const wrap = el('designer-stats');
    const stats = CORE.draftStats(game);
    wrap.innerHTML = '';
    for (const [key, label] of STAT_ROWS) {
      const base = T.BASE_STATS[key];
      const val = stats[key];
      const delta = val - base;
      const max = STAT_MAXES[key] || 100;
      const row = document.createElement('div'); row.className = 'statrow';
      const pct = K.clamp01(val / max) * 100;
      const deltaTxt = Math.abs(delta) < 0.01 ? '' : (delta > 0 ? '+' + fmt1(delta) : fmt1(delta));
      // Colour by whether the change is *good*, not by its sign: a higher
      // metabolism or water requirement is a cost, and showing it in the
      // same green as a higher attack would invert the tradeoff the
      // designer exists to communicate.
      const deltaCls = Math.abs(delta) < 0.01 ? '' : (T.isBenefit(key, delta) ? 'pos' : 'neg');
      row.innerHTML = `<div class="label">${label}</div><div class="bar"><i style="width:${pct}%"></i></div><div class="val">${fmt1(val)}</div><div class="delta ${deltaCls}">${deltaTxt}</div>`;
      wrap.appendChild(row);
    }
  }

  function renderDesignerCost(game) {
    const cost = CORE.draftCost(game);
    const afford = CORE.canAfford(game, cost);
    el('designer-cost').innerHTML = `Cost: <span class="${game.core.biomass >= cost.biomass ? 'ok' : 'bad'}">${cost.biomass} biomass</span> &middot; <span class="${game.core.energy >= cost.energy ? 'ok' : 'bad'}">${cost.energy} energy</span>`;
    el('btn-create-organism').disabled = !afford;
    el('btn-save-design').disabled = CORE.draftTraitIds(game).length === 0;
  }

  /* Why these traits are worth putting together — or why they can't be. The
   * designer's whole job is making a tradeoff legible before it is paid for. */
  function renderDesignerCombo(game) {
    const wrap = el('designer-combo');
    const { conflicts, synergies } = CORE.draftCombination(game);
    wrap.innerHTML = '';
    for (const s of synergies) {
      const div = document.createElement('div');
      div.className = 'combo-note synergy';
      div.innerHTML = `<span>\u{1F517}</span><span><b>${T.TRAITS_BY_ID[s.a].name} + ${T.TRAITS_BY_ID[s.b].name}</b> reinforce each other — both traits' benefits are boosted ${Math.round(T.SYNERGY_BONUS * 100)}%.</span>`;
      wrap.appendChild(div);
    }
    for (const c of conflicts) {
      const div = document.createElement('div');
      div.className = 'combo-note conflict';
      div.innerHTML = `<span>\u{2298}</span><span><b>${T.TRAITS_BY_ID[c.a].name}</b> cannot coexist with <b>${T.TRAITS_BY_ID[c.b].name}</b>.</span>`;
      wrap.appendChild(div);
    }
  }

  /* Saved strains: tap to load one back into the draft, tap the x to drop it. */
  function renderDesignerDesigns(game) {
    const wrap = el('designer-designs');
    wrap.innerHTML = '';
    for (const design of game.designs) {
      const chip = document.createElement('button');
      chip.className = 'strain-chip';
      chip.innerHTML = `${design.name}<span class="del">×</span>`;
      chip.addEventListener('click', evt => {
        if (evt.target.classList.contains('del')) {
          CORE.deleteDesign(game, design.id);
        } else {
          CORE.loadDesign(game, design.id);
        }
        renderDesigner(game);
      });
      wrap.appendChild(chip);
    }
  }

  /* One entry point so every designer control redraws consistently — the
   * slots gate on each other (conflicts), so a partial refresh would leave
   * stale options enabled. */
  function renderDesigner(game) {
    renderDesignerSlots(game);
    renderDesignerCombo(game);
    renderDesignerStats(game);
    renderDesignerCost(game);
    renderDesignerDesigns(game);
  }

  function startPreviewLoop(game) {
    stopPreviewLoop(game);
    const canvas = el('preview-canvas');
    const ctx = canvas.getContext('2d');
    function frame() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      game.ui.previewAngle += 0.012;
      const traits = CORE.draftTraitIds(game);
      const stats = T.resolveStats(traits);
      const previewOrg = { traits, stats, health: stats.health, heading: game.ui.previewAngle, color: '#33e6b0', selected: false };
      // A fixed, generous zoom independent of the world camera — the
      // designer's job is to show off trait silhouettes up close, not to
      // represent true in-world scale.
      CM.render.drawOrganism(ctx, previewOrg, canvas.width / 2, canvas.height / 2, 55);
      game.ui.previewRaf = requestAnimationFrame(frame);
    }
    frame();
  }
  function stopPreviewLoop(game) {
    if (game.ui.previewRaf) cancelAnimationFrame(game.ui.previewRaf);
    game.ui.previewRaf = null;
  }

  // -- inspect overlay (samples / species / core) --------------------------
  function initInspect(game) {
    el('btn-inspect-close').addEventListener('click', () => closeSheet(game, 'inspect-overlay'));
  }

  function showInspect(game, kind, data) {
    const title = el('inspect-title'), body = el('inspect-body');
    if (kind === 'sample') {
      const s = data.sample;
      title.textContent = 'BIOLOGICAL SAMPLE';
      const traitChips = s.traits.map(id => `<span class="trait-chip">${T.TRAITS_BY_ID[id].name}</span>`).join('');
      body.innerHTML = `<div class="kv"><span class="k">Source</span><span>${s.name}</span></div>
        <div class="kv"><span class="k">Traits detected</span><span></span></div>
        <div style="margin-top:6px">${traitChips || '<span style="color:var(--fg-dim)">Unclear — needs more observation</span>'}</div>
        <button class="bigbtn extract-btn" id="btn-do-extract">EXTRACT SAMPLE</button>`;
      el('btn-do-extract').addEventListener('click', () => {
        D.extractSample(game, game.__bus, s.id);
        closeSheet(game, 'inspect-overlay');
      });
    } else if (kind === 'core') {
      title.textContent = 'COREMIND';
      body.innerHTML = `<div class="kv"><span class="k">Biomass</span><span>${Math.floor(game.core.biomass)}</span></div>
        <div class="kv"><span class="k">Energy</span><span>${Math.floor(game.core.energy)}</span></div>
        <div class="kv"><span class="k">Population</span><span>${game.stats.playerPop}</span></div>
        <p style="color:var(--fg-dim);font-size:12.5px;margin-top:10px">Every organism you deploy is grown from biomass and energy gathered by the colony. Send organisms to GATHER to keep the Core supplied.</p>`;
    } else if (kind === 'colony') {
      const colony = data.colony;
      const strategy = CM.colony.strategyOf(colony);
      title.textContent = colony.name.toUpperCase();
      const design = CM.colony.designTraitIds(colony.currentDesign)
        .map(id => `<span class="trait-chip">${T.TRAITS_BY_ID[id].name}</span>`).join('');
      body.innerHTML = `
        <div class="kv"><span class="k">Status</span><span>${colony.alive ? 'Active' : 'Collapsed'}</span></div>
        <div class="kv"><span class="k">Doctrine</span><span>${strategy.label}</span></div>
        <div class="kv"><span class="k">Population</span><span>${colony.pop}</span></div>
        <div class="kv"><span class="k">Core integrity</span><span>${Math.round(colony.integrity)}%</span></div>
        <div class="kv"><span class="k">Traits known</span><span>${Object.keys(colony.discovered).length}</span></div>
        <div class="kv"><span class="k">Kills / losses</span><span>${colony.kills} / ${colony.losses}</span></div>
        <div class="kv"><span class="k">Genome revision</span><span>${colony.designGeneration}</span></div>
        <p style="color:var(--fg-dim);font-size:12px;margin:10px 0 4px">${strategy.blurb}</p>
        <div class="research-head" style="margin-top:10px">CURRENT GENOME</div>
        <div>${design || '<span style="color:var(--fg-dim)">Unknown — no organism of theirs has been observed closely.</span>'}</div>`;
    } else if (kind === 'species') {
      const sp = T.WILD_BY_ID[data.speciesId];
      title.textContent = sp.name.toUpperCase();
      const traitChips = sp.traits.map(id => `<span class="trait-chip">${game.discovery.discoveredTraits[id] ? '' : '\u{1F512} '}${T.TRAITS_BY_ID[id].name}</span>`).join('');
      body.innerHTML = `<div class="kv"><span class="k">Role</span><span>${sp.tier}</span></div><div style="margin-top:6px">${traitChips}</div>`;
    } else if (kind === 'structure') {
      const site = data.site;
      const type = CM.structures.TYPES[site.type];
      const depth = CM.structures.DEPTHS[site.depth];
      const owner = game.coloniesById[site.colonyId];
      title.textContent = type.name.toUpperCase();
      const integrity = site.integrity == null ? 100 : Math.round(site.integrity);
      let rows = `<div class="kv"><span class="k">Stratum</span><span style="color:${depth.tint}">${depth.name}</span></div>
        <div class="kv"><span class="k">Colony</span><span style="color:${owner ? owner.color : '#889'}">${owner ? owner.name : 'unknown'}</span></div>
        <div class="kv"><span class="k">State</span><span>${site.done ? 'Complete' : Math.round(100 * site.work / site.workNeeded) + '% excavated'}</span></div>`;
      if (site.done) {
        rows += `<div class="kv"><span class="k">Integrity</span><span style="color:${integrity < 60 ? 'var(--danger)' : 'var(--fg)'}">${integrity}%</span></div>`;
      }
      if (site.veinId) {
        const vein = (game.world.veins || []).find(v => v.id === site.veinId);
        if (vein) rows += `<div class="kv"><span class="k">Seam remaining</span><span>${Math.round(vein.remaining)}</span></div>`;
      }
      body.innerHTML = rows + `<p style="color:var(--fg-dim);font-size:12.5px;margin-top:10px">${type.blurb}</p>`
        + (site.done && integrity < 100
          ? '<p style="color:var(--warn);font-size:12px;margin-top:6px">Something is chewing at this chamber. Organisms standing in it will drive them off.</p>'
          : '');
    }
    openSheet(game, 'inspect-overlay');
  }

  /* --- excavation ---------------------------------------------------------
   * The build sheet is a palette: tap a chamber, then tap the world to place
   * it. Placement stays live (the banner replaces the sheet) so the player is
   * choosing a spot while watching the actual ground, not a menu. */
  function initBuild(game, bus) {
    el('btn-build-close').addEventListener('click', () => closeSheet(game, 'build-overlay'));
    el('build-banner').addEventListener('click', evt => {
      if (evt.target.dataset && evt.target.dataset.act === 'cancel') setBuildMode(game, null);
    });
  }

  function openBuild(game) {
    openSheet(game, 'build-overlay');
    renderBuild(game);
  }

  function setBuildMode(game, typeKey) {
    game.buildMode = typeKey;
    // Siting a chamber is done against the surface — that is where the tap
    // has to land, so entering build mode surfaces the view.
    if (typeKey && game.viewDepth) { game.viewDepth = 0; renderDepthControls(game); }
    renderBuildBanner(game);
    if (typeKey) closeSheet(game, 'build-overlay');
    else renderBuild(game);
  }

  function renderBuildBanner(game) {
    const banner = el('build-banner');
    if (!game.buildMode) { banner.classList.add('hidden'); return; }
    const type = CM.structures.TYPES[game.buildMode];
    banner.innerHTML = `<span>${type.icon}</span>
      <span class="bb-text">Tap the ground to site a <b>${type.name}</b>.</span>
      <button data-act="cancel">Cancel</button>`;
    banner.classList.remove('hidden');
  }

  function renderBuild(game) {
    const body = el('build-body');
    const colony = game.core;
    const built = CM.structures.completed(game, colony.id);
    const pending = CM.structures.ofColony(game, colony.id).filter(s => !s.done);

    // Best digging stat available tells the player whether they can even
    // attempt the deeper chambers — a refusal has to be explicable.
    let bestDig = 0;
    for (const o of game.organisms) if (o.ownerId === colony.id && o.stats.digging > bestDig) bestDig = o.stats.digging;

    let html = `<div style="font-size:11.5px;color:var(--fg-dim);margin-bottom:8px">
      Network: <b style="color:var(--fg)">${built.length}</b> chambers &middot;
      ${pending.length} under excavation &middot; best digging <b style="color:var(--fg)">${Math.round(bestDig)}</b>
      </div>`;

    /* Grouped by stratum, deepest last. The palette is the clearest place to
     * show that the underground is a ladder rather than a shop: a level you
     * have not reached is listed, greyed, with the one thing that would open
     * it — otherwise the abyssal chambers would simply be invisible and the
     * player would never learn there is anywhere further to go. */
    const deepest = CM.structures.deepestOf(game, colony.id);
    for (let d = 1; d <= CM.structures.MAX_DEPTH; d++) {
      const info = CM.structures.DEPTHS[d];
      const reached = deepest >= d - 1;   // you can always cut one level below
      html += `<div class="depth-head"${reached ? '' : ' style="opacity:.5"'}>
        <span style="color:${info.tint}">${info.name.toUpperCase()}</span>
        <span>${reached ? `level ${d}` : 'sealed — dig the level above first'}</span></div>`;
      html += '<div class="build-grid">';
      for (const key of CM.structures.TYPE_KEYS) {
        const type = CM.structures.TYPES[key];
        if (type.depth !== d) continue;
        const cost = CM.structures.cost(key);
        const afford = colony.biomass >= cost.biomass && colony.energy >= cost.energy;
        const canDig = bestDig >= type.minDigging;
        const disabled = !afford || !canDig || !reached;
        let note = `${cost.biomass} biomass · ${cost.energy} energy`;
        if (!reached) note = `Sealed — cut ${CM.structures.DEPTHS[d - 1].name.toLowerCase()} first.`;
        else if (!canDig) note = `Needs digging ${type.minDigging} — none of your organisms can cut this.`;
        else if (!afford) note = `Not enough — needs ${cost.biomass} biomass, ${cost.energy} energy.`;
        else if (type.requiresVein) {
          const known = (game.world.veins || []).filter(v => v.known && !v.claimedBy).length;
          note += known ? ` · ${known} vein${known > 1 ? 's' : ''} found` : ' · no vein found yet';
        }
        html += `<button class="build-card${game.buildMode === key ? ' active' : ''}" data-type="${key}" ${disabled ? 'disabled' : ''}>
          <div class="bc-top"><span>${type.icon}</span><span>${type.name}</span></div>
          <div class="bc-cost">${note}</div>
          <div class="bc-blurb">${type.blurb}</div>
        </button>`;
      }
      html += '</div>';
    }

    if (pending.length) {
      html += '<div class="research-head" style="margin-top:12px">UNDER EXCAVATION</div><div class="build-list">';
      for (const site of pending) {
        const type = CM.structures.TYPES[site.type];
        const pct = Math.round(100 * site.work / site.workNeeded);
        html += `<button class="build-row" data-site="${site.id}">
          <span>${type.icon}</span><span style="flex:0 0 auto">${type.name}</span>
          <span class="br-bar"><i style="width:${pct}%"></i></span>
          <span style="color:var(--fg-dim)">${pct}%</span></button>`;
      }
      html += '</div>';
    }
    if (!built.length && !pending.length) {
      html += `<p style="color:var(--fg-dim);font-size:11.5px;margin-top:10px">
        Start with an <b>Access Shaft</b> — it is the only chamber that can be dug on open ground.
        Everything else must connect to a finished chamber. Then order your colony to <b>Dig</b>.</p>`;
    }
    body.innerHTML = html;

    body.querySelectorAll('.build-card').forEach(btn => {
      btn.addEventListener('click', () => setBuildMode(game, btn.dataset.type));
    });
    body.querySelectorAll('.build-row').forEach(btn => {
      btn.addEventListener('click', () => {
        const site = CM.structures.all(game).find(s => s.id === btn.dataset.site);
        if (site) { CM.render.focusOn(game, site.x, site.y, 16); closeSheet(game, 'build-overlay'); }
      });
    });
  }

  // -- world / colony panel -------------------------------------------------
  /* Refreshed on a slow cadence rather than per frame: it is a wall of text
   * whose numbers move slowly, and rebuilding it 60 times a second would cost
   * more than the whole simulation. */
  function renderWorldPanel(game) {
    const region = CM.world.regionAt(game.world, game.camera.x, game.camera.y);
    const biome = CM.world.biomeInfoAt(game.world, game.camera.x, game.camera.y);
    const temp = CM.world.tempAt(game.world, game.camera.x, game.camera.y);
    const hazard = CM.world.hazardAt(game.world, game.camera.x, game.camera.y);
    const hazardInfo = hazard ? CM.world.HAZARD_INFO[hazard] : null;

    el('world-readout').innerHTML =
      `<div class="kv"><span class="k">Region</span><span>${region && region.id ? region.name : 'Uncharted'}</span></div>
       <div class="kv"><span class="k">Terrain</span><span>${biome.name}</span></div>
       <div class="kv"><span class="k">Temperature</span><span>${Math.round(temp)}&deg;C</span></div>
       <div class="kv"><span class="k">Climate</span><span>${CM.climate.describe(game)}</span></div>
       ${hazardInfo ? `<div class="kv"><span class="k">Hazard</span><span style="color:var(--danger)">${hazardInfo.name}</span></div>` : ''}`;

    const counts = CM.colony.territoryCounts(game);
    const roster = el('colony-roster');
    roster.innerHTML = '<div class="research-head">COREMINDS</div>';
    for (const colony of game.colonies) {
      const row = document.createElement('button');
      row.className = 'colony-row' + (colony.alive ? '' : ' dead');
      const strategy = CM.colony.strategyOf(colony);
      const known = Object.keys(colony.discovered).length;
      row.innerHTML =
        `<span class="swatch" style="background:${colony.color}"></span>
         <span class="cbody">
           <span class="cname">${colony.name}${colony.isPlayer ? ' <em>(you)</em>' : ''}</span>
           <span class="cmeta">${colony.alive
             ? `${strategy.label} &middot; pop ${colony.pop} &middot; ${known} traits &middot; ${counts[colony.id] || 0} territory`
             : 'collapsed'}</span>
         </span>
         ${colony.alive && colony.integrity < 100 ? `<span class="cint">${Math.round(colony.integrity)}%</span>` : ''}`;
      row.addEventListener('click', () => {
        CM.render.focusOn(game, colony.x, colony.y, 14);
        showInspect(game, 'colony', { colony });
      });
      roster.appendChild(row);
    }
  }

  // -- per-frame refresh (cheap: text only) --------------------------------
  function render(game) {
    el('stat-biomass').querySelector('span').textContent = Math.floor(game.core.biomass) + '/' + game.core.biomassCap;
    el('stat-energy').querySelector('span').textContent = Math.floor(game.core.energy);
    el('stat-pop').querySelector('span').textContent = game.stats.playerPop + game.stats.herbivorePop + game.stats.predatorPop;
    el('stat-climate').querySelector('span').textContent = CM.climate.describe(game);

    // The world panel is text-heavy and slow-moving; refresh it about twice a
    // second and only while it is actually the visible tab.
    const ui = game.ui;
    ui.worldPanelAcc = (ui.worldPanelAcc || 0) + 1;
    if (ui.worldPanelAcc >= 30 && el('panel-world').classList.contains('active')) {
      ui.worldPanelAcc = 0;
      renderWorldPanel(game);
    }
    // The depth strip and sanctum meter change on the timescale of a chamber
    // being finished, so twice a second is plenty.
    ui.depthAcc = (ui.depthAcc || 0) + 1;
    if (ui.depthAcc >= 30) {
      ui.depthAcc = 0;
      renderDepthControls(game);
      renderSanctumMeter(game);
    }
  }

  CM.ui = { init, render, renderSelection, renderFeed, renderWorldPanel, updateBadges, showInspect, toast, switchTab,
    openSheet, closeSheet, anySheetOpen, openBuild, renderBuild, renderBuildBanner,
    setViewDepth, renderDepthControls, renderSanctumMeter };
})(window.CM = window.CM || {});
