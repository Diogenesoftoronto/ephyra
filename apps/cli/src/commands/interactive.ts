import * as p from "@clack/prompts";
import { clean, oneLine } from "../inbox/text";
import type { LoginIo } from "../login";

export class CliCancelledError extends Error {
  constructor(message = "Stopped here. Saved settings remain; any setup already started on the server continues.") {
    super(message);
    this.name = "CliCancelledError";
  }
}

export function canPrompt(json: boolean, input = process.stdin.isTTY, output = process.stdout.isTTY) {
  return !json && Boolean(input && output);
}

/** Remove signal listeners in every outcome, including a failed request or cancelled prompt. */
export async function withCliSignal<T>(run: (signal: AbortSignal) => Promise<T>, message = "Command cancelled."): Promise<T> {
  const controller = new AbortController();
  const stop = () => controller.abort(new CliCancelledError(message));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try { return await run(controller.signal); }
  finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export type Choice = { value: string; label: string; hint?: string };
export interface WizardUi {
  intro(message: string): void;
  outro(message: string): void;
  note(message: string, title: string): void;
  warn(message: string): void;
  text(message: string, initial?: string, validate?: (value: string) => string | undefined): Promise<string>;
  password(message: string): Promise<string>;
  select(message: string, options: Choice[]): Promise<string>;
  confirm(message: string, active: string, inactive: string): Promise<boolean>;
  work<T>(message: string, task: () => Promise<T>): Promise<T>;
}

export function loginPresentation(ui: WizardUi): Pick<LoginIo, "print" | "onEvent"> {
  return {
    print: () => {},
    onEvent(event) {
      if (event.type === "approval")
        ui.note(`${event.url}\n\nApprove only the browser request showing code ${event.code}.`, "Browser sign-in");
      if (event.type === "waiting") ui.note("Waiting for browser approval. Press Ctrl+C to cancel.", "Sign in");
      if (event.type === "browser_unavailable") ui.warn("Open the sign-in link above in your browser to continue.");
      if (event.type === "signed_in")
        ui.note(`${event.handle ?? event.did}${event.approver ? "" : " (read-only on this server)"}\nSaved to ${event.credentialsPath}.`, "Signed in");
    },
  };
}

export function clackUi(signal: AbortSignal): WizardUi {
  const opts = { signal, accessible: Boolean(process.env.NO_COLOR) };
  const answer = <T>(value: T | symbol): T => {
    if (p.isCancel(value)) throw new CliCancelledError();
    signal.throwIfAborted();
    return value as T;
  };
  return {
    intro: message => p.intro(clean(message), opts),
    outro: message => p.outro(clean(message), opts),
    note: (message, title) => p.note(clean(message), oneLine(title), opts),
    warn: message => p.log.warn(clean(message), opts),
    text: async (message, initial, validate) => answer<string>(await p.text({
      ...opts, message, ...(initial ? { initialValue: initial } : {}),
      validate: value => validate?.(value ?? ""),
    })),
    password: async message => answer<string>(await p.password({ ...opts, message })),
    select: async (message, options) => answer<string>(await p.select({ ...opts, message, options })),
    confirm: async (message, active, inactive) => answer<boolean>(await p.confirm({ ...opts, message, active, inactive })),
    async work(message, task) {
      signal.throwIfAborted();
      const spinner = p.spinner({ ...opts, cancelMessage: "Stopped waiting for the server." });
      spinner.start(message);
      try {
        const result = await task();
        signal.throwIfAborted();
        spinner.stop(message.replace(/…$/, ""));
        return result;
      } catch (error) {
        if (signal.aborted) spinner.cancel("Stopped waiting for the server.");
        else spinner.error("Could not confirm this step.");
        throw error;
      }
    },
  };
}
