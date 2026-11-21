import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/reader/docUtil", () => ({
  getIframeDoc: () => [],
}));

vi.mock("../../utils/storage/databaseService", () => ({
  default: {
    getAllRecords: vi.fn(async (db: string) => {
      if (db === "books") {
        return [{ key: "book-1", name: "無何有海上誌異" }];
      }
      if (db === "notes") {
        return [
          {
            key: "1700000000000",
            bookKey: "book-1",
            chapter: "代自序：洞與碎片",
            text: "天空恆常有一個洞",
            notes: "这里把洞和记忆联系在一起",
            cfi: JSON.stringify({ chapterDocIndex: 0 }),
            tag: ["隐喻"],
          },
        ];
      }
      return [];
    }),
  },
}));

import {
  executeBookToolCall,
  extractSurroundingText,
  stripHtmlTags,
} from "./bookTools";

describe("bookTools", () => {
  it("strips HTML highlight markup from book search excerpts", () => {
    expect(
      stripHtmlTags(
        '天空恆常有一個<span class="content-search-text">洞</span>，碎片&nbsp;與記憶。'
      )
    ).toBe("天空恆常有一個 洞 ，碎片 與記憶。");
  });

  it("extracts generous surrounding prose for a short selection", () => {
    const chapter =
      "前文鋪墊：海上的城邦與漂流的書卷。" +
      "天空恆常有一個洞，拼也不對，因此這些人給洞取了名字，叫做記憶。" +
      "海底恆常有一個洞，把粉碎骨還給粉碎骨，把碎片還給黑洞。";
    const surrounding = extractSurroundingText(chapter, "一個洞", 25);
    expect(surrounding).toContain("一個洞");
    expect(surrounding).toContain("記憶");
    expect(surrounding.length).toBeGreaterThan(20);
  });

  it("executes search_current_book against rendition.doSearch and preserves jump positions", async () => {
    const doSearch = vi.fn(async () => [
      {
        excerpt: "天空恆常有一個<b>洞</b>，叫做記憶。",
        cfi: JSON.stringify({
          chapterTitle: "代自序：洞與碎片",
          chapterDocIndex: 1,
          cfi: "/6/2",
        }),
      },
      {
        excerpt: "天空恆常有一個<b>洞</b>，叫做記憶。",
        cfi: JSON.stringify({
          chapterTitle: "代自序：洞與碎片",
          chapterDocIndex: 1,
          cfi: "/6/2",
        }),
      },
      {
        excerpt: "把碎片還給黑<b>洞</b>。",
        cfi: JSON.stringify({
          chapterTitle: "卷二",
          chapterDocIndex: 4,
          cfi: "/6/8",
        }),
      },
    ]);

    const result = await executeBookToolCall(
      { key: "book-1", name: "無何有海上誌異" } as never,
      { rendition: { doSearch } } as never,
      "search_current_book",
      { query: "洞", limit: 5 }
    );

    expect(result.ok).toBe(true);
    expect(doSearch).toHaveBeenCalledWith("洞");
    expect(result.data).toEqual([
      {
        chapter: "代自序：洞與碎片",
        content: "天空恆常有一個 洞 ，叫做記憶。",
        position: JSON.stringify({
          chapterTitle: "代自序：洞與碎片",
          chapterDocIndex: 1,
          cfi: "/6/2",
        }),
      },
      {
        chapter: "卷二",
        content: "把碎片還給黑 洞 。",
        position: JSON.stringify({
          chapterTitle: "卷二",
          chapterDocIndex: 4,
          cfi: "/6/8",
        }),
      },
    ]);
  });

  it("searches Koodo reading notes across all books via search_reading_notes", async () => {
    const result = await executeBookToolCall(null, null, "search_reading_notes", {
      query: "记忆",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      {
        bookKey: "book-1",
        bookTitle: "無何有海上誌異",
        chapter: "代自序：洞與碎片",
        text: "天空恆常有一個洞",
        notes: "这里把洞和记忆联系在一起",
        position: JSON.stringify({ chapterDocIndex: 0 }),
      },
    ]);
  });
});
