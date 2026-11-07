import type { Meta, StoryObj } from "@storybook/react-vite";
import { DraftPage } from "../pages/DraftPage.tsx";
const meta: Meta = { title: "Components/VelumThread" };
export default meta;
export const ConversationAndForms: StoryObj = { render: () => <DraftPage draftId="d-1" /> };
