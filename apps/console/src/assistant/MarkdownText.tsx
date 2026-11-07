import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type { ReactNode } from "react";
import { safeHref } from "../lib/format.ts";
import "./assistant.css";

// Message text is untrusted (agents quote logs and signals). Markdown is rendered without raw HTML, links must be
// http(s) and open in a new tab without a referrer, and images are never fetched (their alt text is shown instead).
const SafeLink = ({ href, children }: { href?: string; children?: ReactNode }) => {
  const ok = safeHref(href);
  return ok ? <a href={ok} target="_blank" rel="noopener noreferrer nofollow">{children}</a> : <span>{children}</span>;
};
const NoImage = ({ alt }: { alt?: string }) => <span className="muted">[image{alt ? `: ${alt}` : ""}]</span>;

/** The text part for every assistant-ui thread in the console. */
export function MarkdownText() {
  return <MarkdownTextPrimitive className="md" skipHtml smooth={false} components={{ a: SafeLink, img: NoImage }} />;
}
