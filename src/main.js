import "./style.css";
import "./demo.css"; // showcase page only — do NOT copy into your project
import gsap from "gsap";

/* GSAP is used as a guest here: no registerPlugin, no gsap.defaults, no
   gsap.config, no gsap.ticker changes. Every kill and every overwrite names
   its own targets, the rAF loop below is our own rather than the GSAP ticker,
   and all queries are scoped to the component root — so this can sit in a
   codebase with its own GSAP setup without either side fighting the other. */

const DECK = 4; // cards showing in the corner
const PILE = 6; // cards parked at centre before the bottom one is recycled
const POOL = DECK + PILE;
const SCALE_STEP = 0.075; // each slot up the deck is this much smaller

const FLIGHT_MIN = 0.26;
const FLIGHT_MAX = 0.68;
const PACE = 2.2; // ms between deals -> seconds of flight
const DECK_Z = 50; // deck cards keep their own z band, below anything dealt

const EASE_X = "power2.out";
const EASE_Y = "power1.out"; // lags x, which bows the flight into an arc
const EASE_SCALE = "expo.out";
const EASE_FLIP = "power2.inOut";
const EASE_SHIFT = "power2.out";

const ACTIVE_REST = 1.1; // matches the .mfa-is-active scale in CSS
const SMOOTHING = 0.24;
const RING_TRAVEL = 0.3;
const EPSILON = 0.0005;

const css = getComputedStyle(document.documentElement);
const token = (name, fallback) => {
  const v = parseFloat(css.getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
};

/* -------------------------------------------------------------------------
   Dealer — the corner deck, thrown onto the centre pile
   ------------------------------------------------------------------------- */

function createDealer(root) {
  const stage = root?.querySelector(".mfa-cards__stage");
  const anchor = root?.querySelector(".mfa-cards__deck");
  const seed = stage?.querySelector(".mfa-cards__card");
  if (!stage || !anchor || !seed) return { play() {}, setAwake() {} };

  const still = matchMedia("(prefers-reduced-motion: reduce)");

  const all = [seed];
  for (let i = 1; i < POOL; i++) {
    const clone = seed.cloneNode(true);
    stage.appendChild(clone);
    all.push(clone);
  }

  // pile[0] is the buried bottom of the centre stack and the next to be
  // recycled; pile's last entry is what's on show. deck[0] is dealt next.
  const pile = all.slice(0, PILE);
  const deck = all.slice(PILE);

  // graduated while hovering, uniform at rest. A coarse pointer has no hover
  // to wake it, so it starts fanned and stays that way.
  let awake = !matchMedia("(pointer: fine)").matches;
  let slots = [];
  let z = 0;
  let last = 0;
  const flights = new Map();

  const flipOf = (card) => card.querySelector(".mfa-cards__card-flip");

  function setArt(card, src, alt) {
    const img = card.querySelector(".mfa-cards__art");
    if (!img) return;
    img.src = src;
    img.alt = alt || "";
  }

  // The stage and the anchor are the only boxes in here never transformed, so
  // their rects stay layout-true and can be read mid-flight.
  function measure() {
    const s = stage.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    if (!s.width || !a.width) return false;

    const x = a.left + a.width / 2 - (s.left + s.width / 2);
    const y = a.top + a.height / 2 - (s.top + s.height / 2);
    const base = a.width / s.width;

    slots = [];
    for (let i = 0; i <= DECK; i++) {
      slots.push({
        x, // one centre for every slot, so the cards nest rather than fan
        y,
        live: base * (1 - (DECK - 1 - i) * SCALE_STEP),
        rest: base,
      });
    }
    return true;
  }

  const slotVars = (i) => {
    const s = slots[Math.min(i, DECK)];
    return { x: s.x, y: s.y, scale: awake ? s.live : s.rest };
  };

  function settle(instant) {
    deck.forEach((card, i) => {
      card.style.zIndex = String(DECK_Z - i);
      const vars = { ...slotVars(i), opacity: 1 };
      if (instant) gsap.set(card, vars);
      else gsap.to(card, { ...vars, duration: 0.42, ease: EASE_SHIFT, overwrite: true });
    });
  }

  /* Keep the topmost LANDED card, not pile's last entry — when that entry is
     still flying, the card under it is what's actually on screen and has to
     hold the centre until the incoming one covers it. In-flight cards are
     exempt or they'd vanish mid-air. Every landing re-runs this. */
  function trimPile() {
    if (awake) return;

    let showing = -1;
    for (let i = pile.length - 1; i >= 0; i--) {
      if (!flights.has(pile[i])) {
        showing = i;
        break;
      }
    }

    pile.forEach((card, i) => {
      if (i === showing || flights.has(card)) return;
      gsap.to(card, { opacity: 0, duration: 0.3, ease: "power1.out" });
    });
  }

  function setAwake(on) {
    if (on === awake) return;
    awake = on;
    settle(false);
    trimPile();
  }

  function layout() {
    if (!measure()) return;
    pile.forEach((card, i) => {
      gsap.set(card, { x: 0, y: 0, scale: 1, opacity: 1 });
      gsap.set(flipOf(card), { rotateY: 0 });
      card.style.zIndex = String(i);
    });
    deck.forEach((card) => gsap.set(flipOf(card), { rotateY: 180 }));
    settle(true);
    z = PILE;
  }

  function play(src, alt) {
    if (!src) return;
    if (!slots.length && !measure()) return;

    const card = deck.shift();
    const recycled = pile.shift();
    pile.push(card);
    deck.push(recycled);

    setArt(card, src, alt);
    card.style.zIndex = String(DECK_Z + 50 + ++z);

    if (still.matches) {
      gsap.set(card, { x: 0, y: 0, scale: 1, opacity: 1 });
      gsap.set(flipOf(card), { rotateY: 0 });
      gsap.set(recycled, { ...slotVars(DECK), opacity: 1 });
      gsap.set(flipOf(recycled), { rotateY: 180 });
      settle(true);
      return;
    }

    const now = performance.now();
    const gap = last ? now - last : Infinity;
    last = now;
    const dur = gsap.utils.clamp(FLIGHT_MIN, FLIGHT_MAX, (gap / 1000) * PACE);

    /* Cards must land in the order they were dealt or an earlier one arrives
       after a later one and, holding the lower z, slides in underneath it.
       The first card of a sweep always gets the longest flight, so this bites
       constantly. Hurry the ones already in the air rather than stretching
       this one, which would undo the speed matching. */
    const allowed = dur * 0.85;
    for (const t of flights.values()) {
      const left = t.duration() - t.time();
      if (left / t.timeScale() > allowed) t.timeScale(left / allowed);
    }

    flights.get(card)?.kill(); // a recycled card may still owe us a landing
    gsap.killTweensOf([card, flipOf(card)]);
    gsap.set(card, { opacity: 1 }); // may have been mid-fade from a trim

    const tl = gsap.timeline({
      onComplete: () => {
        flights.delete(card);
        trimPile();
      },
    });
    flights.set(card, tl);

    /* Scale is the fast one here: expo.out reaches full size roughly a third
       of the way in, so the card is already at centre size while it is still
       travelling, and the rest of the flight is pure glide. */
    // .to() not .fromTo() — if this card was still sliding up a deck slot when
    // it got dealt, it departs from wherever it actually is.
    tl.to(card, { x: 0, duration: dur, ease: EASE_X }, 0)
      .to(card, { y: 0, duration: dur, ease: EASE_Y }, 0)
      .to(card, { scale: 1, duration: dur, ease: EASE_SCALE }, 0)
      // lands face-up with a beat to spare rather than still turning over
      .to(flipOf(card), { rotateY: 0, duration: dur * 0.7, ease: EASE_FLIP }, dur * 0.12);

    // the replacement slides up from below the deck; full opacity would pop
    gsap.killTweensOf([recycled, flipOf(recycled)]);
    gsap.set(recycled, { ...slotVars(DECK), opacity: 0 });
    gsap.set(flipOf(recycled), { rotateY: 180 });

    const shift = Math.max(dur, 0.32);
    deck.forEach((c, i) => {
      c.style.zIndex = String(DECK_Z - i);
      gsap.to(c, {
        ...slotVars(i),
        opacity: 1,
        duration: shift,
        ease: EASE_SHIFT,
        overwrite: true, // retarget mid-shift instead of snapping first
      });
    });
  }

  layout();
  window.addEventListener("resize", () => {
    if (measure()) settle(false);
  });

  return { play, setAwake };
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
  const dealer = createDealer(cards);

  // a sweep crosses the whole strip in a fraction of a second, so the covers
  // have to be cached before they're needed or each swap blanks the <img>
  for (const tile of tiles) {
    if (tile.dataset.cover) new Image().src = tile.dataset.cover;
  }

  const rest = tiles.map((t) => (t.classList.contains("mfa-is-active") ? ACTIVE_REST : 1));
  let activeIndex = Math.max(0, tiles.findIndex((t) => t.classList.contains("mfa-is-active")));
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
    // the dealer loads the art onto the incoming card, so the resting one
    // keeps the outgoing image until the new one covers it
    dealer.play(tiles[i].dataset.cover, name ? `${name} — artwork` : "");
  }

  /* Wired above the pointer gate on purpose: on touch this is the entire
     interaction, and the deck has to exist there too. */
  list.addEventListener("click", (e) => {
    const hit = e.target.closest(".mfa-cards__thumb");
    if (!hit) return;
    setActive(tiles.indexOf(hit));
    if (magnify) {
      retarget();
      kick();
    }
  });

  // below here is hover-only; coarse pointers and reduced-motion keep the deck,
  // the tap above, and the CSS :hover rules
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

  function measure() {
    const prior = tiles.map((t) => t.style.transform);
    tiles.forEach((t) => {
      t.style.transform = "none";
    });

    const listLeft = list.getBoundingClientRect().left;
    const rects = tiles.map((t) => t.getBoundingClientRect());

    base = rects[0].width;
    gap = rects.length > 1 ? rects[1].left - rects[0].right : 0;
    radius = radiusInTiles * (base + gap);
    centers = rects.map((r) => r.left + r.width / 2 - listLeft + list.scrollLeft);
    // `safe center` means the run doesn't start at the padding edge
    runOrigin = centers[0] - base / 2;

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
      dealer.setAwake(false);
      return;
    }
    dealer.setAwake(true);

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
      tiles[i].style.transform = `translateX(${dx.toFixed(2)}px) scale(${scale[i].toFixed(4)})`;
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
        if (label.classList.contains("mfa-is-on") !== on) label.classList.toggle("mfa-is-on", on);
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
