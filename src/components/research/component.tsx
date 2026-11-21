import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import copy from "copy-text-to-clipboard";
import toast from "react-hot-toast";
import { openExternalUrl } from "../../utils/common";
import {
  abortResearchChat,
  researchError,
  researchRequest,
  resetResearchChat,
  startResearchChat,
  subscribeResearchAgentEvents,
} from "./api";
import ResearchMarkdown from "./markdown";
import type {
  AgentChatTurn,
  AgentToolStep,
  BookAgentContext,
  ResearchAgentCapabilities,
  ResearchNote,
  ResearchSource,
  ResearchTopic,
} from "./types";
import "./research.css";

function createLocalId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function Sources({
  sources,
  onOpenBook,
  onOpenNote,
}: {
  sources: ResearchSource[];
  onOpenBook?: (source: ResearchSource) => void;
  onOpenNote?: (noteId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <ol className="research-sources">
      {sources.map((source, index) => (
        <li key={`${source.kind}-${index}`} className="research-source-item">
          <details className="research-source-details">
            <summary className="research-source-summary">
              <span className="research-source-index">[{index + 1}]</span>
              <span className={`research-source-badge kind-${source.kind}`}>
                {t(`Research.sourceKind.${source.kind}`)}
              </span>
              <span className="research-source-title">{source.title}</span>
            </summary>
            <div className="research-source-body">
              {(source.chapter || source.path || source.url) && (
                <p className="research-muted research-source-meta">
                  {source.chapter || source.path || source.url}
                  {source.start_line != null && (
                    <>
                      {" · "}
                      {t("Research.lines", {
                        start: source.start_line,
                        end: source.end_line,
                      })}
                    </>
                  )}
                </p>
              )}
              <blockquote className="research-quote">{source.content}</blockquote>
              <div className="research-source-actions">
                {source.url && /^https?:\/\//i.test(source.url) && (
                  <button
                    type="button"
                    className="research-btn research-btn-ghost research-btn-sm"
                    onClick={() => openExternalUrl(source.url!)}
                  >
                    {t("Research.openSource")}
                  </button>
                )}
                {onOpenBook && source.book_key && source.position && (
                  <button
                    type="button"
                    className="research-btn research-btn-ghost research-btn-sm"
                    onClick={() => onOpenBook(source)}
                  >
                    {t("Research.openBook")}
                  </button>
                )}
                {onOpenNote && source.note_id && (
                  <button
                    type="button"
                    className="research-btn research-btn-ghost research-btn-sm"
                    onClick={() => onOpenNote(source.note_id!)}
                  >
                    {t("Research.openNote")}
                  </button>
                )}
              </div>
            </div>
          </details>
        </li>
      ))}
    </ol>
  );
}

function ToolSteps({
  steps,
  streaming,
  sourceCount,
}: {
  steps: AgentToolStep[];
  streaming: boolean;
  sourceCount: number;
}) {
  const { t } = useTranslation();
  if (steps.length === 0 && !streaming) return null;

  const renderStep = (step: AgentToolStep) => {
    const label = t(`Research.tools.${step.toolName}`, {
      defaultValue: step.toolName,
    });
    const icon =
      step.status === "running" ? "◌" : step.status === "error" ? "!" : "✓";
    return (
      <li
        key={step.toolCallId}
        className={`research-step-item status-${step.status}`}
      >
        <span className="research-step-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="research-step-label">{label}</span>
        {step.summary && (
          <span className="research-step-detail">“{step.summary}”</span>
        )}
        {step.status === "done" && typeof step.count === "number" && (
          <span className="research-step-count">
            {t("Research.toolHits", { count: step.count })}
          </span>
        )}
      </li>
    );
  };

  if (streaming) {
    return (
      <div className="research-trace-live" role="status">
        {steps.length > 0 ? (
          <ul className="research-step-list">{steps.map(renderStep)}</ul>
        ) : (
          <span className="research-thinking-indicator">
            {t("Research.agentPlanning")}
          </span>
        )}
      </div>
    );
  }

  return (
    <details className="research-trace-collapsed">
      <summary>
        {t("Research.traceSummary", {
          steps: steps.length,
          sources: sourceCount,
        })}
      </summary>
      <ul className="research-step-list">{steps.map(renderStep)}</ul>
    </details>
  );
}

export default function ResearchForm({
  selection,
  bookContext,
  topicId,
  topics: workspaceTopics,
  onSaved,
  onOpenBookSource,
  onOpenNoteSource,
  compact = false,
}: {
  selection?: ResearchSource;
  bookContext?: BookAgentContext | null;
  topicId?: string;
  topics?: ResearchTopic[];
  onSaved?: (note: ResearchNote) => void;
  onOpenBookSource?: (source: ResearchSource) => void;
  onOpenNoteSource?: (noteId: string) => void;
  compact?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const sessionIdRef = useRef<string>(createLocalId());
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [question, setQuestion] = useState("");
  const [allowWeb, setAllowWeb] = useState(true);
  const [turns, setTurns] = useState<AgentChatTurn[]>([]);
  const [topics, setTopics] = useState<ResearchTopic[]>([]);
  const [saveTopicByTurn, setSaveTopicByTurn] = useState<Record<string, string>>({});
  const [savingTurnId, setSavingTurnId] = useState("");
  const [capabilities, setCapabilities] = useState<ResearchAgentCapabilities | null>(null);
  const [globalError, setGlobalError] = useState("");

  const isStreaming = turns.some((turn) => turn.streaming);
  const availableTopics = workspaceTopics ?? topics;

  useEffect(() => {
    if (workspaceTopics) return;
    let active = true;
    researchRequest("workspace").then(
      (workspace) => {
        if (active) setTopics(workspace.topics);
      },
      () => {
        // Non-blocking: topics load lazily when service becomes ready
      }
    );
    return () => {
      active = false;
    };
  }, [workspaceTopics]);

  useEffect(() => {
    const sid = sessionIdRef.current;
    const unsubscribe = subscribeResearchAgentEvents((event) => {
      if (event.sessionId !== sid) return;
      if (event.type === "run_start" && event.capabilities) {
        setCapabilities(event.capabilities);
        return;
      }
      setTurns((prev) =>
        prev.map((turn) => {
          if (turn.runId !== event.runId) return turn;
          switch (event.type) {
            case "text_delta":
              return { ...turn, markdown: turn.markdown + event.delta };
            case "thinking_delta":
              return { ...turn, thinking: turn.thinking + event.delta };
            case "tool_start":
              return {
                ...turn,
                steps: [
                  ...turn.steps,
                  {
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    summary: event.summary,
                    status: "running",
                  },
                ],
              };
            case "tool_end":
              return {
                ...turn,
                steps: turn.steps.map((step) =>
                  step.toolCallId === event.toolCallId
                    ? {
                        ...step,
                        summary: event.summary || step.summary,
                        count: event.count,
                        durationMs: event.durationMs,
                        status: event.isError ? "error" : "done",
                      }
                    : step
                ),
              };
            case "sources":
              return { ...turn, sources: event.sources };
            case "run_end":
              return {
                ...turn,
                streaming: false,
                aborted: event.aborted,
                markdown: event.answer?.markdown || turn.markdown,
                sources: event.answer?.sources ?? turn.sources,
                answer: event.answer,
              };
            case "run_error":
              return {
                ...turn,
                streaming: false,
                error: researchError(new Error(event.error)),
                errorDetail: event.detail,
              };
            default:
              return turn;
          }
        })
      );
    });
    return () => {
      unsubscribe();
      void resetResearchChat(sid);
    };
  }, []);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 140) {
      container.scrollTop = container.scrollHeight;
    }
  }, [turns]);

  async function submitPrompt(rawPrompt: string) {
    const text = rawPrompt.trim();
    if (!text || isStreaming) return;
    setGlobalError("");
    setQuestion("");

    const localTurnId = createLocalId();
    const pendingRunId = `pending-${localTurnId}`;
    setTurns((prev) => [
      ...prev,
      {
        id: localTurnId,
        runId: pendingRunId,
        question: text,
        markdown: "",
        thinking: "",
        steps: [],
        sources: [],
        streaming: true,
      },
    ]);

    try {
      const { runId } = await startResearchChat({
        sessionId: sessionIdRef.current,
        prompt: text,
        language: i18n.language.startsWith("zh") ? "zh" : "en",
        allowWeb,
        bookContext: bookContext ?? (selection ? {
          bookKey: selection.book_key || "",
          bookTitle: selection.title,
          chapter: selection.chapter || undefined,
          position: selection.position,
          selection,
          canSearchBook: false,
        } : null),
      });
      setTurns((prev) =>
        prev.map((turn) =>
          turn.id === localTurnId ? { ...turn, runId } : turn
        )
      );
    } catch (error) {
      const errorKey = researchError(error);
      setTurns((prev) =>
        prev.map((turn) =>
          turn.id === localTurnId
            ? { ...turn, streaming: false, error: errorKey }
            : turn
        )
      );
    }
  }

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim()) {
      setGlobalError("Research.enterQuestion");
      textareaRef.current?.focus();
      return;
    }
    void submitPrompt(question);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (question.trim() && !isStreaming) {
        void submitPrompt(question);
      }
    }
  }

  async function handleNewChat() {
    if (isStreaming) {
      await abortResearchChat(sessionIdRef.current);
    }
    await resetResearchChat(sessionIdRef.current);
    setTurns([]);
    setGlobalError("");
    textareaRef.current?.focus();
  }

  async function handleSaveTurn(turn: AgentChatTurn) {
    if (!turn.answer || savingTurnId) return;
    setSavingTurnId(turn.id);
    setGlobalError("");
    try {
      const targetTopic = topicId || saveTopicByTurn[turn.id] || null;
      const saved = await researchRequest("note", {
        ...turn.answer,
        topic_id: targetTopic,
      });
      setTurns((prev) =>
        prev.map((item) =>
          item.id === turn.id ? { ...item, savedNoteId: saved.id } : item
        )
      );
      toast.success(t("Research.saved"));
      onSaved?.(saved);
    } catch (error) {
      setGlobalError(researchError(error));
    } finally {
      setSavingTurnId("");
    }
  }

  const quickPrompts = selection
    ? [
        { label: t("Research.quick.explain"), prompt: t("Research.explainPrompt") },
        { label: t("Research.quick.contextMetaphor"), prompt: t("Research.quick.contextMetaphorPrompt") },
        { label: t("Research.quick.crossReference"), prompt: t("Research.quick.crossReferencePrompt") },
      ]
    : bookContext
      ? [
          { label: t("Research.quick.summarizeChapter"), prompt: t("Research.quick.summarizeChapterPrompt") },
          { label: t("Research.quick.bookThemes"), prompt: t("Research.quick.bookThemesPrompt") },
        ]
      : [
          { label: t("Research.quick.reviewNotes"), prompt: t("Research.quick.reviewNotesPrompt") },
          { label: t("Research.quick.researchTopic"), prompt: t("Research.quick.researchTopicPrompt") },
        ];

  return (
    <section
      className={`research-agent-shell${compact ? " is-compact" : ""}`}
      aria-label={t("Ask AI")}
    >
      {selection && (
        <details className="research-selection-bar">
          <summary>
            <span className="research-selection-tag">{t("Research.selection")}</span>
            <span className="research-selection-preview">
              {selection.content.slice(0, 90)}
              {selection.content.length > 90 ? "…" : ""}
            </span>
            {selection.chapter && (
              <span className="research-selection-chapter">{selection.chapter}</span>
            )}
          </summary>
          <blockquote className="research-quote">{selection.content}</blockquote>
        </details>
      )}

      <div className="research-thread" ref={scrollRef}>
        {turns.length === 0 ? (
          <div className="research-empty-chat">
            <div className="research-empty-icon">
              <span className="icon-ai-assist" aria-hidden="true" />
            </div>
            <p className="research-empty-title">
              {t(bookContext ? "Research.agentWelcomeBook" : "Research.agentWelcomeWorkspace")}
            </p>
            <p className="research-muted research-empty-desc">
              {t("Research.agentWelcomeHint")}
            </p>
            <div className="research-quick-chips">
              {quickPrompts.map((chip) => (
                <button
                  key={chip.label}
                  type="button"
                  className="research-chip-btn"
                  disabled={isStreaming}
                  onClick={() => void submitPrompt(chip.prompt)}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((turn) => (
            <div key={turn.id} className="research-turn">
              <div className="research-user-row">
                <div className="research-user-bubble">{turn.question}</div>
              </div>
              <div className="research-assistant-card">
                <ToolSteps
                  steps={turn.steps}
                  streaming={turn.streaming}
                  sourceCount={turn.sources.length}
                />
                {turn.thinking && (
                  <details className="research-thinking-box">
                    <summary>{t("Research.thinkingProcess")}</summary>
                    <div className="research-thinking-text">{turn.thinking}</div>
                  </details>
                )}
                {turn.markdown && (
                  <ResearchMarkdown
                    content={turn.markdown}
                    className={`research-markdown${turn.streaming ? " is-streaming" : ""}`}
                  />
                )}
                {turn.aborted && (
                  <p className="research-muted research-aborted-tag">
                    {t("Research.stopped")}
                  </p>
                )}
                {turn.error && (
                  <div className="research-alert" role="alert">
                    <span>
                      {t(turn.error, {
                        defaultValue: t("Research.errors.RESEARCH_UNAVAILABLE"),
                      })}
                    </span>
                    {turn.errorDetail && (
                      <span className="research-alert-detail">{turn.errorDetail}</span>
                    )}
                  </div>
                )}
                {turn.sources.length > 0 && !turn.streaming && (
                  <details className="research-sources-drawer">
                    <summary>
                      {t("Research.sourcesCount", { count: turn.sources.length })}
                    </summary>
                    <Sources
                      sources={turn.sources}
                      onOpenBook={onOpenBookSource}
                      onOpenNote={onOpenNoteSource}
                    />
                  </details>
                )}
                {!turn.streaming && turn.answer && (
                  <div className="research-turn-footer">
                    {turn.savedNoteId ? (
                      <span className="research-saved-pill">
                        ✓ {t("Research.saved")}
                      </span>
                    ) : (
                      <div className="research-save-group">
                        {!topicId && (
                          <select
                            className="research-select research-select-sm"
                            aria-label={t("Research.topic")}
                            value={saveTopicByTurn[turn.id] ?? ""}
                            onChange={(event) =>
                              setSaveTopicByTurn((prev) => ({
                                ...prev,
                                [turn.id]: event.target.value,
                              }))
                            }
                          >
                            <option value="">{t("Research.noTopic")}</option>
                            {availableTopics.map((topic) => (
                              <option key={topic.id} value={topic.id}>
                                {topic.name}
                              </option>
                            ))}
                          </select>
                        )}
                        <button
                          type="button"
                          className="research-btn research-btn-primary research-btn-sm"
                          disabled={!!savingTurnId}
                          onClick={() => void handleSaveTurn(turn)}
                        >
                          {savingTurnId === turn.id
                            ? t("Research.busy.save")
                            : t("Research.save")}
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      className="research-btn research-btn-ghost research-btn-sm"
                      onClick={() => {
                        copy(turn.markdown);
                        toast.success(t("Copying successful"));
                      }}
                    >
                      {t("Copy")}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {globalError && (
        <div className="research-alert" role="alert">
          {t(globalError, {
            defaultValue: t("Research.errors.RESEARCH_UNAVAILABLE"),
          })}
        </div>
      )}

      <form className="research-composer" onSubmit={handleFormSubmit}>
        <label className="research-sr-only" htmlFor={`${id}-prompt`}>
          {t("Research.question")}
        </label>
        <textarea
          ref={textareaRef}
          id={`${id}-prompt`}
          name="question"
          className="research-composer-input"
          rows={compact ? 2 : 3}
          maxLength={4000}
          placeholder={
            turns.length > 0
              ? t("Research.followUpPlaceholder")
              : t("Research.promptPlaceholder")
          }
          value={question}
          onKeyDown={handleKeyDown}
          onChange={(event) => {
            setQuestion(event.target.value);
            if (globalError === "Research.enterQuestion") setGlobalError("");
          }}
        />
        <div className="research-composer-bar">
          <div className="research-composer-meta">
            <label className={`research-toggle-pill${allowWeb ? " is-on" : ""}`}>
              <input
                type="checkbox"
                checked={allowWeb}
                onChange={(event) => setAllowWeb(event.target.checked)}
              />
              <span>{t("Research.allowWeb")}</span>
            </label>
            <span className="research-cap-hint">
              {bookContext ? t("Research.capBook") : t("Research.capWorkspace")}
              {capabilities?.sag ? ` · ${t("Research.capLocalLibrary")}` : ""}
            </span>
          </div>
          <div className="research-composer-actions">
            {turns.length > 0 && (
              <button
                type="button"
                className="research-btn research-btn-ghost research-btn-sm"
                onClick={() => void handleNewChat()}
              >
                {t("Research.newChat")}
              </button>
            )}
            {isStreaming ? (
              <button
                type="button"
                className="research-btn research-btn-secondary"
                onClick={() => void abortResearchChat(sessionIdRef.current)}
              >
                {t("Research.stop")}
              </button>
            ) : (
              <button
                type="submit"
                className="research-btn research-btn-primary"
                disabled={!question.trim()}
              >
                {t("Research.send")}
              </button>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}
