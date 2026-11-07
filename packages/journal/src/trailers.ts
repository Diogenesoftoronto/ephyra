import { must } from "./git.ts";
export function formatTrailers(input: {
  trail: string;
  proofDigest: string;
  entireCheckpoints?: string[];
}) {
  return [
    `Ephyra-Trail: ${input.trail}`,
    `Ephyra-Proof: ${input.proofDigest}`,
    ...(input.entireCheckpoints ?? []).map((x) => `Entire-Checkpoint: ${x}`),
  ].join("\n");
}
export async function parseTrailers(message: string) {
  const r = await must(["interpret-trailers", "--parse"], { input: message });
  return r.text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(":");
      return { key: line.slice(0, i), value: line.slice(i + 1).trim() };
    });
}
