import "./style.css";
import "./demo.css"; // showcase page only — do NOT copy into your project
import gsap from "gsap";

/* GSAP is used as a guest here: no registerPlugin, no gsap.defaults, no
   gsap.config, no gsap.ticker changes. Every kill and every overwrite names
   its own targets, the rAF loop below is our own rather than the GSAP ticker,
   and all queries are scoped to the component root — so this can sit in a
   codebase with its own GSAP setup without either side fighting the other. */

// Card layers. One flight needs a layer for its whole duration, and a fast
// sweep across the dock launches a new flight every few frames, so this is
// how many can be in the air before the oldest layer gets reused.
const POOL = 5;

const FLY_MIN = 0.34;
const FLY_MAX = 0.72;
const PACE = 2.4; // ms between changes -> seconds of flight

// the thumbnail lifts off the strip, crosses to the stage and grows into it;
// inOut so both the takeoff and the landing are eased, not just one end
const EASE_FLY = "power2.inOut";

const ACTIVE_REST = 1.1; // matches the .mfa-is-active scale in CSS
const SMOOTHING = 0.24;
const PAN_SMOOTHING = 0.18; // easing of the hover-pan when the strip overflows
const RING_TRAVEL = 0.3;
const EPSILON = 0.0005;

const css = getComputedStyle(document.documentElement);
const token = (name, fallback) => {
  const v = parseFloat(css.getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
};

/* -------------------------------------------------------------------------
   Turner — the centre card, flown in from the dock thumbnail
   ------------------------------------------------------------------------- */

function createTurner(root) {
  const stage = root?.querySelector(".mfa-cards__stage");
  const seed = stage?.querySelector(".mfa-cards__card");
  if (!stage || !seed) return { play() {} };

  const still = matchMedia("(prefers-reduced-motion: reduce)");

  const cards = [seed];
  for (let i = 1; i < POOL; i++) {
    const clone = seed.cloneNode(true);
    stage.appendChild(clone);
    cards.push(clone);
  }

  // cards[0] is the next layer to be used and the oldest still on screen;
  // every flight takes from the front and pushes to the back.
  let z = POOL;
  let last = 0;
  const flights = new Map();

  function setArt(card, src, alt) {
    const img = card.querySelector(".mfa-cards__art");
    if (!img) return;
    img.src = src;
    img.alt = alt || "";
  }

  /* The seed holds the artwork the card was authored with, so it is the one
     on show: top of the z stack, and rotated to the back of the queue so it is
     the last layer reused. The clones sit under it fully transparent — a
     reused layer must never flash its old cover before its flight starts. */
  cards.forEach((card, i) => {
    card.style.zIndex = String(i === 0 ? POOL : i);
    gsap.set(card, { opacity: i === 0 ? 1 : 0, x: 0, y: 0, scaleX: 1, scaleY: 1 });
  });
  cards.push(cards.shift());

  /* The flight maps the stage box onto the source thumbnail: a scale for the
     size, a translate for the offset between their two centres. The card is
     parked on that transform so it sits exactly over the thumbnail, then the
     transform is animated away to fill the stage — so the image looks like it
     lifts off the dock and grows into the centre. Both rects are read live at
     launch, so it is right at any size with nothing cached to go stale. The
     thumbnail is read after its dock magnification, i.e. from wherever it
     actually is on screen at that instant. */
  function flightFrom(fromEl) {
    const s = stage.getBoundingClientRect();
    const t = fromEl.getBoundingClientRect();
    if (!s.width || !t.width) return null;
    return {
      x: t.left + t.width / 2 - (s.left + s.width / 2),
      y: t.top + t.height / 2 - (s.top + s.height / 2),
      scaleX: t.width / s.width,
      scaleY: t.height / s.height,
    };
  }

  function play(src, alt, fromEl) {
    if (!src) return;

    const card = cards.shift();
    cards.push(card);

    setArt(card, src, alt);
    card.style.zIndex = String(++z); // always over whatever is already down

    // a recycled layer may still owe us a landing from POOL changes ago
    flights.get(card)?.kill();
    flights.delete(card);
    gsap.killTweensOf(card);

    const from = fromEl && !still.matches ? flightFrom(fromEl) : null;
    if (!from) {
      // reduced motion, or nothing to fly from: just show it at the centre
      gsap.set(card, { opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1 });
      return;
    }

    const now = performance.now();
    const gap = last ? now - last : Infinity;
    last = now;
    const dur = gsap.utils.clamp(FLY_MIN, FLY_MAX, (gap / 1000) * PACE);

    /* Cards must land in the order they were launched, or an earlier one
       arrives after a later one and — holding the lower z — settles underneath
       it, leaving the wrong cover on top. The first change of a sweep always
       gets the longest flight, so this bites constantly. Hurry the ones
       already in the air rather than stretching this one. */
    const allowed = dur * 0.85;
    for (const t of flights.values()) {
      const left = t.duration() - t.time();
      if (left / t.timeScale() > allowed) t.timeScale(left / allowed);
    }

    // parked on the thumbnail and fully opaque, so the takeoff reads as the
    // tile itself lifting rather than a new thing fading in over it
    gsap.set(card, { opacity: 1, ...from });

    const tl = gsap.timeline({ onComplete: () => flights.delete(card) });
    flights.set(card, tl);
    tl.to(card, {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      duration: dur,
      ease: EASE_FLY,
    });
  }

  return { play };
}

/* -------------------------------------------------------------------------
   Dock — macOS-style fisheye on the thumbnail strip
   ------------------------------------------------------------------------- */

function initDock(list) {
  if (!list) return;

  const tiles = [...list.querySelectorAll(".mfa-cards__thumb")];
  if (!tiles.length) return;

  const cards = list.closest(".mfa-cards");
  const title = cards?.querySelector(".mfa-cards__title");
  const role = cards?.querySelector(".mfa-cards__role");
  const turner = createTurner(cards);

  // a sweep crosses the whole strip in a fraction of a second, so the covers
  // have to be cached before they're needed or each swap blanks the <img>
  for (const tile of tiles) {
    if (tile.dataset.cover) new Image().src = tile.dataset.cover;
  }

  const rest = tiles.map((t) =>
    t.classList.contains("mfa-is-active") ? ACTIVE_REST : 1,
  );
  let activeIndex = Math.max(
    0,
    tiles.findIndex((t) => t.classList.contains("mfa-is-active")),
  );
  let magnify = false;

  function setActive(i) {
    if (i < 0 || i === activeIndex) return;
    activeIndex = i;
    for (let j = 0; j < tiles.length; j++) {
      const on = j === i;
      tiles[j].classList.toggle("mfa-is-active", on);
      if (on) tiles[j].setAttribute("aria-current", "true");
      else tiles[j].removeAttribute("aria-current");
      rest[j] = on ? ACTIVE_REST : 1;
    }

    const name = tiles[i].dataset.title;
    if (title && name) title.textContent = name;
    if (role) role.textContent = tiles[i].dataset.role || "";
    // the tile it flies from is this same active thumbnail — the card lifts
    // off it and grows into the centre, and the outgoing centre card stays
    // beneath until the new one has covered it
    turner.play(tiles[i].dataset.cover, name ? `${name} — artwork` : "", tiles[i]);
  }

  /* Wired above the pointer gate on purpose: on touch this is the entire
     interaction, and the page turn has to happen there too. */
  list.addEventListener("click", (e) => {
    const hit = e.target.closest(".mfa-cards__thumb");
    if (!hit) return;
    setActive(tiles.indexOf(hit));
    if (magnify) {
      retarget();
      kick();
    }
  });

  // below here is hover-only; coarse pointers and reduced-motion keep the page
  // turn, the tap above, and the CSS :hover rules
  if (!matchMedia("(pointer: fine)").matches) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const peak = token("--mfa-dock-peak", 1.6);
  const radiusInTiles = token("--mfa-dock-radius", 2.6);
  const ringPad = token("--mfa-ring-pad", 4);
  const labelGap = token("--mfa-label-gap", 12);

  const ring = list.querySelector(".mfa-cards__ring");
  const label = list.querySelector(".mfa-cards__label");
  let labelIndex = -1;

  const scale = [...rest];
  const target = [...rest];
  const boxLeft = new Array(tiles.length).fill(0);
  const boxW = new Array(tiles.length).fill(0);

  let hoverIndex = null;
  let focusF = activeIndex; // ring position in tile-index space
  let pointerX = null;
  let frame = 0;

  let base = 0;
  let gap = 0;
  let radius = 0;
  let centers = [];
  let runOrigin = 0;

  // hover-pan geometry, refreshed on measure: the strip's left edge and width
  // in the viewport, and how far it can scroll before the right end shows.
  // maxScroll 0 means the whole roster fits and there is nothing to pan.
  let listLeft = 0;
  let viewW = 0;
  let maxScroll = 0;

  function measure() {
    const prior = tiles.map((t) => t.style.transform);
    tiles.forEach((t) => {
      t.style.transform = "none";
    });

    listLeft = list.getBoundingClientRect().left;
    const rects = tiles.map((t) => t.getBoundingClientRect());

    base = rects[0].width;
    gap = rects.length > 1 ? rects[1].left - rects[0].right : 0;
    radius = radiusInTiles * (base + gap);
    centers = rects.map(
      (r) => r.left + r.width / 2 - listLeft + list.scrollLeft,
    );
    // `safe center` means the run doesn't start at the padding edge
    runOrigin = centers[0] - base / 2;

    // read with the transforms cleared, though scale transforms don't affect
    // scroll metrics anyway
    viewW = list.clientWidth;
    maxScroll = Math.max(0, list.scrollWidth - list.clientWidth);

    tiles.forEach((t, i) => {
      t.style.transform = prior[i];
    });
  }

  /* Distances come from each tile's REST centre, never its live rect. A
     magnified tile's rect moves, and feeding that back into the falloff
     oscillates. */
  function retarget() {
    if (pointerX === null) {
      for (let i = 0; i < tiles.length; i++) target[i] = rest[i];
      hoverIndex = null;
      return;
    }

    const x = pointerX - list.getBoundingClientRect().left + list.scrollLeft;

    // nearest, not hit-testing, so the ring keeps tracking between two tiles
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
    setActive(nearest); // must run first, it rewrites rest[]

    for (let i = 0; i < tiles.length; i++) {
      const d = Math.abs(x - centers[i]);
      // raised cosine: smooth at the peak and at the rim, unlike a linear
      // falloff which creases where it hits zero
      const t = d >= radius ? 0 : 0.5 * (1 + Math.cos((Math.PI * d) / radius));
      target[i] = rest[i] + (peak - rest[i]) * t;
    }
  }

  let clock = 0;
  function deltaFrames() {
    const now = performance.now();
    const dt = clock ? (now - clock) / 16.667 : 1;
    clock = now;
    return dt;
  }

  function render() {
    frame = 0;
    let moving = false;

    // deltaFrames advances its own clock, so read it once and share it
    const dt = Math.min(deltaFrames(), 4);

    /* Hover-pan. When the roster is too wide to fit, the cursor's position
       across the viewport maps straight to a position across the whole strip:
       at the left edge the strip sits at scroll 0 (its left end on show), at
       the right edge it sits at maxScroll (right end on show), and the middle
       is centred. Driven through scrollLeft rather than a transform so the
       fisheye and the travelling ring — both already written in scroll-aware
       coordinates — pan along with it for free. retarget() runs straight after
       so the magnified tile and the active/centre photo track whoever the
       cursor is now over as the strip slides beneath it. */
    if (maxScroll > 0 && pointerX !== null) {
      const frac = Math.min(1, Math.max(0, (pointerX - listLeft) / viewW));
      const goalScroll = frac * maxScroll;
      const cur = list.scrollLeft;
      const d = goalScroll - cur;
      if (Math.abs(d) > 0.5) {
        list.scrollLeft = cur + d * (1 - Math.pow(1 - PAN_SMOOTHING, dt));
        moving = true;
      } else if (cur !== goalScroll) {
        list.scrollLeft = goalScroll;
      }
      retarget();
    }

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

    /* Scaled with transform, never width. Animating width relayouts the row
       every frame and — because the row is centred — growing a tile shifts the
       row, which shifts the tile out from under the cursor. That loop makes
       the strip jitter. Anchoring to the rest centre also keeps it growing
       symmetrically instead of drifting sideways. */
    let total = gap * (tiles.length - 1);
    for (let i = 0; i < tiles.length; i++) total += base * scale[i];
    const restTotal = base * tiles.length + gap * (tiles.length - 1);

    let cursor = (restTotal - total) / 2;
    for (let i = 0; i < tiles.length; i++) {
      const w = base * scale[i];
      const restCenter = i * (base + gap) + base / 2;
      const dx = cursor + w / 2 - restCenter;
      boxLeft[i] = runOrigin + cursor;
      boxW[i] = w;
      cursor += w + gap;
      tiles[i].style.transform =
        `translateX(${dx.toFixed(2)}px) scale(${scale[i].toFixed(4)})`;
    }

    /* The ring is read straight off those boxes — smoothing a pixel box that
       is itself chasing a smoothed scale stacks two lags and the ring visibly
       trails the tile as it grows. Only its position in tile-index space is
       eased, so once settled it matches the tile to the pixel. */
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
        const cx = left + w / 2;
        // the -50% resolves against the label's own width, so it self-centres
        // without ever measuring the text
        label.style.transform = `translate(calc(${cx.toFixed(2)}px - 50%), ${-(w + labelGap).toFixed(2)}px)`;

        if (hoverIndex !== null && hoverIndex !== labelIndex) {
          labelIndex = hoverIndex;
          label.textContent = tiles[hoverIndex].dataset.title || "";
        }
        const on = hoverIndex !== null;
        if (label.classList.contains("mfa-is-on") !== on)
          label.classList.toggle("mfa-is-on", on);
      }
    }

    if (moving) frame = requestAnimationFrame(render);
  }

  function kick() {
    if (frame) return;
    clock = 0; // a long idle gap would otherwise produce a huge first step
    frame = requestAnimationFrame(render);
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

  // scrolling slides the tiles under a stationary cursor
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

  measure();
  magnify = true;
  list.classList.add("mfa-dock-on");
  kick(); // paint the rest state so every tile owns an inline transform

  // fonts and thumbnails land after first paint and shift the row
  document.fonts?.ready.then(onResize);
  window.addEventListener("load", onResize);
}

initDock(document.querySelector(".mfa-cards__dock"));
