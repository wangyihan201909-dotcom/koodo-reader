import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";
import Book from "../../models/Book";
import { useAppStore } from "../../store/useAppStore";
import BookUtil from "../../utils/file/bookUtil";
import DatabaseService from "../../utils/storage/databaseService";
import { researchError, researchRequest } from "./api";
import ResearchForm, { Sources } from "./component";
import type { RelatedNote, ResearchSource, ResearchStatus, ResearchWorkspace } from "./types";
import "./research.css";

const emptyWorkspace: ResearchWorkspace = { topics: [], books: [], notes: [], links: [] };

export default function ResearchWorkspacePage() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const books = useAppStore((state) => state.manager.books);
  const collapsed = useAppStore((state) => state.sidebar.isCollapsed);
  const [topicId, setTopicId] = useState("");
  const [topicName, setTopicName] = useState("");
  const [bookKey, setBookKey] = useState("");
  const [libraryBooks, setLibraryBooks] = useState<Book[]>([]);
  const [noteId, setNoteId] = useState("");
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<ResearchStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [suggestions, setSuggestions] = useState<RelatedNote[] | null>(null);
  const note = workspace.notes.find((item) => item.id === noteId);

  useEffect(() => {
    if (!books) return;
    let current = true;
    const activeBooks = new Set(books.map((book) => book.key));
    const loadBooks = async () => {
      const records: Book[] = await DatabaseService.getAllRecords("books");
      if (current) setLibraryBooks(records.filter((book) => activeBooks.has(book.key)));
    };
    void loadBooks().catch(() => {
      if (current) setError("Research.errors.BOOK_MISSING");
    });
    return () => { current = false; };
  }, [books]);

  useEffect(() => {
    let current = true;
    researchRequest("workspace", { topic_id: topicId || null }).then(
      (data) => { if (current) setWorkspace(data); },
      (error: unknown) => { if (current) setError(researchError(error)); }
    );
    return () => { current = false; };
  }, [topicId, revision]);

  function refresh() {
    setRevision((latest) => latest + 1);
  }

  function selectTopic(value: string) {
    setTopicId(value);
    setNoteId("");
    setBookKey("");
    setSuggestions(null);
  }

  async function perform(action: string, run: () => Promise<void>) {
    if (busy) return;
    setBusy(action);
    setError("");
    try {
      await run();
    } catch (error) {
      setError(researchError(error));
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
      refresh();
    });
  }

  function addBook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const book = libraryBooks.find((item) => item.key === bookKey);
    if (!book || !topicId) return;
    void perform("save", async () => {
      await researchRequest("topic-book", { topic_id: topicId, book_key: book.key, title: book.name.slice(0, 300) });
      setBookKey("");
      refresh();
    });
  }

  function openBook(bookKey: string, source?: ResearchSource) {
    const book = libraryBooks.find((item) => item.key === bookKey);
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
    setSuggestions(null);
    void perform("suggest", async () => {
      setSuggestions(await researchRequest("suggest", {
        id: noteId, language: i18n.language.startsWith("zh") ? "zh" : "en",
      }));
    });
  }

  function confirmLink(suggestion: RelatedNote) {
    void perform("save", async () => {
      await researchRequest("link", {
        first_id: noteId, second_id: suggestion.id, reason: suggestion.reason,
      });
      setSuggestions((items) => items?.filter((item) => item.id !== suggestion.id) ?? null);
      refresh();
    });
  }

  return (
    <main className="research-workspace research-ui" style={{ left: collapsed ? 70 : 200 }}>
      <div className="research-layout">
        <header className="research-title">
          <h1>{t("Research.workspace")}</h1>
          <button type="button" disabled={!!busy} onClick={() => void perform("status", async () => {
            setStatus(await researchRequest("status"));
            refresh();
          })}>{t("Research.checkServices")}</button>
        </header>
        <div role="status">
          {busy && <p>{t(`Research.busy.${busy}`)}</p>}
          {status && (
            <div className="research-service">
              <span>{t(status.model ? "Research.modelReady" : "Research.modelMissing")}</span>
              <span>{t(status.sag_error ? `Research.errors.${status.sag_error}` : status.sag ? "Research.sagReady" : "Research.errors.SAG_NOT_CONFIGURED")}</span>
              <span>{t(status.reranker ? "Research.rerankerReady" : "Research.errors.RERANKER_NOT_CONFIGURED")}</span>
              <span>{t(status.web ? "Research.webReady" : "Research.errors.WEB_NOT_CONFIGURED")}</span>
              <code>{status.notes_path}</code>
            </div>
          )}
        </div>
        {error && <p role="alert">{t(error, { defaultValue: t("Research.errors.RESEARCH_UNAVAILABLE") })}</p>}
        {window.electronAPI && (
          <>
            <section className="research-topics" aria-label={t("Research.topic")}>
              <label>
                {t("Research.topic")}
                <select value={topicId} disabled={!!busy} onChange={(event) => selectTopic(event.target.value)}>
                  <option value="">{t("Research.allTopics")}</option>
                  {workspace.topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
                </select>
              </label>
              <form className="research-actions" onSubmit={addTopic} aria-labelledby={`${id}-topic-label`}>
                <label id={`${id}-topic-label`} htmlFor={`${id}-topic`}>{t("Research.newTopic")}</label>
                <input id={`${id}-topic`} value={topicName} maxLength={300} required onChange={(event) => setTopicName(event.target.value)} />
                <button type="submit" disabled={!!busy || !topicName.trim()}>{t("Research.create")}</button>
              </form>
            </section>
            <div className="research-columns">
              <div>
                <section className="research-card">
                  <h2>{t("Research.investigate")}</h2>
                  <ResearchForm key={topicId} topicId={topicId} topics={workspace.topics} onSaved={(saved) => {
                    setNoteId(saved.id);
                    setSuggestions(null);
                    refresh();
                  }} />
                </section>
                {topicId && (
                  <section className="research-card">
                    <h2>{t("Research.topicBooks")}</h2>
                    <form onSubmit={addBook} className="research-actions" aria-labelledby={`${id}-book-label`}>
                      <label id={`${id}-book-label`}>
                        {t("Research.libraryBook")}
                        <select value={bookKey} onChange={(event) => setBookKey(event.target.value)} required>
                          <option value="">{t("Research.selectBook")}</option>
                          {libraryBooks.map((book) => <option key={book.key} value={book.key}>{book.name}</option>)}
                        </select>
                      </label>
                      <button type="submit" disabled={!!busy || !bookKey}>{t("Research.addBook")}</button>
                    </form>
                    <ul>
                      {workspace.books.map((book) => (
                        <li key={book.book_key}><button type="button" disabled={!!busy} onClick={() => openBook(book.book_key)}>{book.title}</button></li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
              <section className="research-card">
                <h2>{t("Research.notes")}</h2>
                {workspace.notes.length === 0 ? <p>{t("Research.noNotes")}</p> : (
                  <label>
                    {t("Research.selectNote")}
                    <select value={noteId} disabled={!!busy} onChange={(event) => {
                      setNoteId(event.target.value);
                      setSuggestions(null);
                    }}>
                      <option value="">{t("Research.selectNote")}</option>
                      {workspace.notes.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                    </select>
                  </label>
                )}
                {note && (
                  <article className="research-note">
                    <h3>{note.title}</h3>
                    <p className="research-muted">{note.question}</p>
                    <div className="research-markdown">{note.markdown}</div>
                    {note.concepts.length > 0 && <p className="research-muted">{note.concepts.join(" · ")}</p>}
                    {note.sources.length > 0 && (
                      <Sources sources={note.sources} onOpen={(source) => source.book_key && openBook(source.book_key, source)} />
                    )}
                    <h4>{t("Research.links")}</h4>
                    <ul>
                      {workspace.links.filter((link) => link.first_id === note.id || link.second_id === note.id).map((link) => {
                        const otherId = link.first_id === note.id ? link.second_id : link.first_id;
                        const title = link.first_id === note.id ? link.second_title : link.first_title;
                        return (
                          <li key={otherId}>
                            <button type="button" disabled={!!busy} onClick={() => {
                              if (!workspace.notes.some((item) => item.id === otherId)) selectTopic("");
                              setNoteId(otherId);
                              setSuggestions(null);
                            }}>{title}</button>
                            <p>{link.reason}</p>
                          </li>
                        );
                      })}
                    </ul>
                    <button type="button" disabled={!!busy} onClick={recommend}>{t("Research.suggest")}</button>
                    {suggestions && suggestions.length === 0 && <p role="status">{t("Research.noLinks")}</p>}
                    {suggestions && suggestions.length > 0 && (
                      <ul>
                        {suggestions.map((suggestion) => (
                          <li key={suggestion.id}>
                            <strong>{suggestion.title}</strong>
                            <p>{suggestion.reason}</p>
                            <button type="button" disabled={!!busy} onClick={() => confirmLink(suggestion)}>{t("Research.confirm")}</button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </article>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
