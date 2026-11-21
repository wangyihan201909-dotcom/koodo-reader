import { getConfiguredResearchModel } from "./modelConfig";
import type {
  BookAgentContext,
  RelatedNote,
  RendererToolCall,
  ResearchAgentEvent,
  ResearchDraft,
  ResearchNote,
  ResearchStatus,
  ResearchTopic,
  ResearchWorkspace,
  SearchResult,
} from "./types";

interface Operations {
  status: ResearchStatus;
  workspace: ResearchWorkspace;
  search: SearchResult;
  "search-notes": { notes: ResearchNote[] };
  ask: ResearchDraft;
  topic: ResearchTopic;
  "topic-book": { ok: boolean };
  note: ResearchNote;
  "edit-note": ResearchNote;
  suggest: RelatedNote[];
  link: { ok: boolean };
}

const MODEL_OPERATIONS = new Set<keyof Operations>(["status", "ask", "suggest"]);

export async function researchRequest<K extends keyof Operations>(
  operation: K,
  payload: object = {}
): Promise<Operations[K]> {
  if (!window.electronAPI) throw new Error("RESEARCH_DESKTOP_ONLY");
  let body: object = payload;
  if (
    MODEL_OPERATIONS.has(operation) &&
    !(
      "answer_model" in payload &&
      (payload as { answer_model?: unknown }).answer_model !== undefined
    )
  ) {
    const configuredModel = getConfiguredResearchModel();
    if (configuredModel) {
      body = { ...payload, answer_model: configuredModel };
    }
  }
  const response = await window.electronAPI.invoke<
    { data: Operations[K] } | { error: string }
  >("research-agent", operation, body);
  if ("error" in response) throw new Error(response.error);
  return response.data;
}

export async function startResearchChat(params: {
  sessionId: string;
  prompt: string;
  language: "zh" | "en";
  allowWeb: boolean;
  bookContext?: BookAgentContext | null;
}): Promise<{ runId: string }> {
  if (!window.electronAPI) throw new Error("RESEARCH_DESKTOP_ONLY");
  const answerModel = getConfiguredResearchModel();
  const response = await window.electronAPI.invoke<
    { ok: true; runId: string } | { error: string }
  >("research-agent-chat", {
    ...params,
    answerModel: answerModel ?? undefined,
  });
  if ("error" in response) throw new Error(response.error);
  return { runId: response.runId };
}

export async function abortResearchChat(sessionId: string): Promise<void> {
  if (!window.electronAPI) return;
  await window.electronAPI.invoke("research-agent-abort", { sessionId });
}

export async function resetResearchChat(sessionId: string): Promise<void> {
  if (!window.electronAPI) return;
  await window.electronAPI.invoke("research-agent-reset", { sessionId });
}

export function subscribeResearchAgentEvents(
  listener: (event: ResearchAgentEvent) => void
): () => void {
  if (!window.electronAPI) return () => {};
  return window.electronAPI.on("research-agent-event", listener);
}

export function subscribeResearchToolCalls(
  listener: (call: RendererToolCall) => void
): () => void {
  if (!window.electronAPI) return () => {};
  return window.electronAPI.on("research-tool-call", listener);
}

export function sendResearchToolResult(payload: {
  callId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}): void {
  if (!window.electronAPI) return;
  window.electronAPI.send("research-tool-result", payload);
}

export function researchError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  return /^[A-Z_]+$/.test(code)
    ? `Research.errors.${code}`
    : "Research.errors.RESEARCH_UNAVAILABLE";
}
