import { expect, test } from "bun:test";
import fc from "fast-check";
import { repositoryBranding, repositoryLogoSources } from "../src/repository-branding.ts";

test("repository and organization logo keys preserve the forge and normalize GitHub addresses", () => {
  expect(repositoryBranding("https://github.com/Acme/Project.git/")).toEqual(repositoryBranding("https://github.com/acme/project"));
  expect(repositoryBranding("https://gitlab.com/acme/group/another.git").organization).toBe("org:gitlab.com/acme/group");
  expect(repositoryBranding("https://git.example/acme/another.git").organization).toBe("org:git.example/acme");
  expect(repositoryBranding("https://github.com.attacker.test/acme/project").github).toBeUndefined();
  expect(repositoryBranding("https://name:token@github.com/acme/project")).toEqual({});
  expect(repositoryBranding("https://app.radicle.xyz/nodes/node.example/rad:z123").repository)
    .toBe(repositoryBranding("rad:z123").repository!);
});

test("repository marks override detection and organization marks apply across repositories", () => {
  const logos = { "repo:github.com/acme/app": "custom-repo", "org:github.com/acme": "custom-org" };
  expect(repositoryLogoSources("https://github.com/Acme/app.git", logos, undefined, "detected")).toEqual([
    "custom-repo", "detected", "custom-org", "https://github.com/acme.png?size=64",
  ]);
  const sibling = repositoryLogoSources("https://github.com/Acme/another", logos);
  expect(sibling[0]).toBe("https://raw.githubusercontent.com/acme/another/HEAD/logo.svg");
  expect(sibling.slice(-2)).toEqual(["custom-org", "https://github.com/acme.png?size=64"]);
  expect(repositoryLogoSources("https://git.example/acme/app", logos)).toEqual([]);
});

test("repository logo keys agree across clone, browse and case variants on GitHub", () => {
  const slug = fc.stringMatching(/^[a-z][a-z0-9]{0,15}$/);
  fc.assert(fc.property(slug, slug, (owner, repo) => {
    const clone = repositoryBranding(`https://github.com/${owner.toUpperCase()}/${repo.toUpperCase()}.git`);
    expect(clone).toEqual(repositoryBranding(`https://github.com/${owner}/${repo}/`));
    expect(clone.organization).toBe(repositoryBranding(`https://github.com/${owner}/${repo}-sibling`).organization!);
    expect(clone.repository).not.toBe(repositoryBranding(`https://github.com/${owner}/${repo}-sibling`).repository!);
  }));
});
