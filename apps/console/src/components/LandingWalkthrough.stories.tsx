import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { LandingWalkthrough, WalkthroughWorkspace } from "./LandingWalkthrough.tsx";
import { makeEvents, makeTrails, STORY_NOW } from "../fake/fixtures.ts";
import type { WalkthroughSelection } from "../lib/landing-walkthrough.ts";

const meta: Meta = { title: "Landing/Embedded console" };
export default meta;
export const WaitingForParent: StoryObj = { render: () => <LandingWalkthrough parentOrigin="https://ephyra.quest" /> };
export const InvalidParent: StoryObj = { render: () => <LandingWalkthrough parentOrigin={null} /> };
const trail = makeTrails(STORY_NOW)[0]!;
const selection: WalkthroughSelection = { key: "storybook-real-console", step: "hypothesis",
  detail: { trail, events: makeEvents(trail, STORY_NOW), artefacts: [
    { path: "hypothesis.md", content: "Fictional sample: repeated coupon application changes the checkout total." },
  ] } };
function Example() {
  useEffect(() => {
    const previous = location.hash;
    location.hash = `#/inbox/${trail.id}`;
    return () => { location.hash = previous; };
  }, []);
  return <div className="landing-walkthrough"><WalkthroughWorkspace selection={selection} /></div>;
}
export const RealConsole: StoryObj = { render: () => <Example /> };
export const Phone: StoryObj = { ...RealConsole, globals: { viewport: { value: "phone" } } };
export const Dark: StoryObj = { ...RealConsole, parameters: { theme: "dark" } };
