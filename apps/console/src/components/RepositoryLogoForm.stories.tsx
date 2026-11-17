import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { CONNECTED_ACCOUNT_FIXTURE, FakeAccountApi } from "../fake/account.ts";
import { RepositoryLogoForm } from "./RepositoryLogoForm.tsx";

const meta: Meta = { title: "Account/Repository and organization logos" };
export default meta;

function Fixture() {
  const [settings, onChange] = useState(CONNECTED_ACCOUNT_FIXTURE);
  const [api] = useState(() => new FakeAccountApi({ initial: CONNECTED_ACCOUNT_FIXTURE }));
  return <RepositoryLogoForm api={api} settings={settings} onChange={onChange} />;
}

export const OrganizationUpload: StoryObj = {
  render: () => <Fixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("Repository and organization logos"));
    await userEvent.selectOptions(canvas.getByLabelText("Apply logo to"), "organization");
    const image = document.createElement("canvas");
    image.width = image.height = 48;
    const paint = image.getContext("2d")!;
    paint.fillStyle = "#691c6a";
    paint.fillRect(8, 8, 32, 32);
    const blob = await new Promise<Blob | null>(resolve => image.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not create the fixture logo.");
    const fileInput = canvasElement.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(fileInput, new File([blob], "fixture.png", { type: "image/png" }));
    await expect(canvas.getByText("fixture.png")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Save logo" }));
    await expect(await canvas.findByText("Logo saved.")).toBeVisible();
  },
};
