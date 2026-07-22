import "./style.css";
import "./demo.css"; // showcase page styles only — do NOT copy into your project
import { initDock } from "./dock.js";

/* The component is a single non-scrolling screen, so the scaffold's smooth
   scrolling (Lenis + ScrollTrigger) had nothing to act on and SplitText was
   never used. GSAP is still here — deal.js imports it directly for the deal. */

initDock(document.querySelector(".mfa-player__track-list"));
