// The json-render registry for the console, defined against the (temporary) local catalog.
// Components come from ./fields.tsx; the three catalog actions call back into whoever hosts the form.
import { defineRegistry } from "@json-render/react";
import type { MutableRefObject } from "react";
import { catalog } from "./catalog.local.ts";
import {
  BudgetFieldInput, CheckpointMatrixInput, DiffPreviewBlock, DurationInput, LandingModesInput, NoteText, PathListInput, RiskSelectInput,
  SectionField, TextFieldInput, ToggleInput,
} from "./fields.tsx";
import type { FormState } from "./spec.ts";

/** What a form can ask of its host. These are the catalog's only three actions. */
export type FormHost = {
  apply: (values: FormState) => Promise<void> | void;
  ask: (question?: string) => void;
  discard: () => void;
};

export function createRegistry(host: MutableRefObject<FormHost>) {
  return defineRegistry(catalog, {
    components: {
      Section: ({ props, children }) => <SectionField props={props}>{children}</SectionField>,
      TextField: ({ props, bindings }) => <TextFieldInput props={props} bindings={bindings} />,
      PathList: ({ props, bindings }) => <PathListInput props={props} bindings={bindings} />,
      RiskSelect: ({ props, bindings }) => <RiskSelectInput props={props} bindings={bindings} />,
      CheckpointMatrix: ({ props, bindings }) => <CheckpointMatrixInput props={props} bindings={bindings} />,
      LandingModes: ({ props, bindings }) => <LandingModesInput props={props} bindings={bindings} />,
      Duration: ({ props, bindings }) => <DurationInput props={props} bindings={bindings} />,
      BudgetField: ({ props, bindings }) => <BudgetFieldInput props={props} bindings={bindings} />,
      Toggle: ({ props, bindings }) => <ToggleInput props={props} bindings={bindings} />,
      Note: ({ props }) => <NoteText props={props} />,
      DiffPreview: ({ props }) => <DiffPreviewBlock props={props} />,
    },
    actions: {
      // The form's values come from its own state, never from action params.
      apply_to_draft: async (_params, _setState, state) => { await host.current.apply(state); },
      ask_velum: async (params) => { host.current.ask(params?.question); },
      discard: async () => { host.current.discard(); },
    },
  });
}
