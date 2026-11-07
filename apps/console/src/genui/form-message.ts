// How an applied form travels. The server API has no "apply form values" route (design/05-console.md), so the
// console sends the values to Velum as a human message and applies the proposal Velum answers with. The prefix lets
// the server and the fake recognise it; the values are JSON data in the message, never instructions.
export const FORM_PREFIX = "Apply these form values:";

export const formMessage = (values: Record<string, unknown>): string => `${FORM_PREFIX}\n${JSON.stringify(values)}`;
