// TEMPORARY LOCAL COPY of the console json-render catalog (design/05-console.md, "Velum and generative UI").
// The real catalog is built by packages/genui as `@ephyra/genui`. When that package lands, delete this file and
// change the one import in ./spec.ts and ./registry.tsx. Keep component and action names identical.
import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

export const RiskLevels = ["low", "medium", "high", "critical"] as const;
export const CheckpointModes = ["advisory", "blocking"] as const;
export const LandingModeNames = ["trail_ref", "devenv_live", "radicle_patch", "tangled_pull", "auto_land"] as const;

const label = z.string().min(1).max(80);
const hint = z.string().max(240).optional();

export const catalog = defineCatalog(schema, {
  components: {
    Section: {
      props: z.object({ title: label, description: z.string().max(400).optional() }),
      slots: ["default"],
      description: "A titled group of fields. Every field belongs inside a Section.",
    },
    TextField: {
      props: z.object({ label, value: z.string().max(400).nullable().optional(), placeholder: z.string().max(120).optional(), hint }),
      slots: [],
      description: "Single-line text, e.g. an area name. Bind value with $bindState.",
    },
    PathList: {
      props: z.object({ label, value: z.array(z.string().max(200)).max(40).nullable().optional(), hint }),
      slots: [],
      description: "A list of path globs such as src/billing/**. Bind value with $bindState.",
    },
    RiskSelect: {
      props: z.object({ label, value: z.enum(RiskLevels).nullable().optional(), hint }),
      slots: [],
      description: "Risk of an area: low, medium, high or critical.",
    },
    CheckpointMatrix: {
      props: z.object({
        label, hint,
        value: z.object({ A: z.enum(CheckpointModes), B: z.enum(CheckpointModes), C: z.enum(CheckpointModes) }).nullable().optional(),
      }),
      slots: [],
      description: "Whether checkpoints A, B and C are advisory or blocking.",
    },
    LandingModes: {
      props: z.object({ label, value: z.array(z.enum(LandingModeNames)).max(5).nullable().optional(), hint }),
      slots: [],
      description: "Where an approved change may land. One or more of the five landing modes.",
    },
    Duration: {
      props: z.object({ label, value: z.number().int().min(60).max(2_592_000).nullable().optional(), hint }),
      slots: [],
      description: "A length of time in seconds, e.g. the watch window after landing.",
    },
    BudgetField: {
      props: z.object({ label, value: z.number().int().min(0).max(1_000_000_000_000).nullable().optional(), hint }),
      slots: [],
      description: "A spend limit in integer micro-USD (1000000 = $1). Shown to people in dollars.",
    },
    Toggle: {
      props: z.object({ label, value: z.boolean().nullable().optional(), hint }),
      slots: [],
      description: "An on/off switch, e.g. user_facing.",
    },
    Note: {
      props: z.object({ tone: z.enum(["info", "warn"]), text: z.string().min(1).max(400) }),
      slots: [],
      description: "A short plain-text explanation inside the form. Text only.",
    },
    DiffPreview: {
      props: z.object({ title: z.string().max(80).optional(), before: z.string().max(4000), after: z.string().max(4000) }),
      slots: [],
      description: "A read-only before/after of the text the form would change.",
    },
  },
  actions: {
    apply_to_draft: {
      params: z.object({}),
      description: "Send the form's current values to the draft. Values come from the form state, never from params.",
    },
    ask_velum: {
      params: z.object({ question: z.string().max(400).optional() }),
      description: "Ask Velum a follow-up about this form.",
    },
    discard: { params: z.object({}), description: "Close the form without changing the draft." },
  },
});

export type LocalCatalog = typeof catalog;
export const COMPONENT_NAMES = catalog.componentNames;
export const ACTION_NAMES = catalog.actionNames;
