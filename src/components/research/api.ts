import type {
  RelatedNote, ResearchDraft, ResearchNote, ResearchStatus, ResearchTopic,
  ResearchWorkspace, SearchResult,
} from "./types";

interface Operations {
  status: ResearchStatus;
  workspace: ResearchWorkspace;
  search: SearchResult;
  ask: ResearchDraft;
  topic: ResearchTopic;
  "topic-book": { ok: boolean };
  note: ResearchNote;
  suggest: RelatedNote[];
  link: { ok: boolean };
}

export async function researchRequest<K extends keyof Operations>(
  operation: K,
  payload: object = {}
): Promise<Operations[K]> {
  if (!window.electronAPI) throw new Error("RESEARCH_DESKTOP_ONLY");
  const response = await window.electronAPI.invoke<
    { data: Operations[K] } | { error: string }
  >("research-agent", operation, payload);
  if ("error" in response) throw new Error(response.error);
  return response.data;
}

export function researchError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  return /^[A-Z_]+$/.test(code) ? `Research.errors.${code}` : "Research.errors.RESEARCH_UNAVAILABLE";
}
