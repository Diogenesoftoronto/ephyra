import { test, expect } from "bun:test";
import { Trail, TrailEvent } from "@ephyra/core";
import sample from "./sample.json";
import original from "../../../../site/e/walkthrough.json";
test("the graphical tour preserves the CLI example and every recorded event", () => {
  expect(sample).toEqual(original.gui);
  for (const moment of Object.values(sample.moments)) {
    expect(Trail.safeParse(moment.trail).success).toBe(true);
    for (const event of moment.events) expect(TrailEvent.safeParse(event).success).toBe(true);
  }
});
