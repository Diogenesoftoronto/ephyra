import type { Meta, StoryObj } from "@storybook/react-vite";
import { SoundToggle } from "./SoundToggle.tsx";
import { playFeedback, type FeedbackSound } from "../lib/feedback.ts";
const meta = { title: "Motion/SoundToggle", component: SoundToggle } satisfies Meta<typeof SoundToggle>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
export const Cues: StoryObj<typeof meta> = { render: () => <div className="stack"><SoundToggle />
  <p>Sound studies. Playback is opt-in, one cue at a time.</p><div className="cluster">
    {(["touch", "copy", "connected", "invitation", "message", "attention"] as FeedbackSound[]).map(cue =>
      <button className="ui-button" key={cue} onClick={() => playFeedback(cue)}>{cue}</button>)}
  </div></div> };
