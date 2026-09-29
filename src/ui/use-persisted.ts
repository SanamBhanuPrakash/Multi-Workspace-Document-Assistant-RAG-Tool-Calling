"use client";

import * as React from "react";

/**
 * localStorage-backed values via useSyncExternalStore: the server (and first hydration pass) render the fallback, the client
 * then reads storage — no hydration mismatch and no setState-in-effect. Storage may be unavailable (private mode, blocked):
 * every access is guarded and the app simply doesn't persist.
 */
const listeners = new Map<string, Set<() => void>>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function usePersisted(key: string, fallback = ""): [string, (v: string) => void] {
  const subscribe = React.useCallback(
    (cb: () => void) => {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(cb);
      const onStorage = (e: StorageEvent) => e.key === key && cb();
      window.addEventListener("storage", onStorage);
      return () => {
        set.delete(cb);
        window.removeEventListener("storage", onStorage);
      };
    },
    [key],
  );
  const value = React.useSyncExternalStore(subscribe, () => read(key) ?? fallback, () => fallback);
  const setValue = React.useCallback(
    (v: string) => {
      try {
        if (v) localStorage.setItem(key, v);
        else localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
      listeners.get(key)?.forEach((cb) => cb());
    },
    [key],
  );
  return [value, setValue];
}

/** Theme: the source of truth is <html data-theme> (set before paint by an inline script), falling back to the OS preference. */
export function useTheme(): { theme: "light" | "dark"; toggle: () => void } {
  const subscribe = React.useCallback((cb: () => void) => {
    const mo = new MutationObserver(cb);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", cb);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", cb);
    };
  }, []);
  const theme = React.useSyncExternalStore<"light" | "dark">(
    subscribe,
    () => {
      const attr = document.documentElement.dataset.theme;
      return attr === "light" || attr === "dark" ? attr : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    },
    () => "dark",
  );
  const toggle = React.useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("lattice-theme", next);
    } catch {
      /* the choice simply won't persist */
    }
  }, [theme]);
  return { theme, toggle };
}
