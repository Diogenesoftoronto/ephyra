import { describe, expect, test } from "bun:test";
import { parseRoute } from "./route.ts";

describe("parseRoute", () => {
  test("pages, ids and fallbacks", () => {
    expect(parseRoute("")).toEqual({ page: "overview" });
    expect(parseRoute("#/usage")).toEqual({ page: "usage" });
    expect(parseRoute("#/inbox/abc-1")).toEqual({ page: "inbox", id: "abc-1" });
    expect(parseRoute("#/workspace/d%2D1?x=1")).toEqual({ page: "workspace", id: "d-1" });
    expect(parseRoute("#/nope")).toEqual({ page: "not-found", path: "nope" });
    expect(parseRoute("#/inbox/a/b").page).toBe("not-found");
    expect(parseRoute("#/%E0%A4%A").page).toBe("not-found");
  });
});
