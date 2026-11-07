import { Unverified, type AgentResult, type CodingAgent } from "@ephyra/core";

export class MockAgent implements CodingAgent {
  readonly name = "mock";
  constructor(private readonly results: AgentResult[]) {}
  async run(): Promise<AgentResult> { const result = this.results.shift(); if (!result) throw new Unverified("mock agent script exhausted"); return result; }
}
