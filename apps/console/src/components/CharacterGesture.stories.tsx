import type { Meta, StoryObj } from "@storybook/react-vite";
import { CharacterGesture } from "./CharacterGesture.tsx";
const meta = { title: "Motion/CharacterGesture", component: CharacterGesture, args: {
  poster: "/app/motion/ephyra-specimen-v1.webp", clip: "/app/juice/characters/ephyra.webm", label: "Greet Ephyra", size: 240,
} } satisfies Meta<typeof CharacterGesture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Dark: Story = { parameters: { theme: "dark" } };
export const MissingClip: Story = { args: { clip: "/unavailable.webm" } };
export const OpaqueDecoderFallback: Story = { args: { clip: "/app/juice/experiments/ephyra-h3-max.mp4" } };
export const AllCharacters: Story = { render: () => <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
  {["ephyra", "rho", "bell", "nema", "lappet", "turri", "velum"].map(persona => <CharacterGesture key={persona}
    poster={persona === "ephyra" ? "/app/motion/ephyra-specimen-v1.webp" : `/app/personas/${persona}.webp`}
    clip={`/app/juice/characters/${persona}.webm`} label={`Greet ${persona}`} size={160} />)}
</div> };
