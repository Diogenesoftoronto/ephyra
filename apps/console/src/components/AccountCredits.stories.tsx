import type { Meta, StoryObj } from "@storybook/react-vite";
import { FakeAccountApi } from "../fake/account.ts";
import { AccountCredits } from "./AccountCredits.tsx";

const meta: Meta<typeof AccountCredits> = {
  title: "Components/AccountCredits",
  component: AccountCredits,
};
export default meta;

export const Available: StoryObj<typeof AccountCredits> = {
  args: {
    api: Object.assign(new FakeAccountApi(), {
      wallet: async () => ({ availableMicros: 5_000_000 }),
    }),
  },
};

export const AwaitingConfirmation: StoryObj<typeof AccountCredits> = {
  args: {
    api: Object.assign(new FakeAccountApi(), {
      wallet: async () => ({
        availableMicros: 0,
        welcomeCredit: { awaitingEmailConfirmation: true },
      }),
    }),
  },
};
