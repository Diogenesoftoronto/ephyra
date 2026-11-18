import type { Meta, StoryObj } from "@storybook/react-vite";
import { DecisionRecord, EvidenceCoverage } from "./ReviewRecords.tsx";
import { DECISION_ARTEFACTS, EVIDENCE_ARTEFACTS } from "../fake/documents.ts";

const meta: Meta = { title: "Components/ReviewRecords" };
export default meta;
const [index, ...records] = EVIDENCE_ARTEFACTS;
const HITS = JSON.stringify([
  { source: "otel", title: "TotalMismatch in sumLineItems", snippet: "charged 4199 ≠ cart 4198 · 37 events", score: 0.97 },
  { source: "git", title: "8c1e0f2 show per-line discounts", snippet: "total.ts: round each line before summing", score: 0.91 },
]);

export const Sources: StoryObj = { render: () => <EvidenceCoverage index={index!.content} records={records} /> };
export const SourceRecordsNotLoaded: StoryObj = { render: () => <EvidenceCoverage index={index!.content} records={records.slice(0, 1)} /> };
export const PlainHitList: StoryObj = { render: () => <EvidenceCoverage index={HITS} records={[]} /> };
export const Unrecognized: StoryObj = { render: () => <EvidenceCoverage index={'{"note":"not an index"}'} records={[]} /> };
export const Decided: StoryObj = { render: () => <DecisionRecord content={DECISION_ARTEFACTS[0]!.content} /> };
export const StoppedWithoutDecision: StoryObj = { render: () => <DecisionRecord content={DECISION_ARTEFACTS[1]!.content} /> };
export const Narrow: StoryObj = {
  render: () => <div style={{ maxWidth: 340 }}><EvidenceCoverage index={index!.content} records={records} /></div>,
};
