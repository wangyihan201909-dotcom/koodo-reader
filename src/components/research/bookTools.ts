import Book from "../../models/Book";
import HtmlBook from "../../models/HtmlBook";
import Note from "../../models/Note";
import { getIframeDoc } from "../../utils/reader/docUtil";
import DatabaseService from "../../utils/storage/databaseService";
import type { BookAgentContext, ResearchSource } from "./types";

const MAX_CHAPTER_CHARS = 12000;
const SURROUNDING_RADIUS = 1600;

export function stripHtmlTags(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function extractSurroundingText(
  fullText: string,
  selectionText?: string,
  radius = SURROUNDING_RADIUS
): string {
  const normalized = fullText.trim();
  if (!normalized) return "";
  const needle = (selectionText || "").trim();
  if (!needle) {
    return normalized.slice(0, radius * 2);
  }
  const index = normalized.indexOf(needle);
  if (index < 0) {
    return normalized.slice(0, radius * 2);
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(normalized.length, index + needle.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < normalized.length ? "…" : "";
  return `${prefix}${normalized.slice(start, end).trim()}${suffix}`;
}

function extractCleanDocumentText(doc: Document | null | undefined): string {
  if (!doc?.body) return "";
  try {
    const clone = doc.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script, style, rt, rp, noscript").forEach((el) => el.remove());
    const text = (clone.innerText || clone.textContent || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text;
  } catch {
    return (doc.body.textContent || "").trim();
  }
}

export function extractCurrentBookContext(
  book: Book | null | undefined,
  htmlBook: HtmlBook | null | undefined,
  selection?: ResearchSource
): BookAgentContext | null {
  if (!book?.key) return null;
  let position = selection?.position ?? null;
  let chapter = selection?.chapter ?? "";
  try {
    const rendition = htmlBook?.rendition;
    if (rendition?.getPosition) {
      const loc = rendition.getPosition();
      if (loc) {
        if (!position) position = JSON.stringify(loc);
        if (!chapter && typeof loc.chapterTitle === "string") {
          chapter = loc.chapterTitle;
        }
      }
    }
  } catch {
    // Ignore position extraction failure on unloaded views
  }

  let chapterText = "";
  try {
    const docs = getIframeDoc(book);
    const chunks: string[] = [];
    for (const doc of docs) {
      const text = extractCleanDocumentText(doc);
      if (text) chunks.push(text);
    }
    chapterText = chunks.join("\n\n").slice(0, MAX_CHAPTER_CHARS);
  } catch {
    chapterText = "";
  }

  const surroundingText = extractSurroundingText(
    chapterText,
    selection?.content,
    SURROUNDING_RADIUS
  );

  const tocSource = htmlBook?.flattenChapters?.length
    ? htmlBook.flattenChapters
    : htmlBook?.chapters || [];
  const toc = tocSource
    .map((item) => (typeof item?.label === "string" ? item.label.trim() : ""))
    .filter(Boolean)
    .slice(0, 80);

  return {
    bookKey: book.key,
    bookTitle: (book.name || selection?.title || "Current Book").slice(0, 300),
    chapter: chapter.slice(0, 1000),
    position,
    selection,
    surroundingText,
    chapterText,
    toc,
    canSearchBook: typeof htmlBook?.rendition?.doSearch === "function",
  };
}

interface SearchHit {
  excerpt?: unknown;
  cfi?: unknown;
}

interface ParsedLocation {
  chapterTitle?: unknown;
  chapterDocIndex?: unknown;
  chapterHref?: unknown;
  text?: unknown;
  count?: unknown;
  percentage?: unknown;
  cfi?: unknown;
  page?: unknown;
}

export async function executeBookToolCall(
  book: Book | null | undefined,
  htmlBook: HtmlBook | null | undefined,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (toolName === "search_current_book") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(12, Math.max(1, Math.floor(args.limit)))
        : 8;
    if (!query || !htmlBook?.rendition?.doSearch) {
      return { ok: false, error: "BOOK_SEARCH_UNAVAILABLE" };
    }
    try {
      const rawResults: SearchHit[] = (await htmlBook.rendition.doSearch(query)) || [];
      const seen = new Set<string>();
      const matches: { chapter: string; content: string; position: string | null }[] = [];
      for (const item of rawResults) {
        const excerpt =
          typeof item?.excerpt === "string" ? stripHtmlTags(item.excerpt) : "";
        if (!excerpt) continue;
        let chapter = "";
        let position: string | null = null;
        if (typeof item?.cfi === "string" && item.cfi.trim()) {
          position = item.cfi;
          try {
            const parsed = JSON.parse(item.cfi) as ParsedLocation;
            if (typeof parsed?.chapterTitle === "string") {
              chapter = parsed.chapterTitle.trim();
            }
          } catch {
            // Keep raw position string
          }
        }
        const dedupKey = `${chapter}|${excerpt.slice(0, 80)}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        matches.push({ chapter, content: excerpt.slice(0, 1500), position });
        if (matches.length >= limit) break;
      }
      return { ok: true, data: matches };
    } catch {
      return { ok: false, error: "BOOK_SEARCH_FAILED" };
    }
  }

  if (
    toolName === "get_book_highlights_and_notes" ||
    toolName === "search_reading_notes"
  ) {
    const bookKey =
      (typeof args.bookKey === "string" && args.bookKey.trim()) || book?.key || "";
    const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    try {
      const allNotes: Note[] = (await DatabaseService.getAllRecords("notes")) || [];
      const bookNames = new Map<string, string>();
      if (!bookKey) {
        const allBooks: Book[] = (await DatabaseService.getAllRecords("books")) || [];
        for (const item of allBooks) {
          if (item?.key && item?.name) bookNames.set(item.key, item.name);
        }
      }
      const matched = allNotes
        .filter((item) => item && (!bookKey || item.bookKey === bookKey))
        .filter((item) => {
          if (!query) return true;
          const title = bookNames.get(item.bookKey) || "";
          const tags = Array.isArray(item.tag) ? item.tag.join(" ") : "";
          const haystack = `${title} ${item.chapter || ""} ${item.text || ""} ${item.notes || ""} ${tags}`.toLowerCase();
          return haystack.includes(query);
        })
        .slice(0, 12)
        .map((item) => ({
          bookKey: item.bookKey,
          bookTitle: bookNames.get(item.bookKey) || book?.name || "",
          chapter: item.chapter || "",
          text: (item.text || "").slice(0, 1500),
          notes: (item.notes || "").slice(0, 1500),
          position: item.cfi || null,
        }));
      return { ok: true, data: matched };
    } catch {
      return { ok: false, error: "BOOK_NOTES_FAILED" };
    }
  }

  return { ok: false, error: "UNKNOWN_TOOL" };
}

export async function jumpToBookSource(
  htmlBook: HtmlBook | null | undefined,
  source: ResearchSource
): Promise<boolean> {
  if (!htmlBook?.rendition?.goToPosition || !source.position) {
    return false;
  }
  try {
    const parsed = JSON.parse(source.position) as ParsedLocation;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    await htmlBook.rendition.goToPosition(
      JSON.stringify({
        text: parsed.text,
        chapterTitle: parsed.chapterTitle,
        chapterDocIndex: parsed.chapterDocIndex,
        chapterHref: parsed.chapterHref,
        count: Object.prototype.hasOwnProperty.call(parsed, "cfi")
          ? "ignore"
          : parsed.count,
        percentage: parsed.percentage,
        cfi: parsed.cfi,
        page: parsed.page,
      })
    );
    return true;
  } catch {
    return false;
  }
}
