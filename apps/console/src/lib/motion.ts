import { useEffect, useState, type RefObject } from "react";
import { usePrefersReducedMotion } from "./hooks.ts";

/** Decorative motion stops outside the viewport, in a hidden tab, or when the OS requests stills. */
export function useMotionAllowed(ref: RefObject<HTMLElement | null>, enabled = true): boolean {
  const reduced = usePrefersReducedMotion();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled || reduced) {
      setVisible(false);
      return;
    }
    let inView = false;
    const update = () => setVisible(inView && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? false;
      update();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [ref, enabled, reduced]);
  return enabled && !reduced && visible;
}
