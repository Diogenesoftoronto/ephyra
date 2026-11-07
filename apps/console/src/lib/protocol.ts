// How the console asks Velum to apply edited form values. The server API has no "apply these form values" route
// (design/05-console.md; apps/server/src/http/console.ts), so when a person changes a form Velum sent, the console sends
// the values to Velum as a human message and applies the proposal Velum answers with. The prefix lets the server and the
// fake recognise the message; the JSON after it is data, never instructions. Unverified against a live model: see README.
export const FORM_PREFIX = "Apply these form values:";

export const formMessage = (values: Record<string, unknown>): string =>
  `${FORM_PREFIX}\n${JSON.stringify(values)}`;
