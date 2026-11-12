import * as p from "@clack/prompts";
import { styleText } from "node:util";
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
      const indicator = waitIndicator(message, opts.accessible);
      try {
        const result = await task();
        signal.throwIfAborted();
        indicator.end("done", message.replace(/…$/, ""));
        return result;
      } catch (error) {
        if (signal.aborted) indicator.end("cancel", "Stopped waiting for the server.");
        else indicator.end("error", "Could not confirm this step.");
        throw error;
      }
    },
  };
}

type WaitInput = Pick<NodeJS.ReadStream, "isTTY" | "on" | "off" | "resume" | "pause"> & {
  isRaw?: boolean; setRawMode?(mode: boolean): unknown;
};
type WaitOutput = Pick<NodeJS.WriteStream, "isTTY" | "write">;

/**
 * Show that a request is in flight. Clack's animated spinner reads raw input and calls process.exit(0) on Ctrl+C,
 * which skips abort handling, unknown-write classification and the exit code. Here a literal Ctrl+C byte is
 * re-raised as SIGINT, so withCliSignal decides the outcome exactly as it does for a signal from the terminal.
 */
export function waitIndicator(message: string, accessible: boolean, input: WaitInput = process.stdin,
  output: WaitOutput = process.stdout, interrupt: () => void = () => process.kill(process.pid, "SIGINT")) {
  const text = oneLine(message).replace(/…$/, "");
  const animate = !accessible && Boolean(output.isTTY);
  const frames = ["◒", "◐", "◓", "◑"];
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const wasRaw = input.isRaw;
  const raw = Boolean(input.isTTY && input.setRawMode);
  const onData = (chunk: Buffer | string) => {
    if ((typeof chunk === "string" ? chunk : chunk.toString("latin1")).includes("\x03")) interrupt();
  };
  const restore = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (raw) {
      input.off("data", onData);
      input.setRawMode!(Boolean(wasRaw));
      input.pause();
    }
    if (animate) output.write("\r\x1b[2K\x1b[?25h");
    process.off("exit", restore);
  };
  // Raw mode keeps typed keys from echoing over the animation; restore it even if something exits the process.
  if (raw) {
    input.setRawMode!(true);
    input.on("data", onData);
    input.resume();
  }
  process.on("exit", restore);
  if (animate) {
    output.write(`${styleText("gray", p.S_BAR)}\n\x1b[?25l`);
    const draw = () => output.write(`\r\x1b[2K${styleText("magenta", frames[frame++ % frames.length]!)}  ${text}…`);
    draw();
    timer = setInterval(draw, 80);
  } else output.write(`${text}…\n`);
  let ended = false;
  return {
    end(outcome: "done" | "cancel" | "error", final: string) {
      if (ended) return;
      ended = true;
      restore();
      const mark = outcome === "done" ? styleText("green", p.S_STEP_SUBMIT)
        : outcome === "cancel" ? styleText("red", p.S_STEP_CANCEL) : styleText("red", p.S_STEP_ERROR);
      output.write(animate ? `${mark}  ${oneLine(final)}\n` : `${oneLine(final)}\n`);
    },
  };
}
