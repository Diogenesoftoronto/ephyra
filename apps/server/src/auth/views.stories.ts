/// <reference lib="dom" />
import type { Meta, StoryObj } from "@storybook/html-vite";
import { cliApprovalView, cliApprovedView, cliExpiredView, signedInView, signInFailedView } from "./views.ts";

// Render the exact server document in an isolated frame. Sandbox prevents the fixture form
// from submitting to a real server, while preserving the original document's styles and focus.
function documentPreview(document: string): HTMLIFrameElement {
  const frame = window.document.createElement("iframe");
  frame.title = "Sign-in page preview (example data)";
  frame.setAttribute("sandbox", "");
  frame.srcdoc = document;
  frame.style.cssText = "border:0;width:100%;min-height:80vh";
  return frame;
}

const meta = {
  title: "Application / Sign-in pages",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const account = "alex.example";
const approval = { who: account, code: "ABCD-EFGH", challenge: "example-challenge", csrf: "example-token" };

export const TerminalApproval: Story = {
  name: "Terminal approval · approver",
  render: () => documentPreview(cliApprovalView({ ...approval, approver: true })),
};
export const TerminalApprovalReadOnly: Story = {
  name: "Terminal approval · read-only account",
  render: () => documentPreview(cliApprovalView({ ...approval, approver: false })),
};
export const BrowserSignedIn: Story = { name: "Signed in · approver", render: () => documentPreview(signedInView(account, true)) };
export const BrowserSignedInReadOnly: Story = { name: "Signed in · read-only account", render: () => documentPreview(signedInView(account, false)) };
export const Approved: Story = { render: () => documentPreview(cliApprovedView()) };
export const Expired: Story = { render: () => documentPreview(cliExpiredView()) };
export const SignInFailed: Story = { name: "Sign-in failed", render: () => documentPreview(signInFailedView("Sign-in could not be verified. Start again.")) };
