import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";
import Book from "../../models/Book";
import { useAppStore } from "../../store/useAppStore";
import BookUtil from "../../utils/file/bookUtil";
import DatabaseService from "../../utils/storage/databaseService";
import { researchError, researchRequest } from "./api";
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

function formatShortDate(iso: string) {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString();
}

export default function ResearchWorkspacePage() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const books = useAppStore((state) => state.manager.books);
  const collapsed = useAppStore((state) => state.sidebar.isCollapsed);

  const [activeTab, setActiveTab] = useState<"notes" | "chat">("notes");
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
  }, [topicId, revision]);

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

  function openBook(targetBookKey: string, source?: ResearchSource) {
    const book = libraryBooks.find((item) => item.key === targetBookKey);
    if (!book) {
      setError("Research.errors.BOOK_MISSING");
      return;
    }
    void perform("open", async () => {
      if (source?.position) {
        const location = JSON.parse(source.position);
        if (location && typeof location === "object" && !Array.isArray(location)) {
          if (location.fingerprint && Number.isFinite(Number(location.page))) {
            location.chapterDocIndex = String(Number(location.page) - 1);
            location.chapterHref = "title" + location.chapterDocIndex;
          }
          ConfigService.setObjectConfig(book.key, location, "recordLocation");
        }
      }
      await BookUtil.redirectBook(book);
    });
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
            </div>
          </div>
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
                  <span className={`research-status-pill${status.web ? " is-ready" : ""}`}>
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

        {window.electronAPI && (
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
        )}
      </div>
    </main>
  );
}
