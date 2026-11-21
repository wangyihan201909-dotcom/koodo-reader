import { useMemo, type MouseEvent } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { openExternalUrl } from "../../utils/common";

export default function ResearchMarkdown({
  content,
  className = "research-markdown",
}: {
  content: string;
  className?: string;
}) {
  const html = useMemo(() => {
    const rendered = marked.parse(content || "", {
      async: false,
      gfm: true,
      breaks: true,
    });
    const rawHtml = typeof rendered === "string" ? rendered : "";
    return DOMPurify.sanitize(rawHtml, {
      ALLOWED_URI_REGEXP: /^https?:\/\//i,
    });
  }, [content]);

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement | null;
    const link = target?.closest("a");
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) {
      openExternalUrl(href);
    }
  }

  return (
    <div
      className={className}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
