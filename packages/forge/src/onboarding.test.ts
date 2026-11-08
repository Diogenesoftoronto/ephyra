import { expect, test } from "bun:test";
import fc from "fast-check";
import { parseRepositoryAddress, radicleCloneArguments, RepositoryAddressError } from "./onboarding";

const rid = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
const owner = "did:plc:abcdefghijklmnopqrstuvwx";
const seed = "z6MkqNZS9QWvC4wbZ8Vz4hQZ1FzN8q4XGj2KGmK9qNgQ8VWt";

test("forge browser URLs preserve full repository namespaces", () => {
  expect(parseRepositoryAddress("https://github.com/team/project")).toMatchObject({ kind: "github", cloneUrl: "https://github.com/team/project.git" });
  expect(parseRepositoryAddress("https://gitlab.com/group/subgroup/project")).toMatchObject({ kind: "gitlab", cloneUrl: "https://gitlab.com/group/subgroup/project.git" });
  expect(parseRepositoryAddress("https://codeberg.org/team/project.git")).toMatchObject({ kind: "forgejo", cloneUrl: "https://codeberg.org/team/project.git" });
  expect(parseRepositoryAddress("https://forge.example.com/custom/project")).toMatchObject({ kind: "git", cloneUrl: "https://forge.example.com/custom/project" });
  expect(parseRepositoryAddress("https://tangled.org/alice.example.com/Project")).toMatchObject({
    kind: "tangled", owner: "alice.example.com", collection: "org.tangled.repo.declaration", recordKey: "project",
  });
  const uri = `at://${owner}/org.tangled.repo/3mexample`;
  expect(parseRepositoryAddress(uri)).toEqual({ kind: "tangled", source: uri, owner, collection: "org.tangled.repo", recordKey: "3mexample" });
});

test("Radicle addresses retain the exact RID and only a real NID can become a seed option", () => {
  expect(parseRepositoryAddress(rid)).toEqual({ kind: "radicle", source: rid, repositoryId: rid });
  expect(parseRepositoryAddress(`https://app.radicle.xyz/nodes/seed.radicle.garden/${rid}/tree`)).toMatchObject({ repositoryId: rid });
  expect(parseRepositoryAddress(`https://app.radicle.xyz/nodes/${seed}/${rid}`)).toMatchObject({ seed });
  expect(radicleCloneArguments(rid, "/isolated/repository.git", 10000, [seed])).toEqual([
    "clone", "--bare", "--no-confirm", "--timeout", "10s", "--seed", seed, "--", rid, "/isolated/repository.git",
  ]);
  expect(() => radicleCloneArguments(rid, "/safe", 1000, ["--config=evil"])).toThrow(RepositoryAddressError);
});

test("ambiguous namespaces, credential-bearing URLs and shell-like addresses are rejected", () => {
  for (const input of [
    "https://github.com/team/project/tree/main", "https://gitlab.com/a/b/-/tree/main", "https://tangled.org/a.example.com/repo/extra",
    "https://github.com/team/../other", "https://github.com/team/%2e%2e/other", "https://github.com/team%2fother/repo",
    "https://secret@github.com/team/repo", "https://github.com/team/repo?token=x", "https://github.com/team/repo#readme",
    "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5 --seed evil", "ext::sh -c evil", "file:///tmp/repo", "ssh://git@host/repo",
    `at://${owner}/sh.tangled.repo/3mexample`, `at://${owner}/org.tangled.repo.manifest/other`,
  ]) expect(() => parseRepositoryAddress(input)).toThrow(RepositoryAddressError);
});

test("generated GitLab group namespaces survive normalization without flattening", () => {
  const segment = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_-"), { minLength: 1, maxLength: 15 })
    .map((chars) => `r${chars.join("")}`);
  fc.assert(fc.property(fc.array(segment, { minLength: 2, maxLength: 6 }), (parts) => {
    const path = parts.join("/");
    expect(parseRepositoryAddress(`https://gitlab.com/${path}`)).toMatchObject({ cloneUrl: `https://gitlab.com/${path}.git` });
  }), { numRuns: 60 });
});
