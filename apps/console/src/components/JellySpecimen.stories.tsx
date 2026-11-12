import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { Button } from "../kit.ts";
import { useMotionAllowed } from "../lib/motion.ts";
import { usePrefersReducedMotion } from "../lib/hooks.ts";
import { JellySpecimen } from "./JellySpecimen.tsx";

const meta = { title: "Motion/JellySpecimen", component: JellySpecimen } satisfies Meta<typeof JellySpecimen>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = { args: { size: 192 } };
export const Dark: Story = { args: { size: 192 }, parameters: { theme: "dark" } };
export const Small: Story = { args: { size: 80 } };
export const CustomArtwork: Story = { args: { size: 192, src: "/app/personas/velum.webp" } };
export const CustomArtworkDark: Story = { args: { size: 192, src: "/app/personas/velum.webp" }, parameters: { theme: "dark" } };
export const MissingArt: Story = { args: { size: 112, src: "/missing-specimen.webp" } };
export const Keyboard: Story = {
  render: () => (
    <div className="stack">
      <p>Tab to the specimen. Enter or Space replays its ripple.</p>
      <JellySpecimen />
    </div>
  ),
};

function Exports() {
  const ref = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const reduced = usePrefersReducedMotion();
  const allowed = useMotionAllowed(ref, playing);
  return (
    <div ref={ref} className="stack">
      <div>
        <Button disabled={reduced} onClick={() => setPlaying(!playing)}>
          {playing ? "Pause loops" : "Play loops"}
        </Button>
      </div>
      {reduced && <p>Showing stills to follow your reduced-motion preference.</p>}
      <div className="cluster">
        {[
          { id: "ephyra-specimen-v1", name: "Ephyra specimen", still: "/app/motion/ephyra-specimen-v2.png" },
          { id: "velum-refraction-v1", name: "Velum", still: "/app/personas/velum.webp" },
        ].map((asset) => (
          <figure key={asset.id} style={{ margin: 0 }}>
            <img
              src={allowed ? `/app/motion/${asset.id}-loop.webp` : asset.still}
              alt={asset.name}
              width={160}
              height={160}
            />
            <figcaption>
              <a href={`/app/motion/${asset.id}.gif`} download>
                Download {asset.name} GIF
              </a>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
export const ShareableLoops: Story = { render: () => <Exports /> };
