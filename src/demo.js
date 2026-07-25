// Showcase bootstrap — NOT part of the component. It loads the demo page shell
// and starts the component. In your own project you only need main.js:
//
//   import { initMfaCards } from "./main.js";
//   initMfaCards();                 // wire up every .mfa-cards on the page
//   // or initMfaCards(el, { gsap }) to target one root / share your gsap
//
import { initMfaCards } from "./main.js";
import "./demo.css";

initMfaCards();
