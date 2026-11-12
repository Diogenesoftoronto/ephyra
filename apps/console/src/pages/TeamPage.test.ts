import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FakeTeamApi } from "../fake/team.ts";
import { TeamPage } from "./TeamPage.tsx";

test("members see the shared view without access tabs; the owner gets Now and Access as addressable tabs", () => {
  const member = renderToStaticMarkup(createElement(TeamPage, { tab: "access" }));
  expect(member).not.toContain("team-tabs");
  expect(member).not.toContain("Invite people");
  expect(member).toContain("Loading what the team is doing");

  const api = new FakeTeamApi();
  const now = renderToStaticMarkup(createElement(TeamPage, { api }));
  expect(now).toContain('href="#/team" aria-current="page"');
  expect(now).toContain('href="#/team/access"');
  expect(now).toContain("Loading what the team is doing");

  const access = renderToStaticMarkup(createElement(TeamPage, { api, tab: "access" }));
  expect(access).toContain('href="#/team/access" aria-current="page"');
  expect(access).toContain("Invite people to follow the work");
});
