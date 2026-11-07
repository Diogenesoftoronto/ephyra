import { expect, test } from "bun:test";
import { cliApprovalView, signInFailedView, signedInView } from "./views.ts";

test("sign-in views escape account and form values while preserving the approval form", () => {
  const html = cliApprovalView({ who: '<img src=x onerror="alert(1)">', approver: false,
    code: "A&B", challenge: '" autofocus', csrf: "<token>" });
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  expect(html).toContain('name="challenge" value="&quot; autofocus"');
  expect(html).toContain('name="csrf" value="&lt;token&gt;"');
  expect(html).toContain('method="post" action="/auth/cli/approve"');
  expect(html).toContain("not on this deployment's approver list");
  expect(signedInView("alex", true)).toContain("can approve trail checkpoints");
  expect(signInFailedView("<unsafe>")).toContain("&lt;unsafe&gt;");
});
