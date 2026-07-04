'use strict';

/* ==========================================================================
   adyhb — application script
   Organized into small, focused modules so features (persistence, accounts,
   search, moderation, ...) can be layered in later without a rewrite.
   ========================================================================== */

/* ----------------------------------------------------------------------
   Utils
   ---------------------------------------------------------------------- */

const Utils = (() => {
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const lerp = (a, b, t) => a + (b - a) * t;

  const prefersReducedMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  let idCounter = 0;
  const nextId = () => `n${Date.now().toString(36)}${(idCounter++).toString(36)}`;

  return { clamp, lerp, prefersReducedMotion, nextId };
})();

/* ----------------------------------------------------------------------
   Camera
   Owns world <-> screen transforms, pan/zoom state and smoothing.
   ---------------------------------------------------------------------- */

const Camera = (() => {
  const state = {
    x: 0, y: 0, zoom: 1,           // current (rendered) base values
    targetX: 0, targetY: 0, targetZoom: 1, // where we're smoothing toward
  };

  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 3;

  // Pan chases its target quickly (still lagged, for a floaty feel);
  // zoom eases more slowly, giving it a faint "breathing" delay.
  const PAN_SMOOTH = Utils.prefersReducedMotion ? 1 : 0.16;
  const ZOOM_SMOOTH = Utils.prefersReducedMotion ? 1 : 0.09;

  // Inertia: velocity is expressed in world units per tick and decays by
  // FRICTION every frame once the pointer is released.
  const FRICTION = 0.94;
  const VELOCITY_EPSILON = 0.02;
  const MAX_VELOCITY = 32; // world units/tick — keeps very fast flicks in check
  let velocityX = 0;
  let velocityY = 0;
  let isDragging = false;

  // Idle sway + far-zoom jitter are applied as a screen-space offset only —
  // they never touch state.x/y/zoom, so world <-> screen math (and every
  // sticky note's anchor) stays exact regardless of how much the view wobbles.
  let idleSince = performance.now();
  let swayPxX = 0;
  let swayPxY = 0;
  let jitterX = 0, jitterY = 0;
  let jitterTargetX = 0, jitterTargetY = 0;
  let lastJitterPick = 0;

  const SWAY_FADE_IN_MS = 1400;   // how long idle before sway reaches full strength
  const SWAY_AMP_X = 5.5;         // px, at full strength
  const SWAY_AMP_Y = 3.5;         // px
  const JITTER_ZOOM_THRESHOLD = 0.38;
  const JITTER_MAX_AMP = 1.1;     // px
  const JITTER_PICK_INTERVAL = 140; // ms between new jitter targets

  let viewportW = window.innerWidth;
  let viewportH = window.innerHeight;

  function setViewport(w, h) {
    viewportW = w;
    viewportH = h;
  }

  function worldToScreen(wx, wy) {
    return {
      x: (wx - state.x) * state.zoom + viewportW / 2 + swayPxX,
      y: (wy - state.y) * state.zoom + viewportH / 2 + swayPxY,
    };
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - swayPxX - viewportW / 2) / state.zoom + state.x,
      y: (sy - swayPxY - viewportH / 2) / state.zoom + state.y,
    };
  }

  function markInteraction() {
    idleSince = performance.now();
  }

  function startDrag() {
    isDragging = true;
    velocityX = 0;
    velocityY = 0;
    markInteraction();
  }

  function endDrag() {
    isDragging = false;
    markInteraction();
  }

  // Pan by a screen-space delta (used while dragging). Also records a
  // smoothed velocity so the camera can keep drifting after release.
  function panByScreenDelta(dx, dy) {
    const worldDx = dx / state.zoom;
    const worldDy = dy / state.zoom;

    state.targetX -= worldDx;
    state.targetY -= worldDy;
    state.x = state.targetX;
    state.y = state.targetY;

    velocityX = Utils.lerp(velocityX, -worldDx, 0.45);
    velocityY = Utils.lerp(velocityY, -worldDy, 0.45);
    velocityX = Utils.clamp(velocityX, -MAX_VELOCITY, MAX_VELOCITY);
    velocityY = Utils.clamp(velocityY, -MAX_VELOCITY, MAX_VELOCITY);

    markInteraction();
  }

  // Zoom by a multiplicative factor, keeping the world point under
  // (sx, sy) fixed on screen.
  function zoomAt(sx, sy, factor) {
    const before = screenToWorld(sx, sy);
    state.targetZoom = Utils.clamp(state.targetZoom * factor, MIN_ZOOM, MAX_ZOOM);

    // Preview the new zoom against the current target x/y to compute the
    // correction; the smoothing loop eases the rest of the way in.
    const testZoom = state.targetZoom;
    const afterX = (sx - swayPxX - viewportW / 2) / testZoom + state.targetX;
    const afterY = (sy - swayPxY - viewportH / 2) / testZoom + state.targetY;

    state.targetX += before.x - afterX;
    state.targetY += before.y - afterY;

    markInteraction();
  }

  function reset() {
    state.targetX = 0;
    state.targetY = 0;
    state.targetZoom = 1;
    velocityX = 0;
    velocityY = 0;
    markInteraction();
  }

  function applyInertia() {
    if (isDragging) return;
    if (Math.abs(velocityX) < VELOCITY_EPSILON && Math.abs(velocityY) < VELOCITY_EPSILON) return;

    state.targetX += velocityX;
    state.targetY += velocityY;
    velocityX *= FRICTION;
    velocityY *= FRICTION;
  }

  function updateSway(now) {
    const idleMs = now - idleSince;
    const strength = isDragging
      ? 0
      : Utils.clamp(idleMs / SWAY_FADE_IN_MS, 0, 1);

    if (strength > 0) {
      const t = now * 0.001;
      swayPxX = (Math.sin(t * 0.21) * 0.6 + Math.sin(t * 0.09 + 1.7) * 0.4) * SWAY_AMP_X * strength;
      swayPxY = (Math.cos(t * 0.17) * 0.6 + Math.sin(t * 0.13 + 0.6) * 0.4) * SWAY_AMP_Y * strength;
    } else {
      swayPxX = 0;
      swayPxY = 0;
    }

    // Extremely subtle flicker-like jitter once zoomed far out — picks a new
    // tiny random target every ~140ms and eases toward it, rather than
    // jumping every frame, so it reads as unease rather than static.
    if (state.zoom < JITTER_ZOOM_THRESHOLD) {
      const depth = Utils.clamp((JITTER_ZOOM_THRESHOLD - state.zoom) / JITTER_ZOOM_THRESHOLD, 0, 1);
      if (now - lastJitterPick > JITTER_PICK_INTERVAL) {
        jitterTargetX = (Math.random() * 2 - 1) * JITTER_MAX_AMP * depth;
        jitterTargetY = (Math.random() * 2 - 1) * JITTER_MAX_AMP * depth;
        lastJitterPick = now;
      }
      jitterX = Utils.lerp(jitterX, jitterTargetX, 0.12);
      jitterY = Utils.lerp(jitterY, jitterTargetY, 0.12);
    } else {
      jitterX = Utils.lerp(jitterX, 0, 0.12);
      jitterY = Utils.lerp(jitterY, 0, 0.12);
    }

    swayPxX += jitterX;
    swayPxY += jitterY;
  }

  // Advance current values toward targets. Returns true if anything is
  // still moving (kept for API compatibility; the render loop no longer
  // needs to branch on it, but it's a useful signal for future callers).
  function tick() {
    applyInertia();

    const dx = state.targetX - state.x;
    const dy = state.targetY - state.y;
    const dz = state.targetZoom - state.zoom;

    const moving = Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001 || Math.abs(dz) > 0.0001
      || Math.abs(velocityX) > VELOCITY_EPSILON || Math.abs(velocityY) > VELOCITY_EPSILON;

    state.x = Utils.lerp(state.x, state.targetX, PAN_SMOOTH);
    state.y = Utils.lerp(state.y, state.targetY, PAN_SMOOTH);
    state.zoom = Utils.lerp(state.zoom, state.targetZoom, ZOOM_SMOOTH);

    // Snap when very close to avoid an endless, imperceptible tail.
    if (Math.abs(state.targetX - state.x) < 0.02) state.x = state.targetX;
    if (Math.abs(state.targetY - state.y) < 0.02) state.y = state.targetY;
    if (Math.abs(state.targetZoom - state.zoom) < 0.0005) state.zoom = state.targetZoom;

    updateSway(performance.now());

    return moving;
  }

  function isFarZoomedOut() {
    return state.zoom < JITTER_ZOOM_THRESHOLD;
  }

  function getSway() {
    return { x: swayPxX, y: swayPxY };
  }

  return {
    state,
    setViewport,
    worldToScreen,
    screenToWorld,
    panByScreenDelta,
    zoomAt,
    reset,
    tick,
    startDrag,
    endDrag,
    isFarZoomedOut,
    getSway,
  };
})();

/* ----------------------------------------------------------------------
   Renderer
   Draws the infinite dotted background onto the canvas.
   ---------------------------------------------------------------------- */

const Renderer = (() => {
  let canvas, ctx, worldLayerEl;
  let dpr = Math.max(1, window.devicePixelRatio || 1);
  let w = 0, h = 0;

  const BASE_SPACING = 42;      // world units between dots at zoom 1
  const MIN_SCREEN_GAP = 30;    // px
  const MAX_SCREEN_GAP = 120;   // px
  const DOT_COLOR = 'rgba(220, 216, 206, 0.045)';
  const DOT_COLOR_STRONG = 'rgba(220, 216, 206, 0.09)';

  function init(canvasEl, worldLayer) {
    canvas = canvasEl;
    worldLayerEl = worldLayer;
    ctx = canvas.getContext('2d');
    resize();
  }

  function resize() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    Camera.setViewport(w, h);
  }

  function spacingForZoom(zoom) {
    let spacing = BASE_SPACING;
    while (spacing * zoom < MIN_SCREEN_GAP) spacing *= 2;
    while (spacing * zoom > MAX_SCREEN_GAP) spacing /= 2;
    return spacing;
  }

  function draw() {
    const { x: camX, y: camY, zoom } = Camera.state;
    const sway = Camera.getSway();

    ctx.clearRect(0, 0, w, h);

    const spacing = spacingForZoom(zoom);

    const topLeft = Camera.screenToWorld(0, 0);
    const bottomRight = Camera.screenToWorld(w, h);

    const startX = Math.floor(topLeft.x / spacing) * spacing;
    const startY = Math.floor(topLeft.y / spacing) * spacing;

    const radius = Utils.clamp(1.1 * zoom, 0.8, 2.2);

    // Every 4th line gets a very slightly stronger dot to give a faint
    // sense of scale/orientation without ever reading as a hard grid.
    const strongEvery = 4;
    let strongCol = Math.round(startX / spacing) % strongEvery;
    let strongRow = Math.round(startY / spacing) % strongEvery;
    if (strongCol < 0) strongCol += strongEvery;
    if (strongRow < 0) strongRow += strongEvery;

    // Dots quietly fade out toward the far edges of the screen, so the
    // grid feels like it's dissolving into the dark rather than stopping.
    const cx = w / 2;
    const cy = h / 2;
    const maxDist = Math.hypot(cx, cy) * 1.05;

    let rowIndex = 0;
    for (let wy = startY; wy <= bottomRight.y; wy += spacing, rowIndex++) {
      const sy = (wy - camY) * zoom + cy + sway.y;
      const isStrongRow = (strongRow + rowIndex) % strongEvery === 0;

      let colIndex = 0;
      for (let wx = startX; wx <= bottomRight.x; wx += spacing, colIndex++) {
        const sx = (wx - camX) * zoom + cx + sway.x;
        const isStrong = isStrongRow && (strongCol + colIndex) % strongEvery === 0;

        const dist = Math.hypot(sx - cx, sy - cy);
        const edgeFade = Utils.clamp(1 - dist / maxDist, 0, 1);
        if (edgeFade <= 0.02) continue;

        ctx.beginPath();
        ctx.fillStyle = isStrong ? DOT_COLOR_STRONG : DOT_COLOR;
        ctx.globalAlpha = edgeFade;
        ctx.arc(sx, sy, isStrong ? radius * 1.35 : radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Far zoomed-out views go slightly soft, like a memory rather than a
    // place you're standing in.
    const distant = Camera.isFarZoomedOut();
    canvas.classList.toggle('is-distant', distant);
    if (worldLayerEl) worldLayerEl.classList.toggle('is-distant', distant);
  }

  return { init, resize, draw };
})();

/* ----------------------------------------------------------------------
   StickyNotes
   In-memory store + DOM rendering for notes.
   ---------------------------------------------------------------------- */

const StickyNotes = (() => {
  const PAPERS = [
    { id: 'cream', label: 'Cream' },
    { id: 'sage', label: 'Sage' },
    { id: 'sky', label: 'Sky' },
    { id: 'blush', label: 'Blush' },
    { id: 'lilac', label: 'Lilac' },
  ];

  const notes = [];          // in-memory only, per spec
  let worldLayer = null;
  let onNoteClick = null;    // callback(note)

  function init(worldLayerEl, clickHandler) {
    worldLayer = worldLayerEl;
    onNoteClick = clickHandler;
  }

  function create({ x, y, title, message, paper }) {
    const note = {
      id: Utils.nextId(),
      x, y,
      title: (title || '').trim(),
      message: message.trim(),
      paper,
      rotation: (Math.random() * 8 - 4).toFixed(2), // -4deg .. 4deg
    };
    notes.push(note);
    renderNote(note);
    return note;
  }

  function renderNote(note) {
    const el = document.createElement('div');
    el.className = 'sticky-note';
    el.style.left = `${note.x}px`;
    el.style.top = `${note.y}px`;
    el.dataset.id = note.id;

    const drift = document.createElement('div');
    drift.className = 'sticky-note-drift';

    const surface = document.createElement('div');
    surface.className = `sticky-note-surface paper-${note.paper}`;
    surface.style.setProperty('--note-rot', `${note.rotation}deg`);

    if (note.title) {
      const titleEl = document.createElement('h3');
      titleEl.className = 'sticky-note-title';
      titleEl.textContent = note.title;
      surface.appendChild(titleEl);
    }

    const msgEl = document.createElement('p');
    msgEl.className = 'sticky-note-message';
    msgEl.textContent = note.message;
    surface.appendChild(msgEl);

    surface.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onNoteClick) onNoteClick(note);
    });
    // Prevent a click-and-drag starting on a note from triggering a pan.
    surface.addEventListener('mousedown', (e) => e.stopPropagation());

    drift.appendChild(surface);
    el.appendChild(drift);
    worldLayer.appendChild(el);

    // Trigger enter animation on next frame.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => el.classList.add('is-in'));
    });
  }

  return { PAPERS, init, create, all: () => notes };
})();

/* ----------------------------------------------------------------------
   UI
   Modals, buttons, coordinate readout, help.
   ---------------------------------------------------------------------- */

const UI = (() => {
  let els = {};
  let pendingWorldPos = null;  // where a new note will be placed
  let selectedPaper = 'cream';

  function init() {
    els = {
      coords: document.getElementById('coords-display'),
      resetBtn: document.getElementById('reset-view-btn'),
      helpBtn: document.getElementById('help-btn'),

      noteModal: document.getElementById('note-modal'),
      noteModalClose: document.getElementById('note-modal-close'),
      noteForm: document.getElementById('note-form'),
      noteTitleInput: document.getElementById('note-title-input'),
      noteMessageInput: document.getElementById('note-message-input'),
      colorSwatches: document.getElementById('color-swatches'),
      noteCancelBtn: document.getElementById('note-cancel-btn'),

      noteView: document.getElementById('note-view'),
      noteViewTitle: document.getElementById('note-view-title'),
      noteViewMessage: document.getElementById('note-view-message'),
      noteViewCloseBtn: document.getElementById('note-view-close-btn'),

      helpModal: document.getElementById('help-modal'),
      helpModalClose: document.getElementById('help-modal-close'),
    };

    buildSwatches();
    bindGlobalEvents();
  }

  function buildSwatches() {
    els.colorSwatches.innerHTML = '';
    StickyNotes.PAPERS.forEach((paper, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `swatch paper-${paper.id}`;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', i === 0 ? 'true' : 'false');
      btn.setAttribute('aria-label', paper.label);
      btn.dataset.paper = paper.id;
      btn.addEventListener('click', () => selectPaper(paper.id));
      els.colorSwatches.appendChild(btn);
    });
    selectedPaper = StickyNotes.PAPERS[0].id;
  }

  function selectPaper(id) {
    selectedPaper = id;
    [...els.colorSwatches.children].forEach((btn) => {
      btn.setAttribute('aria-checked', btn.dataset.paper === id ? 'true' : 'false');
    });
  }

  function bindGlobalEvents() {
    els.resetBtn.addEventListener('click', () => Camera.reset());

    els.helpBtn.addEventListener('click', () => openModal(els.helpModal));
    els.helpModalClose.addEventListener('click', () => closeModal(els.helpModal));

    els.noteModalClose.addEventListener('click', () => closeModal(els.noteModal));
    els.noteCancelBtn.addEventListener('click', () => closeModal(els.noteModal));
    els.noteViewCloseBtn.addEventListener('click', () => closeModal(els.noteModal));

    [els.noteModal, els.helpModal].forEach((overlay) => {
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) closeModal(overlay);
      });
    });

    els.noteForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const message = els.noteMessageInput.value.trim();
      if (!message || !pendingWorldPos) return;

      StickyNotes.create({
        x: pendingWorldPos.x,
        y: pendingWorldPos.y,
        title: els.noteTitleInput.value,
        message,
        paper: selectedPaper,
      });

      closeModal(els.noteModal);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        [els.noteModal, els.helpModal].forEach((overlay) => {
          if (!overlay.hidden) closeModal(overlay);
        });
      }
    });
  }

  function openModal(overlay) {
    overlay.hidden = false;
    // Force reflow so the transition runs from the hidden state.
    void overlay.offsetWidth;
    overlay.classList.add('is-open');
  }

  function closeModal(overlay) {
    overlay.classList.remove('is-open');
    const finish = () => { overlay.hidden = true; };
    if (Utils.prefersReducedMotion) {
      finish();
    } else {
      overlay.addEventListener('transitionend', finish, { once: true });
    }
  }

  function openCreateNote(worldPos) {
    pendingWorldPos = worldPos;
    els.noteForm.hidden = false;
    els.noteView.hidden = true;
    els.noteTitleInput.value = '';
    els.noteMessageInput.value = '';
    selectPaper(StickyNotes.PAPERS[0].id);
    openModal(els.noteModal);
    // Focus after the open transition begins.
    setTimeout(() => els.noteMessageInput.focus(), 50);
  }

  function openViewNote(note) {
    els.noteForm.hidden = true;
    els.noteView.hidden = false;
    els.noteViewTitle.textContent = note.title || 'Note';
    els.noteViewMessage.textContent = note.message;
    openModal(els.noteModal);
  }

  function isAnyModalOpen() {
    return !els.noteModal.hidden || !els.helpModal.hidden;
  }

  function updateCoords(worldX, worldY) {
    els.coords.textContent = `${Math.round(worldX)}, ${Math.round(worldY)}`;
  }

  return { init, openCreateNote, openViewNote, isAnyModalOpen, updateCoords };
})();

/* ----------------------------------------------------------------------
   Ambient
   No audio is implemented yet. This module exists purely as the future
   home for it: a single enabled flag, a toggle, and a listener list so an
   AudioContext-based player can subscribe later without touching UI code.
   ---------------------------------------------------------------------- */

const Ambient = (() => {
  let enabled = false;
  const listeners = [];

  function isEnabled() {
    return enabled;
  }

  function toggle() {
    enabled = !enabled;
    listeners.forEach((fn) => fn(enabled));
    return enabled;
  }

  // Future ambient players register here, e.g.:
  //   Ambient.onChange((on) => on ? player.fadeIn() : player.fadeOut());
  function onChange(fn) {
    listeners.push(fn);
  }

  return { isEnabled, toggle, onChange };
})();

/* ----------------------------------------------------------------------
   App
   Wires up input handling and drives the render loop.
   ---------------------------------------------------------------------- */

const App = (() => {
  const CLICK_DRAG_THRESHOLD = 5; // px

  let appEl, canvasEl, glowEl, worldLayerEl, ambientBtn;

  let isPointerDown = false;
  let hasDragged = false;
  let lastPointer = { x: 0, y: 0 };
  let downPointer = { x: 0, y: 0 };

  function init() {
    appEl = document.getElementById('app');
    canvasEl = document.getElementById('grid-canvas');
    glowEl = document.getElementById('cursor-glow');
    worldLayerEl = document.getElementById('world-layer');
    ambientBtn = document.getElementById('ambient-toggle-btn');

    Renderer.init(canvasEl, worldLayerEl);
    StickyNotes.init(worldLayerEl, (note) => UI.openViewNote(note));
    UI.init();

    bindEvents();
    requestAnimationFrame(loop);
  }

  function bindEvents() {
    window.addEventListener('resize', () => Renderer.resize());

    appEl.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);

    appEl.addEventListener('wheel', onWheel, { passive: false });

    // Ambient sound toggle — no audio wired up yet (see the Ambient module).
    ambientBtn.addEventListener('click', () => {
      const on = Ambient.toggle();
      ambientBtn.setAttribute('aria-pressed', String(on));
    });

    // Ambient glow follows the cursor.
    appEl.addEventListener('mouseenter', () => glowEl.classList.add('is-visible'));
    appEl.addEventListener('mouseleave', () => glowEl.classList.remove('is-visible'));

    // Basic touch support: single-finger drag pans the canvas.
    appEl.addEventListener('touchstart', onTouchStart, { passive: true });
    appEl.addEventListener('touchmove', onTouchMove, { passive: false });
    appEl.addEventListener('touchend', onTouchEnd);
  }

  function onPointerDown(e) {
    if (UI.isAnyModalOpen()) return;
    if (e.button !== 0) return; // left click only
    // Only start a pan/click-to-create gesture when the gesture begins on
    // the background itself — not on floating UI chrome (buttons, etc.)
    // that happens to sit above it in the stacking order.
    if (e.target !== canvasEl && e.target !== worldLayerEl) return;
    isPointerDown = true;
    hasDragged = false;
    lastPointer = { x: e.clientX, y: e.clientY };
    downPointer = { x: e.clientX, y: e.clientY };
    Camera.startDrag();
  }

  function onPointerMove(e) {
    updateGlow(e.clientX, e.clientY);

    const worldPos = Camera.screenToWorld(e.clientX, e.clientY);
    UI.updateCoords(worldPos.x, worldPos.y);

    if (!isPointerDown) return;

    const dx = e.clientX - lastPointer.x;
    const dy = e.clientY - lastPointer.y;

    const totalDx = e.clientX - downPointer.x;
    const totalDy = e.clientY - downPointer.y;
    if (Math.hypot(totalDx, totalDy) > CLICK_DRAG_THRESHOLD) {
      hasDragged = true;
    }

    if (hasDragged) {
      appEl.classList.add('is-dragging');
      Camera.panByScreenDelta(dx, dy);
    }

    lastPointer = { x: e.clientX, y: e.clientY };
  }

  function onPointerUp(e) {
    if (!isPointerDown) return;
    isPointerDown = false;
    appEl.classList.remove('is-dragging');
    Camera.endDrag();

    if (!hasDragged && !UI.isAnyModalOpen()) {
      // A clean click on empty space opens the "leave a note" modal.
      const worldPos = Camera.screenToWorld(e.clientX, e.clientY);
      UI.openCreateNote(worldPos);
    }
    hasDragged = false;
  }

  function onWheel(e) {
    e.preventDefault();
    if (UI.isAnyModalOpen()) return;
    const factor = Math.exp(-e.deltaY * 0.0012);
    Camera.zoomAt(e.clientX, e.clientY, factor);
  }

  function updateGlow(x, y) {
    glowEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  // --- minimal touch handling (single finger pan only) ---
  let touchLast = null;

  function onTouchStart(e) {
    if (e.touches.length !== 1 || UI.isAnyModalOpen()) return;
    if (e.target !== canvasEl && e.target !== worldLayerEl) return;
    const t = e.touches[0];
    touchLast = { x: t.clientX, y: t.clientY };
    downPointer = { x: t.clientX, y: t.clientY };
    hasDragged = false;
    Camera.startDrag();
  }

  function onTouchMove(e) {
    if (!touchLast || e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    const dx = t.clientX - touchLast.x;
    const dy = t.clientY - touchLast.y;

    const totalDx = t.clientX - downPointer.x;
    const totalDy = t.clientY - downPointer.y;
    if (Math.hypot(totalDx, totalDy) > CLICK_DRAG_THRESHOLD) hasDragged = true;

    if (hasDragged) Camera.panByScreenDelta(dx, dy);
    touchLast = { x: t.clientX, y: t.clientY };
  }

  function onTouchEnd(e) {
    if (!touchLast) return;
    Camera.endDrag();
    if (!hasDragged && !UI.isAnyModalOpen()) {
      const worldPos = Camera.screenToWorld(touchLast.x, touchLast.y);
      UI.openCreateNote(worldPos);
    }
    touchLast = null;
    hasDragged = false;
  }

  // --- render loop ---
  function loop() {
    Camera.tick();
    Renderer.draw();

    const { x, y, zoom } = Camera.state;
    const sway = Camera.getSway();
    const cx = window.innerWidth / 2 + sway.x;
    const cy = window.innerHeight / 2 + sway.y;
    // Matches Camera.worldToScreen: screen = (world - cam) * zoom + center + sway
    worldLayerEl.style.transform =
      `translate(${cx}px, ${cy}px) scale(${zoom}) translate(${-x}px, ${-y}px)`;

    requestAnimationFrame(loop);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
