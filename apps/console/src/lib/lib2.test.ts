import { describe, expect, test } from "bun:test";
import { ApiError, UnknownWriteOutcome } from "../api.ts";
import { describeError } from "./errors.ts";

describe("describeError", () => {
  test("each status has a plain-language answer and nothing leaks", () => {
    expect(describeError(new ApiError(409)).kind).toBe("stale");
    expect(describeError(new ApiError(403, "not an approver")).body).toBe("not an approver");
    expect(describeError(new ApiError(503, "Unverified: no model")).body).toContain("Unverified");
    expect(describeError(new ApiError(500)).kind).toBe("other");
    expect(describeError(new UnknownWriteOutcome("op")).kind).toBe("unknown-outcome");
    expect(describeError("string").body).toBe("Unknown error.");
  });
});
