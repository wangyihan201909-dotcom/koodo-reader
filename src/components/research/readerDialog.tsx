import { useEffect, useId, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../store/useAppStore";
import { sendResearchToolResult, subscribeResearchToolCalls } from "./api";
import {
  executeBookToolCall,
  extractCurrentBookContext,
  jumpToBookSource,
} from "./bookTools";
import ResearchForm from "./component";
import type { ResearchSource } from "./types";
import "./research.css";

export default function ReaderResearchDialog({
  source,
  onClose,
}: {
  source?: ResearchSource;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const { t } = useTranslation();
  const currentBook = useAppStore((s) => s.book.currentBook);
  const htmlBook = useAppStore((s) => s.reader.htmlBook);

  const bookContext = useMemo(
    () => extractCurrentBookContext(currentBook, htmlBook, source),
    [currentBook, htmlBook, source]
  );

  useEffect(() => {
    const element = dialog.current;
    if (!element || element.open) return;
    const question = element.querySelector<HTMLTextAreaElement>(
      'textarea[name="question"]'
    );
    element.showModal();
    question?.focus();
  }, []);

  useEffect(() => {
    return subscribeResearchToolCalls((call) => {
      void executeBookToolCall(
        currentBook,
        htmlBook,
        call.toolName,
        call.args || {}
      ).then((result) => {
        sendResearchToolResult({
          callId: call.callId,
          ok: result.ok,
          data: result.data,
          error: result.error,
        });
      });
    });
  }, [currentBook, htmlBook]);

  async function handleOpenBookSource(cited: ResearchSource) {
    if (cited.book_key === currentBook?.key) {
      const jumped = await jumpToBookSource(htmlBook, cited);
      if (jumped) {
        dialog.current?.close();
      }
    }
  }

  return createPortal(
    <dialog
      ref={dialog}
      className="research-dialog research-ui"
      aria-labelledby={title}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) {
          dialog.current?.close();
        }
      }}
    >
      <div className="research-dialog-inner">
        <header className="research-dialog-header">
          <div className="research-dialog-heading">
            <span className="icon-ai-assist research-dialog-icon" aria-hidden="true" />
            <div>
              <h2 id={title}>{t("Ask AI")}</h2>
              {bookContext?.bookTitle && (
                <p className="research-dialog-subtitle">
                  {bookContext.bookTitle}
                  {bookContext.chapter ? ` · ${bookContext.chapter}` : ""}
                </p>
              )}
            </div>
          </div>
          <form method="dialog">
            <button
              type="submit"
              className="research-icon-close"
              aria-label={t("Close")}
              title={t("Close")}
            >
              ×
            </button>
          </form>
        </header>
        <ResearchForm
          selection={source}
          bookContext={bookContext}
          onOpenBookSource={handleOpenBookSource}
          compact
        />
      </div>
    </dialog>,
    document.body
  );
}
