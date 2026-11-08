// Stroke icons for the console, 24px grid, 1.6 stroke, currentColor. Drawn for this app; jelly-world motifs where it helps.
import type { SVGProps } from "react";

const paths: Record<string, string> = {
  overview: "M4 13a8 8 0 0 1 16 0M4 13h16M7 13v3.5M10.5 13v5.5M13.5 13v5.5M17 13v3.5",
  usage: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  inbox: "M3 13l2.5-7h13L21 13M3 13v5h18v-5M3 13h5l1.5 2.5h5L16 13h5",
  runs: "M5 4v16M5 6c4-2 6 2 10 0s4-1 4-1v8s-1 1-4 1-6-2-10 0",
  workspace: "M4 5h7v6H4zM13 5h7v14h-7zM4 13h7v6H4z",
  settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
  onboarding: "M5 12l5 5L20 6",
  personas:
    "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 19c.7-3 2.8-5 5.5-5s4.8 2 5.5 5M16 11a2.5 2.5 0 1 0 0-5M17.5 14c2 .4 3.4 2.2 4 5",
  copy: "M8 8h11v11H8zM5 15H4V4h11v1",
  check: "M5 12.5l4.5 4.5L19 7",
  sun: "M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19",
  moon: "M20.7 13.1A8.8 8.8 0 0 1 10.9 3.3a9 9 0 1 0 9.8 9.8Z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  undo: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  specimen:
    "M12 3c-1.6 3.6-3.8 5.4-7.4 6 2.4 2.8 2.9 5.4 1.6 9 3.5-1.1 5.9-.6 7.8 2.2 1.9-2.8 4.3-3.3 7.8-2.2-1.3-3.6-.8-6.2 1.6-9-3.6-.6-5.8-2.4-7.4-6z",
};
export type IconName = keyof typeof paths;
export function Icon({ name, ...rest }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={paths[name]} />
    </svg>
  );
}
