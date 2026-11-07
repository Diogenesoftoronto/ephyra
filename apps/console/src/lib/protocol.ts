// How the console asks Velum to apply structured edits. The server API has no "apply these form values" or "save this
// map" route (design/05-console.md), so the console sends the values to Velum as a human message and applies the
// proposal Velum answers with. The prefix lets the server (and the fake) recognise the message; the JSON after it is
// data, never instructions. Unverified against the real server: see README.
import type { AreaSketch } from "@ephyra/core";

export const FORM_PREFIX = "Apply these form values:";
export const MAP_PREFIX = "Apply this application map:";

export const formMessage = (values: Record<string, unknown>): string => `${FORM_PREFIX}\n${JSON.stringify(values)}`;
export const mapMessage = (sketches: readonly AreaSketch[]): string => `${MAP_PREFIX}\n${JSON.stringify(sketches)}`;
