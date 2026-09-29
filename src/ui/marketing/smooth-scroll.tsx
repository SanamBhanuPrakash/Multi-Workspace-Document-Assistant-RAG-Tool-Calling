"use client";

import Lenis from "lenis";
import * as React from "react";

/**
 * Lenis smooth scrolling for the MARKETING page only (the app's dense panes use native scroll for accessibility and
 * predictable keyboard behaviour). Disabled entirely for users who prefer reduced motion; in-page anchors keep working.
 */
export function SmoothScroll() {
  React.useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const lenis = new Lenis({ lerp: 0.09, smoothWheel: true, anchors: true });
    let raf = 0;
    const loop = (t: number) => {
      lenis.raf(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, []);
  return null;
}
