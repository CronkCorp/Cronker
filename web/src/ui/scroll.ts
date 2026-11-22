/** Scrolls an element into view as the User asked for it: smoothly, unless they prefer reduced motion, to the middle. */
export function scrollIntoViewAsAsked(element: HTMLElement) {
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
}
