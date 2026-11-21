export type RetrievalMode = "selection" | "fast" | "rerank" | "web";

export interface ResearchSource {
  kind: "book" | "sag" | "web";
  title: string;
  content: string;
  book_key?: string | null;
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
