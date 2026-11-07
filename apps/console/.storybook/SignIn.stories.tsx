import type { Meta, StoryObj } from "@storybook/react-vite";
// Storybook-only adapter: preview the exact HTML served by the sign-in routes.
import {
  cliApprovalView,
  cliApprovedView,
  cliExpiredView,
  signedInView,
  signInFailedView,
} from "../../server/src/auth/views.ts";
const meta: Meta = { title: "Screens/Sign-in", parameters: { layout: "fullscreen" } };
export default meta;
const frame = (html: string) => (
  <iframe
    title="Sign-in preview, fictional account"
    sandbox=""
    srcDoc={html}
    style={{ border: 0, width: "100%", height: "85vh" }}
  />
);
export const Approval: StoryObj = {
  render: () =>
    frame(
      cliApprovalView({
        who: "alex.example",
        approver: true,
        code: "ABCD-EFGH",
        challenge: "example",
        csrf: "example",
      }),
    ),
};
export const ReadOnly: StoryObj = { render: () => frame(signedInView("alex.example", false)) };
export const Approved: StoryObj = { render: () => frame(cliApprovedView()) };
export const Expired: StoryObj = { render: () => frame(cliExpiredView()) };
export const Failed: StoryObj = { render: () => frame(signInFailedView("Sign-in could not be verified.")) };
