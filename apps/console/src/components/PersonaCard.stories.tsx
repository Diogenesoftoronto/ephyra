import type { Meta, StoryObj } from "@storybook/react-vite";
import { PersonaCard } from "./PersonaCard.tsx";
import { PERSONAS } from "@ephyra/core";
import { activity, usage7 } from "../storybook/data.ts";
const meta: Meta = { title: "Components/PersonaCard" };
export default meta;
export const Default: StoryObj = {
  render: () => (
    <PersonaCard
      persona={PERSONAS[0]!}
      recent={activity.filter((a) => a.persona === "rho")}
      totals={usage7.byPersona.find((g) => g.key === "rho")?.totals}
    />
  ),
};
