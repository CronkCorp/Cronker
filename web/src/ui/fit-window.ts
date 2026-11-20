/**
 * A ref callback that keeps a sticky side panel within the window: at most the window's height below where its top
 * is now, less the gap it keeps from the window's top, so it scrolls on its own when it doesn't fit
 * (`.side-fits-window`). While it overflows it is marked `data-overflows`, so scrolling over it stays in it; a panel
 * that fits passes scrolling on to the page as before. Where it isn't sticky, as below 900px, it is left as tall as
 * its content.
 */
export function fitWindow(element: HTMLElement | null) {
  if (!element) return;
  let frame = 0;
  const fit = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const style = getComputedStyle(element);
      element.style.maxHeight =
        style.position === "sticky"
          ? `${Math.max(0, Math.floor(window.innerHeight - element.getBoundingClientRect().top - (parseFloat(style.top) || 0)))}px`
          : "";
      element.toggleAttribute("data-overflows", element.scrollHeight > element.clientHeight);
    });
  };
  // What sits above the panel can move its top, and its own groups can grow, shrink, come and go.
  const resized = new ResizeObserver(fit);
  const observeGroups = () => {
    resized.disconnect();
    resized.observe(document.documentElement);
    for (const group of element.children) resized.observe(group);
    fit();
  };
  const changed = new MutationObserver(observeGroups);
  changed.observe(element, { childList: true });
  observeGroups();
  window.addEventListener("scroll", fit, { passive: true });
  window.addEventListener("resize", fit);
  return () => {
    cancelAnimationFrame(frame);
    resized.disconnect();
    changed.disconnect();
    window.removeEventListener("scroll", fit);
    window.removeEventListener("resize", fit);
  };
}
