import type { KnowledgeSelection, KnowledgeSourceView, KnowledgeToolView } from "@ephyra/core";

export const eligibleKnowledgeTool = (tool: KnowledgeToolView) => tool.queryField !== null && tool.unavailableReason === null;
export const knowledgeToolKey = (tool: Pick<KnowledgeToolView, "name" | "definitionHash">) =>
  JSON.stringify([tool.name, tool.definitionHash]);

/** Names are not sufficient: changed definitions require a new explicit selection. */
export function unavailableSelection(selection: KnowledgeSelection, source: KnowledgeSourceView | undefined): string | null {
  if (!source) return "This saved source is no longer available to Ephyra. Remove it or restore access in Not Organic.";
  if (selection.resources && !source.resourcesAllowed) return "Saved resource access is no longer available. Remove it before saving.";
  if (selection.searchTool && !source.tools.some((tool) => eligibleKnowledgeTool(tool) &&
    tool.name === selection.searchTool!.name && tool.definitionHash === selection.searchTool!.definitionHash &&
    tool.queryField === selection.searchTool!.queryField)) {
    return "The saved search tool changed or is unavailable. Remove it or explicitly choose its current version.";
  }
  return null;
}

/** Never turn server/provider text into an executable link. Relative authorization paths stay on this app. */
export function knowledgeLink(value: string | undefined): string | null {
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || local) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
