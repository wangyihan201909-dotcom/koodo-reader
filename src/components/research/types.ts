export type RetrievalMode = "selection" | "fast" | "rerank" | "web";

export interface ResearchSource {
  kind: "book" | "sag" | "web" | "note";
  title: string;
  content: string;
  book_key?: string | null;
  note_id?: string | null;
  chapter?: string | null;
  position?: string | null;
  path?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  url?: string | null;
}

export interface SearchResult {
  sources: ResearchSource[];
  truncated: boolean;
}

export interface ResearchDraft extends SearchResult {
  id: string;
  title: string;
  question: string;
  markdown: string;
  concepts: string[];
}

export interface ResearchNote extends Omit<ResearchDraft, "truncated"> {
  topic_id: string | null;
  created_at: string;
}

export interface ResearchTopic {
  id: string;
  name: string;
}

export interface RelatedNote {
  id: string;
  title: string;
  reason: string;
}

export interface ResearchWorkspace {
  topics: ResearchTopic[];
  books: { book_key: string; title: string }[];
  notes: ResearchNote[];
  note_options: Pick<ResearchNote, "id" | "title" | "topic_id">[];
  links: {
    first_id: string;
    second_id: string;
    first_title: string;
    second_title: string;
    reason: string;
  }[];
}

export interface ResearchStatus {
  model: boolean;
  web: boolean;
  sag: boolean;
  sag_error: string | null;
  reranker: boolean;
  notes_path: string;
}

export interface BookAgentContext {
  bookKey: string;
  bookTitle: string;
  chapter?: string;
  position?: string | null;
  selection?: ResearchSource;
  surroundingText?: string;
  chapterText?: string;
  toc?: string[];
  canSearchBook: boolean;
}

export interface AgentToolStep {
  toolCallId: string;
  toolName: string;
  summary?: string;
  count?: number;
  status: "running" | "done" | "error";
  durationMs?: number;
}

export interface AgentSavedAnswer {
  id: string;
  title: string;
  question: string;
  markdown: string;
  concepts: string[];
  sources: ResearchSource[];
}

export interface AgentChatTurn {
  id: string;
  runId: string;
  question: string;
  markdown: string;
  thinking: string;
  steps: AgentToolStep[];
  sources: ResearchSource[];
  streaming: boolean;
  aborted?: boolean;
  error?: string;
  errorDetail?: string;
  answer?: AgentSavedAnswer | null;
  savedNoteId?: string;
}

export interface ResearchAgentCapabilities {
  sag: boolean;
  reranker: boolean;
  web: boolean;
  webEnabled: boolean;
}

export type ResearchAgentEvent =
  | { sessionId: string; runId: string; type: "run_start"; capabilities?: ResearchAgentCapabilities }
  | { sessionId: string; runId: string; type: "text_delta"; delta: string }
  | { sessionId: string; runId: string; type: "thinking_delta"; delta: string }
  | { sessionId: string; runId: string; type: "tool_start"; toolCallId: string; toolName: string; summary?: string }
  | { sessionId: string; runId: string; type: "tool_end"; toolCallId: string; toolName: string; summary?: string; count?: number; isError?: boolean; durationMs?: number }
  | { sessionId: string; runId: string; type: "sources"; sources: ResearchSource[] }
  | { sessionId: string; runId: string; type: "run_end"; aborted: boolean; answer: AgentSavedAnswer | null }
  | { sessionId: string; runId: string; type: "run_error"; error: string; detail?: string };

export interface RendererToolCall {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}
