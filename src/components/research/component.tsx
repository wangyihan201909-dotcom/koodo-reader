import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { openExternalUrl } from "../../utils/common";
import { researchError, researchRequest } from "./api";
import type {
  ResearchDraft, ResearchNote, ResearchSource, ResearchTopic, RetrievalMode, SearchResult,
} from "./types";
import "./research.css";

export function Sources({ sources, onOpen }: {
  sources: ResearchSource[];
  onOpen?: (source: ResearchSource) => void;
}) {
  const { t } = useTranslation();
  return (
    <ol className="research-sources">
      {sources.map((source, index) => (
        <li key={index}>
          <details>
            <summary>{source.title}</summary>
            <p className="research-muted">
              {source.chapter || source.path || source.url}
              {source.start_line != null && (
                <> · {t("Research.lines", { start: source.start_line, end: source.end_line })}</>
              )}
            </p>
            <blockquote>{source.content}</blockquote>
            {source.url && /^https?:\/\//i.test(source.url) && (
              <button type="button" onClick={() => openExternalUrl(source.url!)}>
                {t("Research.openSource")}
              </button>
            )}
            {onOpen && source.book_key && (
              <button type="button" onClick={() => onOpen(source)}>{t("Research.openBook")}</button>
            )}
          </details>
        </li>
      ))}
    </ol>
  );
}

export default function ResearchForm({ selection, topicId, topics: workspaceTopics, onSaved }: {
  selection?: ResearchSource;
  topicId?: string;
  topics?: ResearchTopic[];
  onSaved?: (note: ResearchNote) => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState<RetrievalMode>(selection ? "selection" : "fast");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [draft, setDraft] = useState<ResearchDraft | null>(null);
  const [topics, setTopics] = useState<ResearchTopic[]>([]);
  const [noteTopicId, setNoteTopicId] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!selection) return;
    let active = true;
    researchRequest("workspace").then(
      (workspace) => { if (active) setTopics(workspace.topics); },
      (error: unknown) => { if (active) setError(researchError(error)); }
    );
    return () => { active = false; };
  }, [selection]);

  async function runQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const action = submitter?.value === "search" ? "search" : "ask";
    const text = submitter?.value === "explain" ? t("Research.explainPrompt") : question.trim();
    if (!text || busy || (action === "search" && mode === "selection")) return;
    setBusy(action);
    setSaved(false);
    setDraft(null);
    setResult(null);
    setError("");
    try {
      if (action === "ask") {
        const reply = await researchRequest("ask", {
          question: text, mode, selection, language: i18n.language.startsWith("zh") ? "zh" : "en",
        });
        setDraft(reply);
        setResult(reply);
      } else {
        setResult(await researchRequest("search", { question: text, mode }));
      }
    } catch (error) {
      setError(researchError(error));
    } finally {
      setBusy("");
    }
  }

  async function saveDraft() {
    if (!draft || busy) return;
    setBusy("save");
    setError("");
    try {
      const note = await researchRequest("note", { ...draft, topic_id: topicId || noteTopicId || null });
      setSaved(true);
      onSaved?.(note);
    } catch (error) {
      setError(researchError(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="research-compose">
      {selection && (
        <details className="research-selection">
          <summary>{t("Research.selection")} · {selection.title}</summary>
          <blockquote>{selection.content}</blockquote>
        </details>
      )}
      <form onSubmit={runQuestion} aria-labelledby={`${id}-question-label`}>
        <label id={`${id}-question-label`} htmlFor={`${id}-question`}>{t("Research.question")}</label>
        <textarea
          id={`${id}-question`}
          rows={3}
          maxLength={2000}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          autoFocus={Boolean(selection)}
        />
        <label htmlFor={`${id}-mode`}>{t("Research.retrieval")}</label>
        <select id={`${id}-mode`} value={mode} onChange={(event) => setMode(event.target.value as RetrievalMode)}>
          {selection && <option value="selection">{t("Research.mode.selection")}</option>}
          <option value="fast">{t("Research.mode.fast")}</option>
          <option value="rerank">{t("Research.mode.rerank")}</option>
          <option value="web">{t("Research.mode.web")}</option>
        </select>
        <p className="research-muted">{t("Research.dataScope")}</p>
        <div className="research-actions">
          <button className="research-primary" type="submit" value="ask" disabled={!!busy || !question.trim()}>
            {t("Research.ask")}
          </button>
          {selection && (
            <button type="submit" value="explain" disabled={!!busy}>{t("Research.explain")}</button>
          )}
          {mode !== "selection" && (
            <button type="submit" value="search" disabled={!!busy || !question.trim()}>{t("Research.search")}</button>
          )}
        </div>
      </form>
      <div role="status">
        {busy && <p>{t(`Research.busy.${busy}`)}</p>}
        {saved && <p>{t("Research.saved")}</p>}
      </div>
      {error && <p role="alert">{t(error, { defaultValue: t("Research.errors.RESEARCH_UNAVAILABLE") })}</p>}
      {result && (
        <div className="research-result">
          {draft && (
            <>
              <h3>{draft.title}</h3>
              <div className="research-markdown">{draft.markdown}</div>
              {draft.concepts.length > 0 && <p className="research-muted">{draft.concepts.join(" · ")}</p>}
            </>
          )}
          {result.sources.length > 0 ? (
            <>
              <h3>{t("Research.sources")}</h3>
              <Sources sources={result.sources} />
            </>
          ) : <p>{t("Research.noSources")}</p>}
          {result.truncated && <p role="status">{t("Research.truncated")}</p>}
          {draft && !saved && (
            <div className="research-actions">
              {!topicId && (
                <label>
                  {t("Research.topic")}
                  <select value={noteTopicId} onChange={(event) => setNoteTopicId(event.target.value)}>
                    <option value="">{t("Research.noTopic")}</option>
                    {(workspaceTopics ?? topics).map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
                  </select>
                </label>
              )}
              <button type="button" className="research-primary" disabled={!!busy} onClick={saveDraft}>
                {t("Research.save")}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
