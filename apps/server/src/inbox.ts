import type { InboxItem, Trail } from "@ephyra/core";

export function boundMatches(item: InboxItem, trail: Trail, proofDigest?: string): boolean {
  return item.bound.rev === trail.rev && item.bound.head === trail.head && item.bound.proofDigest === proofDigest;
}
