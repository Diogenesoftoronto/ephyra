// The json-render registry for the console, defined against the real catalog (`@ephyra/genui`). The three catalog actions call
// back into whoever hosts the form.
import { catalog } from "@ephyra/genui";
import { defineRegistry } from "@json-render/react";
import type { MutableRefObject } from "react";
import {
  BudgetFieldInput,
  CheckpointMatrixInput,
  DiffPreviewBlock,
  DurationInput,
  LandingModesInput,
  NoteText,
  PathListInput,
  RiskSelectInput,
  SectionField,
  TextFieldInput,
  ToggleInput,
} from "./fields.tsx";

/** What a form can ask of its host. These are the catalog's only three actions. */
export type FormHost = {
  /** Apply the form: `values` are the form's current values by path, `edited` says whether the person changed any. */
  apply: (values: Record<string, unknown>, edited: boolean) => Promise<void> | void;
  ask: (text?: string) => void;
  discard: () => void;
};

/** Passed to the actions through json-render's state argument, so the host reads the values of this form only. */
export type FormContext = { values: () => Record<string, unknown>; edited: () => boolean };

// `@ephyra/genui` types component props as a bare `z.ZodType`, so json-render hands them over as `unknown`. They are
// validated at runtime against that same catalog (`readSpec`) before anything renders, which is what makes this cast sound.
const as = <T,>(props: unknown): T => props as T;

export function createRegistry(
  host: MutableRefObject<FormHost>,
  form: MutableRefObject<FormContext>,
  disabled: boolean,
) {
  return defineRegistry(catalog, {
    components: {
      Section: ({ props, children }) => <SectionField props={as(props)}>{children}</SectionField>,
      TextField: ({ props }) => <TextFieldInput props={as(props)} disabled={disabled} />,
      PathList: ({ props }) => <PathListInput props={as(props)} disabled={disabled} />,
      RiskSelect: ({ props }) => <RiskSelectInput props={as(props)} disabled={disabled} />,
      CheckpointMatrix: ({ props }) => <CheckpointMatrixInput props={as(props)} disabled={disabled} />,
      LandingModes: ({ props }) => <LandingModesInput props={as(props)} disabled={disabled} />,
      Duration: ({ props }) => <DurationInput props={as(props)} disabled={disabled} />,
      BudgetField: ({ props }) => <BudgetFieldInput props={as(props)} disabled={disabled} />,
      Toggle: ({ props }) => <ToggleInput props={as(props)} disabled={disabled} />,
      Note: ({ props }) => <NoteText props={as(props)} />,
      DiffPreview: ({ props }) => <DiffPreviewBlock props={as(props)} />,
    },
    actions: {
      // The form's values come from its own state, never from action params.
      apply_to_draft: async () => {
        await host.current.apply(form.current.values(), form.current.edited());
      },
      ask_velum: async (params) => {
        host.current.ask(params?.text);
      },
      discard: async () => {
        host.current.discard();
      },
    },
  });
}
