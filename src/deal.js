/* ---------------------------------------------------------------------------
   DEAL — a five-card deck in the corner, dealt onto the centre pile
   ---------------------------------------------------------------------------
   The corner holds a graduated stack of five face-down cards: slot 0 on top at
   full deck size, each slot below it a little smaller and a little lower. On
   every track change the top card flips its way to centre stage, the four
   behind it each shift up a slot, and a fresh card slides in at the bottom, so
   the deck is always five deep.

   Where the fresh card comes from: the bottom-most card of the centre pile is
   recycled. It is completely covered by the cards that landed after it, so
   teleporting it back to the corner is never visible. That keeps a fixed pool
   of elements no matter how long the strip is hovered.

   Staying smooth under a fast hover comes down to two things:

     - every deck tween uses `overwrite: true`, so a card caught mid-shift is
       retargeted from wherever it currently is rather than snapping first;
     - the dealt card flies with `.to()` from its live position, so if it was
       still sliding up a slot when it got dealt, it simply departs from
       there. No frame ever has to be thrown away.

   Structure per card (each box owns exactly one transform):

     .mfa-player__stage     layout box + perspective. Never transformed, so it
                            is always safe to measure from.
       .mfa-player__layer   position in the world: deck slot, or centre
         .mfa-player__flip  the flip: rotateY
           .__cover         front face (artwork)
           .__cover-back    back face (card back)
--------------------------------------------------------------------------- */

import gsap from "gsap";

const DECK = 4; // cards visible in the corner
const PILE = 6; // cards parked at centre before the bottom one is recycled
const POOL = DECK + PILE;

/* Smallest card on top: slot 0 is the most reduced and every slot below it
   steps back up, so the card about to be dealt is the small one. Slots differ
   by scale ONLY — every card in the deck shares one centre, so each sits
   concentrically inside the one beneath it. */
const SCALE_STEP = 0.075;

const FLIGHT_MIN = 0.26;
const FLIGHT_MAX = 0.68;
// ms between deals -> seconds of flight. An unhurried hover gets FLIGHT_MAX,
// a fast sweep compresses toward FLIGHT_MIN so the cards keep up with the
// cursor.
const PACE = 2.2;

/* Flight easing. A real dealt card leaves the hand fast and is then slowed by
   friction, so the throw wants an `out` curve — but the three properties must
   not share one, or the motion reads as a rigid slide.

     x  power2.out  the throw itself; most of the distance goes early
     y  power1.out  lags x slightly, which bows the path into an arc instead
                    of a dead-straight line between the two points
     scale power1.out  the gentlest of the three. This is the one that used to
                    be on power3.out, where it hit ~60% growth in the first
                    quarter of the flight and read as the card popping to full
                    size the instant it left the deck.

   Ordering them slow-to-fast as scale < y < x is what gives the throw its
   sense of weight. */
const EASE_X = "power2.out";
const EASE_Y = "power1.out";
const EASE_SCALE = "power1.out";
const EASE_FLIP = "power2.inOut";
const SHIFT_EASE = "power2.out";

const DECK_Z = 50; // deck cards sit in their own band, below anything dealt

export function createDealer(player) {
  const stage = player?.querySelector(".mfa-player__stage");
  const anchor = player?.querySelector(".mfa-player__anchor");
  const seed = stage?.querySelector(".mfa-player__layer");

  if (!stage || !anchor || !seed) return { play() {} };

  const still = matchMedia("(prefers-reduced-motion: reduce)");

  const cards = [seed];
  for (let i = 1; i < POOL; i++) {
    const clone = seed.cloneNode(true);
    stage.appendChild(clone);
    cards.push(clone);
  }

  // pile[0] is the bottom of the centre stack (invisible, next to be recycled);
  // the last entry is the card on show. deck[0] is the card dealt next.
  const pile = cards.slice(0, PILE);
  const deck = cards.slice(PILE);

  let slots = []; // DECK + 1 entries; the extra one is the off-deck entry slot
  let awake = false; // graduated sizes while hovering, uniform at rest
  let z = 0;
  let last = 0;
  const flights = new Map(); // card -> its in-flight timeline

  const flipOf = (card) => card.querySelector(".mfa-player__flip");

  function setArt(card, src, alt) {
    const img = card.querySelector(".mfa-player__cover-img");
    if (!img) return;
    img.src = src;
    img.alt = alt || "";
  }

  /* Slot geometry, in the stage's own untransformed pixels. Both rects read
     here are layout-true: the stage and the anchor are never transformed, only
     the cards inside the stage are. The anchor is an invisible box whose only
     job is to let CSS own where the deck sits. */
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
        // same centre for every slot — the cards nest rather than fan
        x,
        y,
        // graduated, smallest at the top of the stack
        live: base * (1 - (DECK - 1 - i) * SCALE_STEP),
        // and a flat deck to fall back to when the strip isn't being hovered
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
      /* At rest the five cards sit exactly on top of each other, so five drop
         shadows land on the same pixels and compound into something far
         darker than one card should cast. Flat kills the drop shadow on all
         of them and gives it back to the top card alone. */
      card.classList.toggle("mfa-is-flat", !awake);
      card.classList.toggle("mfa-is-crown", !awake && i === 0);
      const vars = { ...slotVars(i), opacity: 1 };
      if (instant) gsap.set(card, vars);
      else gsap.to(card, { ...vars, duration: 0.42, ease: SHIFT_EASE, overwrite: true });
    });
  }

  /* The deck fans into its graduated sizes while the strip is being hovered
     and flattens back to one uniform size the moment the pointer leaves. */
  function setAwake(on) {
    if (on === awake) return;
    awake = on;
    settle(false);
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

    const card = deck.shift(); // the top of the deck
    const recycled = pile.shift(); // the buried bottom of the centre stack
    pile.push(card);
    deck.push(recycled);

    setArt(card, src, alt);
    // dealt cards live above the whole deck band and above each other
    card.style.zIndex = String(DECK_Z + 50 + ++z);
    // it has left the deck, so it carries its own full shadow again
    card.classList.remove("mfa-is-flat", "mfa-is-crown");

    if (still.matches) {
      gsap.set(card, { x: 0, y: 0, scale: 1, opacity: 1 });
      gsap.set(flipOf(card), { rotateY: 0 });
      gsap.set(recycled, { ...slotVars(DECK), opacity: 1 });
      gsap.set(flipOf(recycled), { rotateY: 180 });
      settle(true);
      return;
    }

    // Match the throw to the hand: the quicker tiles are being crossed, the
    // quicker each card has to clear the deck.
    const now = performance.now();
    const gap = last ? now - last : Infinity;
    last = now;
    const dur = gsap.utils.clamp(FLIGHT_MIN, FLIGHT_MAX, (gap / 1000) * PACE);

    /* Cards have to land in the order they were dealt. Flight time tracks
       hover speed, and the first card of a sweep always gets the longest one
       (nothing preceded it, so its `gap` is huge) — so on a fast sweep an
       early card routinely lands after a later one and, having the lower
       z-index, slides in underneath the card already sitting on top.

       Rather than stretch this card's flight to land last — which would undo
       the speed matching — hurry along whatever is still in the air. Older
       cards visibly accelerate, which reads as the hand quickening, and every
       card still flies its own path. */
    const allowed = dur * 0.85;
    for (const t of flights.values()) {
      const left = t.duration() - t.time();
      if (left / t.timeScale() > allowed) t.timeScale(left / allowed);
    }

    const prior = flights.get(card);
    if (prior) prior.kill(); // a recycled card may still owe us a landing
    gsap.killTweensOf([card, flipOf(card)]);

    const tl = gsap.timeline({ onComplete: () => flights.delete(card) });
    flights.set(card, tl);

    // `.to()` on purpose — if this card was still sliding up a deck slot when
    // it got dealt, it departs from wherever it actually is.
    tl.to(card, { x: 0, duration: dur, ease: EASE_X }, 0)
      .to(card, { y: 0, duration: dur, ease: EASE_Y }, 0)
      .to(card, { scale: 1, duration: dur, ease: EASE_SCALE }, 0)
      .to(
        flipOf(card),
        // Finishes at ~0.82 of the flight, not past the end. The card lands
        // already face-up and just settles, rather than still turning over as
        // it arrives.
        { rotateY: 0, duration: dur * 0.7, ease: EASE_FLIP },
        dur * 0.12 // a beat on the deck before the reveal starts
      );

    // The replacement starts one slot below the deck, face-down and clear, and
    // fades up as it slides in — appearing at full opacity would pop.
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
        ease: SHIFT_EASE,
        overwrite: true, // retarget mid-shift instead of snapping
      });
    });
  }

  layout();
  window.addEventListener("resize", () => {
    // only the slot geometry changes; cards mid-flight keep their own tweens
    if (measure()) settle(false);
  });

  return { play, setAwake };
}
