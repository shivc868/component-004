import "./style.css";
import "./demo.css"; // showcase page only — not part of the component
import gsap from "gsap";

// GSAP is used without any global config (no registerPlugin / defaults /
// ticker changes) so it can share a page with a host app's own GSAP.

const POOL = 20; // reusable card layers, so overlapping flights each get one
const FLY_MIN = 0.34;
const FLY_MAX = 0.72;
const PACE = 2.4; // gap between changes (ms) -> flight length (s)
const EASE_FLY = "power2.out";

const ACTIVE_REST = 1.1; // matches .mfa-is-active in the CSS
const SMOOTHING = 0.24; // fisheye easing
const PAN_SMOOTHING = 0.18; // hover-pan easing
const RING_TRAVEL = 0.6;
const EPSILON = 0.0005;

const css = getComputedStyle(document.documentElement);
const token = (name, fallback) => {
  const v = parseFloat(css.getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
};

// -- Centre photo -----------------------------------------------------------
// A pool of stacked layers. Each change flies one layer in from its dock
// thumbnail: it starts scaled/translated onto the tile, then animates to fill
// the stage, so the little photo looks like it lifts off and grows.
function createTurner(root) {
  const stage = root?.querySelector(".mfa-cards__stage");
  const seed = stage?.querySelector(".mfa-cards__card");
  if (!stage || !seed) return { play() {} };

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  const cards = [seed];
  for (let i = 1; i < POOL; i++) {
    const clone = seed.cloneNode(true);
    stage.appendChild(clone);
    cards.push(clone);
  }

  let z = POOL;
  let last = 0;
  const flights = new Map();

  const setArt = (card, src, alt) => {
    const img = card.querySelector(".mfa-cards__art");
    if (img) {
      img.src = src;
      img.alt = alt || "";
    }
  };

  // Seed on top (its photo is on show); clones hidden beneath, ready to reuse.
  cards.forEach((card, i) => {
    card.style.zIndex = String(i === 0 ? POOL : i);
    gsap.set(card, {
      opacity: i === 0 ? 1 : 0,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
    });
  });
  cards.push(cards.shift());

  // Transform that lays the stage box exactly over the source thumbnail.
  const flightFrom = (el) => {
    const s = stage.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    if (!s.width || !t.width) return null;
    return {
      x: t.left + t.width / 2 - (s.left + s.width / 2),
      y: t.top + t.height / 2 - (s.top + s.height / 2),
      scaleX: t.width / s.width,
      scaleY: t.height / s.height,
    };
  };

  function play(src, alt, fromEl) {
    if (!src) return;

    const card = cards.shift();
    cards.push(card);
    setArt(card, src, alt);
    card.style.zIndex = String(++z); // latest change always lands on top

    flights.get(card)?.kill(); // a reused layer may still owe us a landing
    flights.delete(card);
    gsap.killTweensOf(card);

    const from = fromEl && !reduced.matches ? flightFrom(fromEl) : null;
    if (!from) {
      gsap.set(card, { opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1 });
      return;
    }

    const now = performance.now();
    const gap = last ? now - last : Infinity;
    last = now;
    const dur = gsap.utils.clamp(FLY_MIN, FLY_MAX, (gap / 1000) * PACE);

    // Hurry any cards still in the air so a fast sweep lands roughly in order.
    const allowed = dur * 0.85;
    for (const t of flights.values()) {
      const left = t.duration() - t.time();
      if (left / t.timeScale() > allowed) t.timeScale(left / allowed);
    }

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

// -- Dock -------------------------------------------------------------------
// macOS-style fisheye strip. Hover magnifies tiles and sets the active member;
// when the strip is wider than the screen it pans to follow the cursor.
function initDock(list) {
  if (!list) return;
  const tiles = [...list.querySelectorAll(".mfa-cards__thumb")];
  if (!tiles.length) return;

  const root = list.closest(".mfa-cards");
  const title = root?.querySelector(".mfa-cards__title");
  const role = root?.querySelector(".mfa-cards__role");
  const turner = createTurner(root);

  // Preload covers so a fast sweep never blanks the incoming photo.
  for (const t of tiles) if (t.dataset.cover) new Image().src = t.dataset.cover;

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
    tiles.forEach((t, j) => {
      const on = j === i;
      t.classList.toggle("mfa-is-active", on);
      if (on) t.setAttribute("aria-current", "true");
      else t.removeAttribute("aria-current");
      rest[j] = on ? ACTIVE_REST : 1;
    });

    const name = tiles[i].dataset.title;
    if (title && name) title.textContent = name;
    if (role) role.textContent = tiles[i].dataset.role || "";
    turner.play(
      tiles[i].dataset.cover,
      name ? `${name} — artwork` : "",
      tiles[i],
    );
  }

  // Tap works everywhere (touch has no hover), so wire it before the gate.
  list.addEventListener("click", (e) => {
    const hit = e.target.closest(".mfa-cards__thumb");
    if (!hit) return;
    setActive(tiles.indexOf(hit));
    if (magnify) {
      retarget();
      kick();
    }
  });

  // Everything below is hover-only.
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
  let focusF = activeIndex; // ring position, in tile-index space
  let pointerX = null;
  let frame = 0;

  // Rest-state row geometry plus pan bounds (maxScroll 0 means it all fits).
  let base = 0;
  let gap = 0;
  let radius = 0;
  let centers = [];
  let runOrigin = 0;
  let listLeft = 0;
  let viewW = 0;
  let maxScroll = 0;

  function measure() {
    const prior = tiles.map((t) => t.style.transform);
    tiles.forEach((t) => (t.style.transform = "none"));

    listLeft = list.getBoundingClientRect().left;
    const rects = tiles.map((t) => t.getBoundingClientRect());
    base = rects[0].width;
    gap = rects.length > 1 ? rects[1].left - rects[0].right : 0;
    radius = radiusInTiles * (base + gap);
    centers = rects.map(
      (r) => r.left + r.width / 2 - listLeft + list.scrollLeft,
    );
    runOrigin = centers[0] - base / 2;
    viewW = list.clientWidth;
    maxScroll = Math.max(0, list.scrollWidth - list.clientWidth);

    tiles.forEach((t, i) => (t.style.transform = prior[i]));
  }

  // Falloff is measured from each tile's rest centre; a live (magnified) rect
  // would feed back into itself and oscillate.
  function retarget() {
    if (pointerX === null) {
      for (let i = 0; i < tiles.length; i++) target[i] = rest[i];
      hoverIndex = null;
      return;
    }

    const x = pointerX - list.getBoundingClientRect().left + list.scrollLeft;
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
    setActive(nearest); // rewrites rest[], so it has to run before the falloff

    for (let i = 0; i < tiles.length; i++) {
      const d = Math.abs(x - centers[i]);
      const t = d >= radius ? 0 : 0.5 * (1 + Math.cos((Math.PI * d) / radius)); // raised cosine
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
    const dt = Math.min(deltaFrames(), 4);

    // Pan: cursor position across the viewport maps to scroll across the strip.
    if (maxScroll > 0 && pointerX !== null) {
      const frac = Math.min(1, Math.max(0, (pointerX - listLeft) / viewW));
      const goal = frac * maxScroll;
      const cur = list.scrollLeft;
      const d = goal - cur;
      if (Math.abs(d) > 0.5) {
        list.scrollLeft = cur + d * (1 - Math.pow(1 - PAN_SMOOTHING, dt));
        moving = true;
      } else if (cur !== goal) {
        list.scrollLeft = goal;
      }
      retarget();
    }

    // Ease each tile's scale toward its target.
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

    // Lay out with transforms, not width, so the row never reflows or jitters.
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

    // Travelling ring + label. Only the index position is eased; its box is
    // read straight off the tiles so it can't lag behind a growing one.
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
    clock = 0; // a long idle gap would otherwise make a huge first step
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
  kick();

  // Fonts and thumbnails land after first paint and shift the row.
  document.fonts?.ready.then(onResize);
  window.addEventListener("load", onResize);
}

initDock(document.querySelector(".mfa-cards__dock"));
