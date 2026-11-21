import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";
import Book from "../../models/Book";
import Note from "../../models/Note";
import { useAppStore } from "../../store/useAppStore";
import BookUtil from "../../utils/file/bookUtil";
import DatabaseService from "../../utils/storage/databaseService";
import NoteContent from "../noteContent";
import {
  researchError,
  researchRequest,
  sendResearchToolResult,
  subscribeResearchToolCalls,
} from "./api";
import { executeBookToolCall } from "./bookTools";
import ResearchForm, { Sources } from "./component";
import ResearchMarkdown from "./markdown";
import type {
  RelatedNote,
  ResearchSource,
  ResearchStatus,
  ResearchWorkspace,
} from "./types";
import "./research.css";

const emptyWorkspace: ResearchWorkspace = {
  topics: [],
  books: [],
  notes: [],
  note_options: [],
  links: [],
};

function createUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function formatShortDate(iso: string) {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString();
}

function formatNoteTimestamp(key: string) {
  const ms = Number.parseInt(key, 10);
  if (Number.isFinite(ms) && ms > 0) {
    return new Date(ms).toLocaleDateString();
  }
  return "";
}

function notePlainPreview(note: Note): string {
  const raw = (note.notes || note.text || "").replace(/<[^>]+>/g, " ");
  return raw.replace(/\s+/g, " ").trim().slice(0, 120);
}

function isCssColor(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return /^#([0-9a-f]{3,8})$/i.test(trimmed) || /^rgba?\(/i.test(trimmed);
}

export default function ResearchWorkspacePage() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const id = useId();
  const books = useAppStore((state) => state.manager.books);
  const readingNotes = useAppStore((state) => state.reader.notes);
  const readingHighlights = useAppStore((state) => state.reader.highlights);
  const collapsed = useAppStore((state) => state.sidebar.isCollapsed);
  const handleFetchNotes = useAppStore((state) => state.handleFetchNotes);
  const handleNoteKey = useAppStore((state) => state.handleNoteKey);
  const handleShowPopupNote = useAppStore((state) => state.handleShowPopupNote);

  const isDesktop = Boolean(window.electronAPI);
  const [activeTab, setActiveTab] = useState<
    "notes" | "reading" | "highlights" | "chat"
  >(() => {
    if (location.pathname.endsWith("/highlight")) return "highlights";
    if (!isDesktop || location.pathname.endsWith("/note")) return "reading";
    return "notes";
  });
  const [topicId, setTopicId] = useState("");
  const [showNewTopic, setShowNewTopic] = useState(false);
  const [topicName, setTopicName] = useState("");
  const [bookKey, setBookKey] = useState("");
  const [libraryBooks, setLibraryBooks] = useState<Book[]>([]);
  const [noteId, setNoteId] = useState("");
  const [noteFilter, setNoteFilter] = useState("");
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [showManualLink, setShowManualLink] = useState(false);
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<ResearchStatus | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [suggestions, setSuggestions] = useState<RelatedNote[] | null>(null);

  // Integrated Reading Notes (Koodo annotations) state
  const [readingNoteKey, setReadingNoteKey] = useState("");
  const [readingFilter, setReadingFilter] = useState("");
  const [readingBookFilter, setReadingBookFilter] = useState("");
  const [readingTagFilter, setReadingTagFilter] = useState("");
  const [chatSeed, setChatSeed] = useState<{
    key: number;
    selection?: ResearchSource;
    initialPrompt?: string;
  }>({ key: 0 });

  useEffect(() => {
    handleFetchNotes();
  }, [handleFetchNotes]);

  useEffect(() => {
    if (location.pathname.endsWith("/highlight")) {
      setActiveTab("highlights");
    } else if (location.pathname.endsWith("/note")) {
      setActiveTab("reading");
    }
  }, [location.pathname]);

  useEffect(() => {
    if (!isDesktop) return;
    return subscribeResearchToolCalls((call) => {
      void executeBookToolCall(null, null, call.toolName, call.args || {}).then(
        (result) => {
          sendResearchToolResult({
            callId: call.callId,
            ok: result.ok,
            data: result.data,
            error: result.error,
          });
        }
      );
    });
  }, [isDesktop]);

  const bookNameByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const book of libraryBooks) {
      if (book?.key) map.set(book.key, book.name);
    }
    for (const book of books || []) {
      if (book?.key && !map.has(book.key)) map.set(book.key, book.name);
    }
    return map;
  }, [libraryBooks, books]);

  const filteredNotes = useMemo(() => {
    const q = noteFilter.trim().toLowerCase();
    if (!q) return workspace.notes;
    return workspace.notes.filter((item) => {
      const hay = `${item.title} ${item.question} ${item.markdown} ${item.concepts.join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }, [workspace.notes, noteFilter]);

  const note =
    workspace.notes.find((item) => item.id === noteId) ||
    filteredNotes[0] ||
    null;
  const effectiveNoteId = note?.id ?? "";
  const noteLinks = workspace.links.filter(
    (link) =>
      link.first_id === effectiveNoteId || link.second_id === effectiveNoteId
  );
  const linkedNoteIds = new Set(
    noteLinks.map((link) =>
      link.first_id === effectiveNoteId ? link.second_id : link.first_id
    )
  );
  const linkOptions = (workspace.note_options ?? workspace.notes).filter(
    (item) => item.id !== effectiveNoteId && !linkedNoteIds.has(item.id)
  );
  const topicNameById = useMemo(
    () => new Map(workspace.topics.map((topic) => [topic.id, topic.name])),
    [workspace.topics]
  );

  const isHighlightsTab = activeTab === "highlights";
  const isReadingCollectionTab =
    activeTab === "reading" || activeTab === "highlights";
  const activeReadingSource = isHighlightsTab ? readingHighlights : readingNotes;

  const readingNoteBooks = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of activeReadingSource) {
      if (item?.bookKey && !seen.has(item.bookKey)) {
        seen.set(item.bookKey, bookNameByKey.get(item.bookKey) || t("Unknown book"));
      }
    }
    return Array.from(seen.entries());
  }, [activeReadingSource, bookNameByKey, t]);

  const readingNoteTags = useMemo(() => {
    const set = new Set<string>();
    for (const item of activeReadingSource) {
      for (const tag of item?.tag || []) {
        if (tag && tag.trim()) set.add(tag.trim());
      }
    }
    return Array.from(set).sort();
  }, [activeReadingSource]);

  const filteredReadingNotes = useMemo(() => {
    const q = readingFilter.trim().toLowerCase();
    return activeReadingSource.filter((item) => {
      if (readingBookFilter && item.bookKey !== readingBookFilter) return false;
      if (readingTagFilter && !(item.tag || []).includes(readingTagFilter)) return false;
      if (!q) return true;
      const title = bookNameByKey.get(item.bookKey) || "";
      const hay = `${title} ${item.chapter || ""} ${item.text || ""} ${item.notes || ""} ${(item.tag || []).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }, [activeReadingSource, readingFilter, readingBookFilter, readingTagFilter, bookNameByKey]);

  const selectedReadingNote =
    filteredReadingNotes.find((item) => item.key === readingNoteKey) ||
    filteredReadingNotes[0] ||
    null;

  useEffect(() => {
    if (!books) return;
    let current = true;
    const activeBooks = new Set(books.map((book) => book.key));
    const loadBooks = async () => {
      const records: Book[] = await DatabaseService.getAllRecords("books");
      if (current) {
        setLibraryBooks(records.filter((book) => activeBooks.has(book.key)));
      }
    };
    void loadBooks().catch(() => {
      if (current) setError("Research.errors.BOOK_MISSING");
    });
    return () => {
      current = false;
    };
  }, [books]);

  useEffect(() => {
    if (!isDesktop) return;
    let current = true;
    researchRequest("workspace", { topic_id: topicId || null }).then(
      (data) => {
        if (current) {
          setWorkspace(data);
          setError("");
        }
      },
      (err: unknown) => {
        if (current) setError(researchError(err));
      }
    );
    return () => {
      current = false;
    };
  }, [isDesktop, topicId, revision]);

  function refresh() {
    setRevision((latest) => latest + 1);
  }

  function selectTopic(value: string) {
    setTopicId(value);
    setNoteId("");
    setBookKey("");
    setSuggestions(null);
    setIsEditingNote(false);
    setShowManualLink(false);
  }

  function selectNote(targetId: string) {
    setNoteId(targetId);
    setSuggestions(null);
    setIsEditingNote(false);
    setShowManualLink(false);
    setActiveTab("notes");
  }

  async function perform(action: string, run: () => Promise<void>) {
    if (busy) return;
    setBusy(action);
    setError("");
    setNotice("");
    try {
      await run();
    } catch (err) {
      setError(researchError(err));
    } finally {
      setBusy("");
    }
  }

  function addTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!topicName.trim()) return;
    void perform("save", async () => {
      const topic = await researchRequest("topic", { name: topicName });
      selectTopic(topic.id);
      setTopicName("");
      setShowNewTopic(false);
      refresh();
    });
  }

  function addBook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const book = libraryBooks.find((item) => item.key === bookKey);
    if (!book || !topicId) return;
    void perform("save", async () => {
      await researchRequest("topic-book", {
        topic_id: topicId,
        book_key: book.key,
        title: book.name.slice(0, 300),
      });
      setBookKey("");
      refresh();
    });
  }

  function openBook(targetBookKey: string, source?: { position?: string | null; chapter?: string | null }) {
    const book = libraryBooks.find((item) => item.key === targetBookKey);
    if (!book) {
      setError("Research.errors.BOOK_MISSING");
      return;
    }
    void perform("open", async () => {
      if (source?.position) {
        let location: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(source.position);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            location = parsed as Record<string, unknown>;
          }
        } catch {
          location = {
            cfi: source.position,
            chapterTitle: source.chapter || "",
          };
        }
        if (location.fingerprint && Number.isFinite(Number(location.page))) {
          location.chapterDocIndex = String(Number(location.page) - 1);
          location.chapterHref = "title" + location.chapterDocIndex;
        }
        if (Object.keys(location).length > 0) {
          ConfigService.setObjectConfig(book.key, location, "recordLocation");
        }
      }
      await BookUtil.redirectBook(book);
    });
  }

  function promoteReadingNote(item: Note) {
    if (!isDesktop) return;
    const bookTitle = bookNameByKey.get(item.bookKey) || t("Unknown book");
    const plainBody = (item.notes || "").replace(/<[^>]+>/g, "").trim();
    const plainQuote = (item.text || "").trim();
    const title = (
      item.chapter
        ? `${bookTitle} · ${item.chapter}`
        : plainBody.split(/\r?\n/)[0] || bookTitle
    ).slice(0, 300);
    const markdown = [
      plainBody || plainQuote,
      plainQuote && plainBody ? `\n> ${plainQuote}` : "",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 50000);
    const sources: ResearchSource[] = plainQuote
      ? [
          {
            kind: "book",
            book_key: item.bookKey,
            title: bookTitle.slice(0, 300),
            chapter: (item.chapter || "").slice(0, 1000) || null,
            position: item.cfi || null,
            content: plainQuote.slice(0, 12000),
          },
        ]
      : [];
    const concepts = (item.tag || [])
      .map((tag) => tag.trim().slice(0, 300))
      .filter(Boolean)
      .slice(0, 8);

    void perform("save", async () => {
      const saved = await researchRequest("note", {
        id: createUuid(),
        topic_id: topicId || null,
        title,
        question: `${bookTitle}${item.chapter ? ` · ${item.chapter}` : ""}`.slice(0, 2000),
        markdown: markdown || title,
        sources,
        concepts,
      });
      refresh();
      selectNote(saved.id);
      toast.success(t("Research.promotedToKnowledge"));
    });
  }

  function askAiAboutReadingNote(item: Note) {
    const bookTitle = bookNameByKey.get(item.bookKey) || t("Unknown book");
    const plainBody = (item.notes || "").replace(/<[^>]+>/g, "").trim();
    const plainQuote = (item.text || "").trim();
    const selection: ResearchSource | undefined =
      plainQuote || plainBody
        ? {
            kind: "book",
            book_key: item.bookKey,
            title: bookTitle.slice(0, 300),
            chapter: item.chapter || null,
            position: item.cfi || null,
            content: [
              plainQuote,
              plainBody ? `${t("Research.myAnnotationLabel")}: ${plainBody}` : "",
            ]
              .filter(Boolean)
              .join("\n\n")
              .slice(0, 12000),
          }
        : undefined;
    setChatSeed({
      key: Date.now(),
      selection,
      initialPrompt: t("Research.readingNoteAskPrompt"),
    });
    setActiveTab("chat");
  }

  function recommend() {
    if (!effectiveNoteId) return;
    setSuggestions(null);
    void perform("suggest", async () => {
      setSuggestions(
        await researchRequest("suggest", {
          id: effectiveNoteId,
          language: i18n.language.startsWith("zh") ? "zh" : "en",
        })
      );
    });
  }

  function editNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!effectiveNoteId) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const title = String(values.get("title") ?? "").trim();
    const markdown = String(values.get("markdown") ?? "").trim();
    const targetTopic = String(values.get("topic") ?? "");
    if (!title || !markdown) {
      setError("Research.emptyNote");
      form
        .querySelector<HTMLElement>(!title ? '[name="title"]' : '[name="markdown"]')
        ?.focus();
      return;
    }
    void perform("save", async () => {
      const updated = await researchRequest("edit-note", {
        id: effectiveNoteId,
        title,
        markdown,
        topic_id: targetTopic || null,
      });
      if (topicId && updated.topic_id !== topicId) {
        setTopicId(updated.topic_id ?? "");
        setBookKey("");
      }
      setIsEditingNote(false);
      refresh();
      setNotice("Research.noteUpdated");
    });
  }

  function linkNote(target: string, reason?: string) {
    if (!effectiveNoteId) return;
    void perform("save", async () => {
      await researchRequest("link", {
        first_id: effectiveNoteId,
        second_id: target,
        reason,
      });
      setSuggestions((items) => items?.filter((item) => item.id !== target) ?? null);
      setShowManualLink(false);
      refresh();
      setNotice("Research.linkSaved");
    });
  }

  function openNoteAcrossTopics(targetId: string) {
    if (!workspace.notes.some((item) => item.id === targetId)) {
      setTopicId("");
    }
    selectNote(targetId);
  }

  return (
    <main
      className="research-workspace research-ui"
      style={{ left: collapsed ? 70 : 200 }}
    >
      <div className="research-ws-shell">
        <header className="research-ws-header">
          <div className="research-ws-heading">
            <h1>{t("Research.workspace")}</h1>
            <div className="research-segmented" role="tablist">
              {isDesktop && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "notes"}
                  className={`research-seg-btn${activeTab === "notes" ? " is-active" : ""}`}
                  onClick={() => setActiveTab("notes")}
                >
                  {t("Research.tabs.notes")}
                  <span className="research-count-badge">{workspace.notes.length}</span>
                </button>
              )}
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "reading"}
                className={`research-seg-btn${activeTab === "reading" ? " is-active" : ""}`}
                onClick={() => {
                  setActiveTab("reading");
                  setReadingNoteKey("");
                }}
              >
                {t("Research.tabs.readingNotes")}
                <span className="research-count-badge">{readingNotes.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "highlights"}
                className={`research-seg-btn${activeTab === "highlights" ? " is-active" : ""}`}
                onClick={() => {
                  setActiveTab("highlights");
                  setReadingNoteKey("");
                }}
              >
                {t("Research.tabs.highlights")}
                <span className="research-count-badge">
                  {readingHighlights.length}
                </span>
              </button>
              {isDesktop && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "chat"}
                  className={`research-seg-btn${activeTab === "chat" ? " is-active" : ""}`}
                  onClick={() => setActiveTab("chat")}
                >
                  <span className="icon-ai-assist" aria-hidden="true" />
                  {t("Research.tabs.assistant")}
                </button>
              )}
            </div>
          </div>
          {isDesktop && (
            <button
              type="button"
              className="research-btn research-btn-ghost research-btn-sm"
              disabled={!!busy}
              onClick={() =>
                void perform("status", async () => {
                  setStatus(await researchRequest("status"));
                  refresh();
                })
              }
            >
              {busy === "status"
                ? t("Research.busy.status")
                : t("Research.checkServices")}
            </button>
          )}
        </header>

        {(busy && busy !== "status") || notice || status || error ? (
          <div className="research-ws-banners">
            {busy && busy !== "status" && (
              <p className="research-status-line" role="status">
                {t(`Research.busy.${busy}`)}
              </p>
            )}
            {notice && (
              <p className="research-status-line is-success" role="status">
                ✓ {t(notice)}
              </p>
            )}
            {error && (
              <p className="research-alert" role="alert">
                {t(error, {
                  defaultValue: t("Research.errors.RESEARCH_UNAVAILABLE"),
                })}
              </p>
            )}
            {status && (
              <div className="research-service-bar">
                <div className="research-service-pills">
                  <span className={`research-status-pill${status.model ? " is-ready" : ""}`}>
                    {t(status.model ? "Research.modelReady" : "Research.modelMissing")}
                  </span>
                  <span className={`research-status-pill${status.sag ? " is-ready" : ""}`}>
                    {t(
                      status.sag_error
                        ? `Research.errors.${status.sag_error}`
                        : status.sag
                          ? "Research.sagReady"
                          : "Research.sagOptional"
                    )}
                  </span>
                  <span className={`research-status-pill${status.reranker ? " is-ready" : ""}`}>
                    {t(
                      status.reranker
                        ? "Research.rerankerReady"
                        : "Research.errors.RERANKER_NOT_CONFIGURED"
                    )}
                  </span>
                  <span className="research-status-pill is-ready">
                    {t(status.web ? "Research.webReady" : "Research.webFallbackReady")}
                  </span>
                </div>
                <div className="research-service-footer">
                  <code className="research-path-code">{status.notes_path}</code>
                  <button
                    type="button"
                    className="research-btn research-btn-ghost research-btn-sm"
                    onClick={() => setStatus(null)}
                  >
                    {t("Close")}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {isReadingCollectionTab ? (
          <div className="research-ws-notes-layout">
            <section className="research-reading-filters">
              {readingNoteBooks.length > 0 && (
                <select
                  className="research-select research-select-sm"
                  aria-label={t("Filter by book")}
                  value={readingBookFilter}
                  onChange={(event) => setReadingBookFilter(event.target.value)}
                >
                  <option value="">{t("Research.allBooks")}</option>
                  {readingNoteBooks.map(([key, title]) => (
                    <option key={key} value={key}>
                      {title}
                    </option>
                  ))}
                </select>
              )}
              {readingNoteTags.length > 0 && (
                <div className="research-topic-pills">
                  <button
                    type="button"
                    className={`research-topic-pill${readingTagFilter === "" ? " is-active" : ""}`}
                    onClick={() => setReadingTagFilter("")}
                  >
                    {t("Research.allTags")}
                  </button>
                  {readingNoteTags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className={`research-topic-pill${readingTagFilter === tag ? " is-active" : ""}`}
                      onClick={() =>
                        setReadingTagFilter((cur) => (cur === tag ? "" : tag))
                      }
                    >
                      #{tag}
                    </button>
                  ))}
                </div>
              )}
            </section>

            <div className="research-master-detail">
              <aside
                className="research-note-list-pane"
                aria-label={t(
                  isHighlightsTab
                    ? "Research.tabs.highlights"
                    : "Research.tabs.readingNotes"
                )}
              >
                <div className="research-list-search">
                  <input
                    type="search"
                    className="research-input"
                    placeholder={t(
                      isHighlightsTab
                        ? "Research.filterHighlights"
                        : "Research.filterReadingNotes"
                    )}
                    value={readingFilter}
                    onChange={(event) => setReadingFilter(event.target.value)}
                  />
                </div>
                {filteredReadingNotes.length === 0 ? (
                  <div className="research-empty-notes">
                    <p className="research-muted">
                      {t(
                        isHighlightsTab
                          ? "Research.noHighlights"
                          : "Research.noReadingNotes"
                      )}
                    </p>
                  </div>
                ) : (
                  <div className="research-note-cards" role="list">
                    {filteredReadingNotes.map((item) => {
                      const isSelected = item.key === selectedReadingNote?.key;
                      const bookTitle =
                        bookNameByKey.get(item.bookKey) || t("Unknown book");
                      return (
                        <button
                          key={item.key}
                          type="button"
                          role="listitem"
                          className={`research-note-card${isSelected ? " is-selected" : ""}`}
                          onClick={() => setReadingNoteKey(item.key)}
                        >
                          <div className="research-note-card-head">
                            <span className="research-note-card-title">
                              {isHighlightsTab && isCssColor(item.color) && (
                                <span
                                  className="research-color-dot"
                                  style={{ backgroundColor: item.color }}
                                  aria-hidden="true"
                                />
                              )}
                              {bookTitle}
                            </span>
                            <span className="research-note-card-date">
                              {formatNoteTimestamp(item.key)}
                            </span>
                          </div>
                          {item.chapter && (
                            <span className="research-reading-card-chapter">
                              {item.chapter}
                            </span>
                          )}
                          <p className="research-note-card-preview">
                            {notePlainPreview(item)}
                          </p>
                          {(item.tag || []).length > 0 && (
                            <div className="research-note-card-tags">
                              {item.tag.slice(0, 4).map((tag) => (
                                <span key={tag} className="research-mini-tag">
                                  #{tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </aside>

              <section className="research-note-detail-pane">
                {!selectedReadingNote ? (
                  <div className="research-empty-detail">
                    <p className="research-muted">
                      {t(
                        isHighlightsTab
                          ? "Research.noHighlights"
                          : "Research.noReadingNotes"
                      )}
                    </p>
                  </div>
                ) : (
                  <article className="research-note-article" key={selectedReadingNote.key}>
                    <header className="research-note-header">
                      <div>
                        <div className="research-note-meta-row">
                          <span className="research-mini-tag is-topic">
                            {bookNameByKey.get(selectedReadingNote.bookKey) ||
                              t("Unknown book")}
                          </span>
                          <span className="research-muted">
                            {formatNoteTimestamp(selectedReadingNote.key)}
                          </span>
                        </div>
                        <h2>
                          {selectedReadingNote.chapter ||
                            bookNameByKey.get(selectedReadingNote.bookKey) ||
                            t(isHighlightsTab ? "Highlights" : "Notes")}
                        </h2>
                      </div>
                      <div className="research-note-toolbar">
                        <button
                          type="button"
                          className="research-btn research-btn-ghost research-btn-sm"
                          onClick={() => {
                            handleNoteKey(selectedReadingNote.key);
                            handleShowPopupNote(true);
                          }}
                        >
                          {t(
                            selectedReadingNote.notes
                              ? "Edit"
                              : "Research.addAnnotation"
                          )}
                        </button>
                        <button
                          type="button"
                          className="research-btn research-btn-ghost research-btn-sm"
                          disabled={!!busy}
                          onClick={() =>
                            openBook(selectedReadingNote.bookKey, {
                              position: selectedReadingNote.cfi,
                              chapter: selectedReadingNote.chapter,
                            })
                          }
                        >
                          {t("Research.openBook")}
                        </button>
                        {isDesktop && (
                          <>
                            <button
                              type="button"
                              className="research-btn research-btn-ghost research-btn-sm"
                              onClick={() => askAiAboutReadingNote(selectedReadingNote)}
                            >
                              {t("Research.askAiAboutNote")}
                            </button>
                            <button
                              type="button"
                              className="research-btn research-btn-primary research-btn-sm"
                              disabled={!!busy}
                              onClick={() => promoteReadingNote(selectedReadingNote)}
                            >
                              {t("Research.promoteToKnowledge")}
                            </button>
                          </>
                        )}
                      </div>
                    </header>

                    {selectedReadingNote.text && (
                      <div className="research-reading-quote-block">
                        <span className="research-reading-section-label">
                          {t("Research.bookExcerptLabel")}
                        </span>
                        <blockquote
                          className="research-quote"
                          style={
                            isHighlightsTab && isCssColor(selectedReadingNote.color)
                              ? { borderInlineStartColor: selectedReadingNote.color }
                              : undefined
                          }
                        >
                          {selectedReadingNote.text}
                        </blockquote>
                      </div>
                    )}

                    {selectedReadingNote.notes && (
                      <div className="research-reading-body-block">
                        <span className="research-reading-section-label">
                          {t("Research.myAnnotationLabel")}
                        </span>
                        <div className="research-reading-annotation">
                          <NoteContent
                            content={selectedReadingNote.notes}
                            type={selectedReadingNote.type}
                          />
                        </div>
                      </div>
                    )}

                    {(selectedReadingNote.tag || []).length > 0 && (
                      <div className="research-concept-row">
                        {selectedReadingNote.tag.map((tag) => (
                          <span key={tag} className="research-mini-tag">
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="research-reading-footer">
                      <button
                        type="button"
                        className="research-btn research-btn-ghost research-btn-sm"
                        onClick={() => {
                          const link = `koodo-reader://open-note?noteKey=${selectedReadingNote.key}`;
                          void navigator.clipboard.writeText(link).then(() => {
                            toast.success(t("Copied"));
                          });
                        }}
                      >
                        {t("Copy note link")}
                      </button>
                    </div>
                  </article>
                )}
              </section>
            </div>
          </div>
        ) : (
          isDesktop && (
            <>
              <section className="research-topic-bar" aria-label={t("Research.topic")}>
                <div className="research-topic-pills">
                  <button
                    type="button"
                    className={`research-topic-pill${topicId === "" ? " is-active" : ""}`}
                    onClick={() => selectTopic("")}
                  >
                    {t("Research.allTopics")}
                  </button>
                  {workspace.topics.map((topic) => (
                    <button
                      key={topic.id}
                      type="button"
                      className={`research-topic-pill${topicId === topic.id ? " is-active" : ""}`}
                      onClick={() => selectTopic(topic.id)}
                    >
                      {topic.name}
                    </button>
                  ))}
                  {showNewTopic ? (
                    <form className="research-inline-form" onSubmit={addTopic}>
                      <label className="research-sr-only" htmlFor={`${id}-topic`}>
                        {t("Research.newTopic")}
                      </label>
                      <input
                        id={`${id}-topic`}
                        className="research-input research-input-sm"
                        placeholder={t("Research.newTopic")}
                        value={topicName}
                        maxLength={300}
                        autoFocus
                        required
                        onChange={(event) => setTopicName(event.target.value)}
                      />
                      <button
                        type="submit"
                        className="research-btn research-btn-primary research-btn-sm"
                        disabled={!!busy || !topicName.trim()}
                      >
                        {t("Research.create")}
                      </button>
                      <button
                        type="button"
                        className="research-btn research-btn-ghost research-btn-sm"
                        onClick={() => {
                          setShowNewTopic(false);
                          setTopicName("");
                        }}
                      >
                        {t("Cancel")}
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="research-topic-pill is-add"
                      onClick={() => setShowNewTopic(true)}
                    >
                      + {t("Research.newTopic")}
                    </button>
                  )}
                </div>
              </section>

              {activeTab === "chat" ? (
                <div className="research-ws-chat-pane">
                  <ResearchForm
                    key={chatSeed.key}
                    selection={chatSeed.selection}
                    initialPrompt={chatSeed.initialPrompt}
                    topicId={topicId}
                    topics={workspace.topics}
                    onSaved={(saved) => {
                      setNoteId(saved.id);
                      refresh();
                    }}
                    onOpenBookSource={(src) => src.book_key && openBook(src.book_key, src)}
                    onOpenNoteSource={openNoteAcrossTopics}
                  />
                </div>
              ) : (
                <div className="research-ws-notes-layout">
                  {topicId && (
                    <section className="research-topic-books-strip">
                      <span className="research-strip-label">
                        {t("Research.topicBooks")}
                      </span>
                      <div className="research-book-chips">
                        {workspace.books.map((book) => (
                          <button
                            key={book.book_key}
                            type="button"
                            className="research-book-chip"
                            disabled={!!busy}
                            onClick={() => openBook(book.book_key)}
                          >
                            {book.title}
                          </button>
                        ))}
                        <form className="research-inline-form" onSubmit={addBook}>
                          <select
                            className="research-select research-select-sm"
                            aria-label={t("Research.libraryBook")}
                            value={bookKey}
                            onChange={(event) => setBookKey(event.target.value)}
                          >
                            <option value="">{t("Research.selectBook")}</option>
                            {libraryBooks.map((book) => (
                              <option key={book.key} value={book.key}>
                                {book.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="submit"
                            className="research-btn research-btn-ghost research-btn-sm"
                            disabled={!!busy || !bookKey}
                          >
                            + {t("Research.addBook")}
                          </button>
                        </form>
                      </div>
                    </section>
                  )}

                  <div className="research-master-detail">
                    <aside className="research-note-list-pane" aria-label={t("Research.notes")}>
                      <div className="research-list-search">
                        <input
                          type="search"
                          className="research-input"
                          placeholder={t("Research.filterNotes")}
                          value={noteFilter}
                          onChange={(event) => setNoteFilter(event.target.value)}
                        />
                      </div>
                      {filteredNotes.length === 0 ? (
                        <div className="research-empty-notes">
                          <p className="research-muted">{t("Research.noNotes")}</p>
                          <button
                            type="button"
                            className="research-btn research-btn-primary research-btn-sm"
                            onClick={() => setActiveTab("chat")}
                          >
                            {t("Research.startResearch")}
                          </button>
                        </div>
                      ) : (
                        <div className="research-note-cards" role="list">
                          {filteredNotes.map((item) => {
                            const isSelected = item.id === effectiveNoteId;
                            return (
                              <button
                                key={item.id}
                                type="button"
                                role="listitem"
                                className={`research-note-card${isSelected ? " is-selected" : ""}`}
                                onClick={() => selectNote(item.id)}
                              >
                                <div className="research-note-card-head">
                                  <span className="research-note-card-title">
                                    {item.title}
                                  </span>
                                  <span className="research-note-card-date">
                                    {formatShortDate(item.created_at)}
                                  </span>
                                </div>
                                <p className="research-note-card-preview">
                                  {item.question || item.markdown.slice(0, 90)}
                                </p>
                                {(item.topic_id || item.concepts.length > 0) && (
                                  <div className="research-note-card-tags">
                                    {item.topic_id && topicNameById.get(item.topic_id) && (
                                      <span className="research-mini-tag is-topic">
                                        {topicNameById.get(item.topic_id)}
                                      </span>
                                    )}
                                    {item.concepts.slice(0, 3).map((concept) => (
                                      <span key={concept} className="research-mini-tag">
                                        {concept}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </aside>

                    <section className="research-note-detail-pane">
                      {!note ? (
                        <div className="research-empty-detail">
                          <p className="research-muted">{t("Research.selectNoteHint")}</p>
                        </div>
                      ) : (
                        <article className="research-note-article" key={note.id}>
                          <header className="research-note-header">
                            <div>
                              <div className="research-note-meta-row">
                                {note.topic_id && topicNameById.get(note.topic_id) && (
                                  <span className="research-mini-tag is-topic">
                                    {topicNameById.get(note.topic_id)}
                                  </span>
                                )}
                                <span className="research-muted">
                                  {formatShortDate(note.created_at)}
                                </span>
                              </div>
                              <h2>{note.title}</h2>
                            </div>
                            <div className="research-note-toolbar">
                              <button
                                type="button"
                                className="research-btn research-btn-ghost research-btn-sm"
                                onClick={() => setIsEditingNote((v) => !v)}
                              >
                                {isEditingNote ? t("Cancel") : t("Edit")}
                              </button>
                              {linkOptions.length > 0 && (
                                <button
                                  type="button"
                                  className="research-btn research-btn-ghost research-btn-sm"
                                  onClick={() => setShowManualLink((v) => !v)}
                                >
                                  {t("Research.manualLink")}
                                </button>
                              )}
                              <button
                                type="button"
                                className="research-btn research-btn-ghost research-btn-sm"
                                disabled={!!busy}
                                onClick={recommend}
                              >
                                {t("Research.suggest")}
                              </button>
                            </div>
                          </header>

                          {isEditingNote ? (
                            <form
                              method="post"
                              className="research-edit-form"
                              onSubmit={editNote}
                            >
                              <label htmlFor={`${id}-edit-title`}>
                                {t("Research.noteTitle")}
                              </label>
                              <input
                                id={`${id}-edit-title`}
                                name="title"
                                className="research-input"
                                defaultValue={note.title}
                                maxLength={300}
                                required
                              />
                              <label htmlFor={`${id}-edit-topic`}>
                                {t("Research.topic")}
                              </label>
                              <select
                                id={`${id}-edit-topic`}
                                name="topic"
                                className="research-select"
                                defaultValue={note.topic_id ?? ""}
                              >
                                <option value="">{t("Research.noTopic")}</option>
                                {workspace.topics.map((topic) => (
                                  <option key={topic.id} value={topic.id}>
                                    {topic.name}
                                  </option>
                                ))}
                              </select>
                              <label htmlFor={`${id}-edit-body`}>
                                {t("Research.noteBody")}
                              </label>
                              <textarea
                                id={`${id}-edit-body`}
                                name="markdown"
                                className="research-textarea"
                                defaultValue={note.markdown}
                                rows={10}
                                maxLength={50000}
                                required
                              />
                              <div className="research-edit-actions">
                                <button
                                  type="submit"
                                  className="research-btn research-btn-primary"
                                  disabled={!!busy}
                                >
                                  {t("Research.saveChanges")}
                                </button>
                                <button
                                  type="button"
                                  className="research-btn research-btn-ghost"
                                  onClick={() => setIsEditingNote(false)}
                                >
                                  {t("Cancel")}
                                </button>
                              </div>
                            </form>
                          ) : (
                            <>
                              {note.question && (
                                <div className="research-question-callout">
                                  <span className="research-callout-label">Q</span>
                                  <span>{note.question}</span>
                                </div>
                              )}
                              <ResearchMarkdown content={note.markdown} />
                              {note.concepts.length > 0 && (
                                <div className="research-concept-row">
                                  {note.concepts.map((concept) => (
                                    <span key={concept} className="research-mini-tag">
                                      {concept}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </>
                          )}

                          {note.sources.length > 0 && (
                            <section className="research-detail-section">
                              <h3>
                                {t("Research.sourcesCount", {
                                  count: note.sources.length,
                                })}
                              </h3>
                              <Sources
                                sources={note.sources}
                                onOpenBook={(source) =>
                                  source.book_key && openBook(source.book_key, source)
                                }
                                onOpenNote={openNoteAcrossTopics}
                              />
                            </section>
                          )}

                          <section className="research-detail-section">
                            <h3>{t("Research.links")}</h3>
                            {showManualLink && linkOptions.length > 0 && (
                              <form
                                method="post"
                                className="research-inline-form research-link-picker"
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  const target = new FormData(event.currentTarget).get(
                                    "target"
                                  );
                                  if (typeof target === "string" && target) {
                                    linkNote(target);
                                  }
                                }}
                              >
                                <select
                                  name="target"
                                  className="research-select"
                                  aria-label={t("Research.linkTarget")}
                                  defaultValue=""
                                  required
                                >
                                  <option value="">{t("Research.selectNote")}</option>
                                  {linkOptions.map((item) => (
                                    <option key={item.id} value={item.id}>
                                      {item.title}
                                      {item.topic_id && topicNameById.get(item.topic_id)
                                        ? ` · ${topicNameById.get(item.topic_id)}`
                                        : ""}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="submit"
                                  className="research-btn research-btn-primary research-btn-sm"
                                  disabled={!!busy}
                                >
                                  {t("Research.confirm")}
                                </button>
                              </form>
                            )}

                            {noteLinks.length > 0 ? (
                              <div className="research-link-grid">
                                {noteLinks.map((link) => {
                                  const otherId =
                                    link.first_id === note.id
                                      ? link.second_id
                                      : link.first_id;
                                  const title =
                                    link.first_id === note.id
                                      ? link.second_title
                                      : link.first_title;
                                  return (
                                    <button
                                      key={otherId}
                                      type="button"
                                      className="research-link-card"
                                      disabled={!!busy}
                                      onClick={() => openNoteAcrossTopics(otherId)}
                                    >
                                      <span className="research-link-card-title">
                                        {title}
                                      </span>
                                      {link.reason && (
                                        <span className="research-link-card-reason">
                                          {link.reason}
                                        </span>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            ) : (
                              <p className="research-muted research-empty-links">
                                {t("Research.noLinkedNotes")}
                              </p>
                            )}

                            {suggestions && suggestions.length === 0 && (
                              <p className="research-muted" role="status">
                                {t("Research.noLinks")}
                              </p>
                            )}
                            {suggestions && suggestions.length > 0 && (
                              <div className="research-suggestions-list">
                                {suggestions.map((suggestion) => (
                                  <div
                                    key={suggestion.id}
                                    className="research-suggestion-card"
                                  >
                                    <div>
                                      <strong>{suggestion.title}</strong>
                                      <p className="research-muted">
                                        {suggestion.reason}
                                      </p>
                                    </div>
                                    <button
                                      type="button"
                                      className="research-btn research-btn-primary research-btn-sm"
                                      disabled={!!busy}
                                      onClick={() =>
                                        linkNote(suggestion.id, suggestion.reason)
                                      }
                                    >
                                      {t("Research.confirm")}
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </section>
                        </article>
                      )}
                    </section>
                  </div>
                </div>
              )}
            </>
          )
        )}
      </div>
    </main>
  );
}
