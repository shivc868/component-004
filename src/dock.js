/* ---------------------------------------------------------------------------
   DOCK MAGNIFICATION — macOS-style fisheye on the timeline strip
   ---------------------------------------------------------------------------
   Tiles near the cursor scale up, neighbours scale proportionally less, and
   the whole run spreads apart so nothing overlaps.

   Two decisions worth knowing before editing:

   1. Scaling is done with `transform`, never `width`. Animating width would
      relayout the flex row every frame, and — because the row is centred —
      growing a tile would shift the row, which shifts the tile out from under
      the cursor, which changes the magnification. That feedback loop makes
      the whole strip jitter. Transforms don't affect layout, so the rest
      geometry stays fixed and the effect is stable.

   2. Distances are measured against each tile's REST centre, not its current
      on-screen rect. Same reason: a magnified tile's rect moves, and feeding
      that back into the falloff oscillates.
--------------------------------------------------------------------------- */

const PEAK_FALLBACK = 1.6;
const RADIUS_FALLBACK = 2.6;
// matches the CSS `.mfa-is-active` scale, so handing over to inline
// transforms on first hover isn't a visible jump
const ACTIVE_REST = 1.1;
const SMOOTHING = 0.24; // per-frame approach rate at 60fps
// how fast the ring slides between tiles; only affects the handoff, not how
// it tracks a tile it has already settled on
const RING_TRAVEL = 0.3;
const EPSILON = 0.0005;

export function initDock(list) {
  if (!list) return;

  const tiles = [...list.querySelectorAll(".mfa-player__thumb")];
  if (tiles.length === 0) return;

  // Coarse pointers have no hover to track, and reduced-motion users opted
  // out. Both fall back to the plain CSS :hover rules.
  const fine = matchMedia("(pointer: fine)");
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  if (!fine.matches || still.matches) return;

  const root = getComputedStyle(document.documentElement);
  const num = (prop, fallback) => {
    const v = parseFloat(root.getPropertyValue(prop));
    return Number.isFinite(v) ? v : fallback;
  };
  const peak = num("--mfa-dock-peak", PEAK_FALLBACK);
  const radiusInTiles = num("--mfa-dock-radius", RADIUS_FALLBACK);

  const rest = tiles.map((tile) => (tile.classList.contains("mfa-is-active") ? ACTIVE_REST : 1));
  const scale = [...rest];
  const target = [...rest];

  const ring = list.querySelector(".mfa-player__ring");
  const ringPad = num("--mfa-ring-pad", 4);
  const label = list.querySelector(".mfa-player__label");
  const labelGap = num("--mfa-label-gap", 12);
  let labelIndex = -1; // last title written, so we don't touch the DOM per frame

  // the "now playing" pair the strip drives
  const player = list.closest(".mfa-player");
  const heading = player?.querySelector(".mfa-player__heading");
  const cover = player?.querySelector(".mfa-player__cover-img");

  // Hover sweeps the active tile across the whole strip in a fraction of a
  // second, so every full-size cover has to be in cache before it's needed —
  // otherwise each swap blanks the <img> while it fetches.
  for (const tile of tiles) {
    if (tile.dataset.cover) new Image().src = tile.dataset.cover;
  }
  let activeIndex = Math.max(
    0,
    tiles.findIndex((t) => t.classList.contains("mfa-is-active"))
  );
  let hoverIndex = null;
  // Continuous position of the ring in tile-index space. Smoothing this
  // rather than the ring's pixel box is what keeps the ring welded to the
  // tile — see the ring block in render().
  let focusF = activeIndex;
  const boxLeft = new Array(tiles.length).fill(0);
  const boxW = new Array(tiles.length).fill(0);

  // rest geometry, captured with transforms cleared so rects are layout-true
  let base = 0;
  let gap = 0;
  let radius = 0;
  let centers = []; // page-space, i.e. viewport x + current scrollLeft
  let runOrigin = 0; // left edge of the run at rest, in that same space

  function measure() {
    const prior = tiles.map((tile) => tile.style.transform);
    tiles.forEach((tile) => {
      tile.style.transform = "none";
    });

    // read after the write above so all rects come from one clean layout pass
    const listLeft = list.getBoundingClientRect().left;
    const rects = tiles.map((tile) => tile.getBoundingClientRect());

    base = rects[0].width;
    gap = rects.length > 1 ? rects[1].left - rects[0].right : 0;
    radius = radiusInTiles * (base + gap);
    centers = rects.map((r) => r.left + r.width / 2 - listLeft + list.scrollLeft);
    // `justify-content: safe center` means the run doesn't start at the
    // padding edge, so anchor it off the measured first tile
    runOrigin = centers[0] - base / 2;

    tiles.forEach((tile, i) => {
      tile.style.transform = prior[i];
    });
  }

  let pointerX = null; // viewport x, null when the pointer is away
  let frame = 0;

  // Hover selects. Once the pointer leaves, the last hovered tile stays
  // active, so the ring parks there rather than snapping back somewhere else.
  function setActive(i) {
    if (i === activeIndex) return;
    activeIndex = i;
    for (let j = 0; j < tiles.length; j++) {
      const on = j === i;
      tiles[j].classList.toggle("mfa-is-active", on);
      if (on) tiles[j].setAttribute("aria-current", "true");
      else tiles[j].removeAttribute("aria-current");
      rest[j] = on ? ACTIVE_REST : 1;
    }

    const title = tiles[i].dataset.title;
    if (heading && title) heading.textContent = title;
    if (cover && tiles[i].dataset.cover) {
      cover.src = tiles[i].dataset.cover;
      if (title) cover.alt = `${title} — album artwork`;
    }
  }

  function retarget() {
    if (pointerX === null) {
      for (let i = 0; i < tiles.length; i++) target[i] = rest[i];
      hoverIndex = null;
      return;
    }
    // convert to the same page space the rest centres live in
    const x = pointerX - list.getBoundingClientRect().left + list.scrollLeft;

    // nearest rather than exact hit-testing, so the ring keeps tracking while
    // the cursor is in the gap between two tiles
    let nearest = 0;
    let nearestD = Infinity;
    for (let i = 0; i < tiles.length; i++) {
      const d = Math.abs(x - centers[i]);
      if (d < nearestD) {
        nearestD = d;
        nearest = i;
      }
    }
    hoverIndex = nearest;
    setActive(nearest); // must run before the targets below, it rewrites rest[]

    for (let i = 0; i < tiles.length; i++) {
      const d = Math.abs(x - centers[i]);
      // raised cosine: smooth at both the peak and the rim, unlike a linear
      // falloff which creases visibly where it hits zero
      const t = d >= radius ? 0 : 0.5 * (1 + Math.cos((Math.PI * d) / radius));
      target[i] = rest[i] + (peak - rest[i]) * t;
    }
  }

  function render() {
    frame = 0;
    let moving = false;

    // approach the targets; framerate-independent so a 120Hz display doesn't
    // converge twice as fast as a 60Hz one. deltaFrames() advances its own
    // clock, so it must be read exactly once per frame and shared.
    const dt = Math.min(deltaFrames(), 4);
    const k = 1 - Math.pow(1 - SMOOTHING, dt);
    for (let i = 0; i < tiles.length; i++) {
      const diff = target[i] - scale[i];
      if (Math.abs(diff) < EPSILON) {
        scale[i] = target[i];
      } else {
        scale[i] += diff * k;
        moving = true;
      }
    }

    // Lay the magnified run out by hand and derive each tile's offset from
    // where it sits at rest. Anchoring to the rest centre keeps the strip
    // growing symmetrically instead of drifting sideways.
    let total = gap * (tiles.length - 1);
    for (let i = 0; i < tiles.length; i++) total += base * scale[i];
    const restTotal = base * tiles.length + gap * (tiles.length - 1);

    let cursor = (restTotal - total) / 2;
    for (let i = 0; i < tiles.length; i++) {
      const w = base * scale[i];
      const restCenter = i * (base + gap) + base / 2;
      const dx = cursor + w / 2 - restCenter;
      boxLeft[i] = runOrigin + cursor; // `cursor` is this tile's visual left
      boxW[i] = w;
      cursor += w + gap;
      tiles[i].style.transform = `translateX(${dx.toFixed(2)}px) scale(${scale[i].toFixed(4)})`;
    }

    /* The ring is read straight off the tile boxes computed above — never
       smoothed on its own. Smoothing a pixel box that is itself chasing a
       smoothed scale stacks two lags, which is what made the ring visibly
       trail the tile as it grew.

       Only the ring's position *in tile-index space* is eased. Once it has
       settled on a tile, focusF is an exact integer and the ring is that
       tile's box to the pixel, so the two grow as one object. Mid-handoff it
       interpolates between the two tiles it sits between. */
    if (ring) {
      const focus = hoverIndex === null ? activeIndex : hoverIndex;
      const drift = focus - focusF;
      if (Math.abs(drift) < 0.001) {
        focusF = focus;
      } else {
        focusF += drift * (1 - Math.pow(1 - RING_TRAVEL, dt));
        moving = true;
      }

      const i0 = Math.floor(focusF);
      const i1 = Math.min(i0 + 1, tiles.length - 1);
      const f = focusF - i0;
      const left = boxLeft[i0] + (boxLeft[i1] - boxLeft[i0]) * f;
      const w = boxW[i0] + (boxW[i1] - boxW[i0]) * f;

      ring.style.transform = `translateX(${(left - ringPad).toFixed(2)}px)`;
      ring.style.width = `${(w + ringPad * 2).toFixed(2)}px`;
      ring.style.height = `${(w + ringPad * 2).toFixed(2)}px`;

      if (label) {
        // rides the same interpolated box as the ring, so the two never drift
        const cx = left + w / 2;
        const lift = w + labelGap;
        // the -50% is resolved against the label's own width, which centres it
        // without JS ever measuring the text
        label.style.transform = `translate(calc(${cx.toFixed(2)}px - 50%), ${-lift.toFixed(2)}px)`;

        if (hoverIndex !== null && hoverIndex !== labelIndex) {
          labelIndex = hoverIndex;
          label.textContent = tiles[hoverIndex].dataset.title || "";
        }
        const showing = hoverIndex !== null;
        if (label.classList.contains("mfa-is-on") !== showing) {
          label.classList.toggle("mfa-is-on", showing);
        }
      }
    }

    if (moving) frame = requestAnimationFrame(render);
  }

  let last = 0;
  function deltaFrames() {
    const now = performance.now();
    const dt = last ? (now - last) / 16.667 : 1;
    last = now;
    return dt;
  }

  function kick() {
    if (!frame) {
      last = 0; // don't let a long idle gap produce a huge first step
      frame = requestAnimationFrame(render);
    }
  }

  list.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    pointerX = e.clientX;
    retarget();
    kick();
  });

  list.addEventListener("pointerleave", () => {
    pointerX = null;
    retarget();
    kick();
  });

  // a scroll slides the tiles under a stationary cursor, so re-solve
  list.addEventListener("scroll", () => {
    retarget();
    kick();
  });

  const onResize = () => {
    measure();
    retarget();
    kick();
  };
  window.addEventListener("resize", onResize);

  // Hover already selects, so this only matters for keyboard activation —
  // where there's no pointer to have set it.
  list.addEventListener("click", (e) => {
    const hit = e.target.closest(".mfa-player__thumb");
    if (!hit) return;
    setActive(tiles.indexOf(hit));
    retarget();
    kick();
  });

  measure();
  list.classList.add("mfa-dock-on");
  // paint the rest state once so every tile owns an inline transform from the
  // start — otherwise the first hover hands over from the CSS rules abruptly
  kick();

  // Fonts and the thumbnail images both land after first paint and can shift
  // the row, which invalidates every cached centre.
  if (document.fonts?.ready) document.fonts.ready.then(onResize);
  window.addEventListener("load", onResize);
}
