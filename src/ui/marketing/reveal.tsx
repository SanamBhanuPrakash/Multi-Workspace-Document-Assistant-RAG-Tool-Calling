"use client";

import * as React from "react";

/**
 * Scroll-reveal that is VISIBLE BY DEFAULT.
 *
 * The server always renders fully visible markup, so nothing depends on JavaScript, hydration order, or the
 * `prefers-reduced-motion` value the server cannot know. After mount, and only when motion is allowed, elements that start
 * BELOW the fold are hidden and revealed by an IntersectionObserver. (A previous version rendered `opacity: 0` on the server
 * via an animation library and swapped to a plain element on the client for reduced-motion users; React does not repair
 * attribute mismatches in production, so those users saw a blank hero. Progressive enhancement avoids that whole class.)
 *
 * `eager` is for above-the-fold content: a pure-CSS entrance animation (see `.rise-in`), which reduced-motion CSS neutralises.
 */
export function Reveal({ children, delay = 0, className, eager = false }: { children: React.ReactNode; delay?: number; className?: string; eager?: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || eager || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return; // already on screen: leave it visible
    el.dataset.reveal = "hidden";
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          el.dataset.reveal = "shown";
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -60px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [eager]);

  return (
    <div ref={ref} className={[eager ? "rise-in" : "", className ?? ""].join(" ").trim() || undefined} style={{ ["--reveal-delay" as string]: `${delay}s`, ...(eager ? { animationDelay: `${delay}s` } : {}) }}>
      {children}
    </div>
  );
}
