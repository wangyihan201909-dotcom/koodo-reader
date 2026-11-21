import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import piResearchModule from "./pi-research-agent";

interface PiResearchTestExports {
  createPiResearchManager: (overrides?: Record<string, unknown>) => {
    runChatTurn: (
      webContents: FakeWebContents,
      request: Record<string, unknown>
    ) => Promise<{ ok: true; runId: string } | { error: string }>;
    abortSession: (req: { sessionId: string }) => { ok: boolean };
    resetSession: (req: { sessionId: string }) => { ok: boolean };
    handleRendererToolResult: (payload: {
      callId: string;
      ok: boolean;
      data?: unknown;
      error?: string;
    }) => void;
    disposeAllSessions: () => void;
  };
  buildPiModel: (spec: {
    baseUrl: string;
    model: string;
    apiKey: string;
    providerId: string;
  }) => {
    id: string;
    api: string;
    provider: string;
    baseUrl: string;
    reasoning: boolean;
  };
  deriveAnswerMetadata: (
    markdown: string,
    question: string
  ) => { title: string; markdown: string; concepts: string[] };
  SourceRegistry: new () => {
    add: (src: Record<string, unknown>) => number | null;
    list: () => Record<string, unknown>[];
  };
}

const {
  createPiResearchManager,
  buildPiModel,
  deriveAnswerMetadata,
  SourceRegistry,
} = piResearchModule as unknown as PiResearchTestExports;

interface FakeWebContents {
  events: Record<string, unknown>[];
  send: (channel: string, payload: Record<string, unknown>) => void;
  once: (event: string, cb: () => void) => void;
  isDestroyed: () => boolean;
}

describe("pi-research-agent helpers", () => {
  it("builds Pi openai-completions model with DeepSeek provider detection", () => {
    const model = buildPiModel({
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKey: "sk-test",
      providerId: "deepseek",
    });
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("deepseek");
    expect(model.reasoning).toBe(false);

    const reasoner = buildPiModel({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-reasoner",
      apiKey: "sk-test",
      providerId: "",
    });
    expect(reasoner.provider).toBe("deepseek");
    expect(reasoner.reasoning).toBe(true);
  });

  it("extracts title and strips leaked think blocks cleanly", () => {
    const meta = deriveAnswerMetadata(
      "<think>internal notes</think>\n# 洞的隐喻分析\n\n正文内容 [1]。",
      "洞的隐喻是什么？"
    );
    expect(meta.title).toBe("洞的隐喻分析");
    expect(meta.markdown).toBe("# 洞的隐喻分析\n\n正文内容 [1]。");
  });

  it("maintains stable 1-based source numbering with deduplication", () => {
    const reg = new SourceRegistry();
    expect(
      reg.add({ kind: "web", title: "Wiki", url: "https://example.com/a", content: "A" })
    ).toBe(1);
    expect(
      reg.add({ kind: "web", title: "Wiki dup", url: "https://example.com/a", content: "A" })
    ).toBe(1);
    expect(
      reg.add({ kind: "note", note_id: "n1", title: "旧笔记", content: "B" })
    ).toBe(2);
    expect(reg.list()).toHaveLength(2);
  });
});

describe("createPiResearchManager end-to-end with real Pi Agent Core", () => {
  it("autonomously runs chapter + in-book search + knowledge tools and supports multi-turn follow-up", async () => {
    let llmCallIndex = 0;
    const receivedBodies: Record<string, unknown>[] = [];

    const mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >;
        receivedBodies.push(body);
        llmCallIndex += 1;

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const sendChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
          res.write(
            `data: ${JSON.stringify({
              id: `chatcmpl-${llmCallIndex}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "deepseek-chat",
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            })}\n\n`
          );
        };

        if (llmCallIndex === 1) {
          // Turn 1, Step 1: Agent autonomously calls read_current_chapter & search_current_book
          sendChunk({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_ch",
                type: "function",
                function: {
                  name: "read_current_chapter",
                  arguments: JSON.stringify({ section: "around_selection" }),
                },
              },
              {
                index: 1,
                id: "call_book",
                type: "function",
                function: {
                  name: "search_current_book",
                  arguments: JSON.stringify({ query: "洞", limit: 4 }),
                },
              },
            ],
          });
          sendChunk({}, "tool_calls");
        } else if (llmCallIndex === 2) {
          // Turn 1, Step 2: Agent synthesizes answer citing [1], [2], [3]
          sendChunk({ role: "assistant", content: "# 洞的隐喻\n\n" });
          sendChunk({
            content: "结合当前章节 [2] 与全书检索 [3]，洞象征记忆与碎片。",
          });
          sendChunk({}, "stop");
        } else {
          // Turn 2: Follow-up question answered using prior conversation context
          sendChunk({ role: "assistant", content: "在追问中，“碎片”与“洞”形成互补 [3]。" });
          sendChunk({}, "stop");
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });

    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const port = (mockServer.address() as { port: number }).port;

    const runResearchOperation = vi.fn(async (op: string) => {
      if (op === "status") {
        return { data: { model: true, sag: false, reranker: false, web: false } };
      }
      if (op === "search-notes") {
        return { data: { notes: [] } };
      }
      return { data: { sources: [] } };
    });

    const manager = createPiResearchManager({
      runResearchOperation,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    const events: Record<string, unknown>[] = [];
    let resolveRunEnd: (() => void) | null = null;
    const webContents: FakeWebContents = {
      events,
      isDestroyed: () => false,
      once: () => {},
      send(channel, payload) {
        if (channel === "research-tool-call") {
          const call = payload as { callId: string; toolName: string };
          if (call.toolName === "search_current_book") {
            manager.handleRendererToolResult({
              callId: call.callId,
              ok: true,
              data: [
                {
                  chapter: "代自序：洞與碎片",
                  content: "把粉碎骨還給粉碎骨，把碎片還給黑洞。",
                  position: JSON.stringify({ chapterTitle: "代自序", chapterDocIndex: 0 }),
                },
              ],
            });
          }
          return;
        }
        if (channel === "research-agent-event") {
          events.push(payload);
          if (payload.type === "run_end" || payload.type === "run_error") {
            resolveRunEnd?.();
          }
        }
      },
    };

    try {
      const waitTurn1 = new Promise<void>((resolve) => {
        resolveRunEnd = resolve;
      });
      const turn1 = await manager.runChatTurn(webContents, {
        sessionId: "sess-1",
        prompt: "洞的隐喻是什么？",
        language: "zh",
        allowWeb: true,
        answerModel: {
          base_url: `http://127.0.0.1:${port}/v1`,
          model: "deepseek-chat",
          api_key: "sk-test",
          provider_id: "deepseek",
        },
        bookContext: {
          bookKey: "book-1",
          bookTitle: "無何有海上誌異",
          chapter: "代自序：洞與碎片",
          selection: {
            kind: "book",
            book_key: "book-1",
            title: "無何有海上誌異",
            chapter: "代自序：洞與碎片",
            content: "一個洞",
          },
          surroundingText: "天空恆常有一個洞，這些人給洞取了一個名字，叫做記憶。",
          chapterText: "天空恆常有一個洞，這些人給洞取了一個名字，叫做記憶。",
          canSearchBook: true,
        },
      });
      expect(turn1).toMatchObject({ ok: true });
      await waitTurn1;

      const toolStarts = events.filter((e) => e.type === "tool_start");
      expect(toolStarts.map((e) => e.toolName)).toEqual([
        "read_current_chapter",
        "search_current_book",
      ]);
      const turn1End = events.find((e) => e.type === "run_end") as {
        answer: { title: string; markdown: string; sources: unknown[] };
      };
      expect(turn1End.answer.title).toBe("洞的隐喻");
      expect(turn1End.answer.markdown).toContain("洞象征记忆与碎片");
      expect(turn1End.answer.sources.length).toBeGreaterThanOrEqual(3);

      // Turn 2: Multi-turn follow-up in the same session
      const waitTurn2 = new Promise<void>((resolve) => {
        resolveRunEnd = resolve;
      });
      const turn2 = await manager.runChatTurn(webContents, {
        sessionId: "sess-1",
        prompt: "再说说碎片和洞的关系",
        language: "zh",
        allowWeb: true,
        answerModel: {
          base_url: `http://127.0.0.1:${port}/v1`,
          model: "deepseek-chat",
          api_key: "sk-test",
          provider_id: "deepseek",
        },
      });
      expect(turn2).toMatchObject({ ok: true });
      await waitTurn2;

      const allEnds = events.filter((e) => e.type === "run_end") as {
        answer: { markdown: string };
      }[];
      expect(allEnds).toHaveLength(2);
      expect(allEnds[1].answer.markdown).toContain("互补");
      // Verify Turn 2 sent prior conversation messages to LLM
      expect((receivedBodies[2].messages as unknown[]).length).toBeGreaterThan(3);
    } finally {
      manager.disposeAllSessions();
      mockServer.close();
    }
  });
});
