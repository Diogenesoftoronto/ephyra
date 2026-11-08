import type { KnowledgeCatalog, KnowledgeSelection } from "@ephyra/core";

/** Fictional account-granted sources, never fetched from a live account in stories. */
export const KNOWLEDGE_CATALOG_FIXTURE: KnowledgeCatalog = {
  status: "available",
  detail: "Fictional sources available to this application.",
  manageUrl: "https://id.example.org/connections?app=ephyra&returnTo=%2Fapp%2F%23%2Fsettings",
  authorizeUrl: "/auth/login?setup=1",
  sources: [
    {
      id: "fixture-docs", label: "Product documentation", resourcesAllowed: true,
      tools: [{ name: "search_documents", description: "Find relevant product documents.",
        definitionHash: "a".repeat(64), queryField: "query", unavailableReason: null }],
    },
    {
      id: "fixture-issues", label: "Issue history", resourcesAllowed: false,
      tools: [
        { name: "find_issues", description: "Search recorded issues.", definitionHash: "b".repeat(64), queryField: "text", unavailableReason: null },
        { name: "create_issue", description: "Create an issue.", definitionHash: "c".repeat(64), queryField: null,
          unavailableReason: "This tool is not available for automatic research." },
      ],
    },
  ],
};
export const KNOWLEDGE_SELECTION_FIXTURE: KnowledgeSelection[] = [{
  id: "fixture-docs", resources: true,
  searchTool: { name: "search_documents", definitionHash: "a".repeat(64), queryField: "query" },
}];
