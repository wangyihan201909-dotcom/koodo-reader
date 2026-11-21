import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import ResearchForm from "./component";
import type { ResearchSource } from "./types";

export default function ReaderResearchDialog({ source, onClose }: {
  source: ResearchSource;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const { t } = useTranslation();
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  return createPortal(
    <dialog ref={dialog} className="research-dialog research-ui" aria-labelledby={title} onClose={onClose}>
      <header className="research-title">
        <h2 id={title}>{t("Research.reader")}</h2>
        <form method="dialog"><button type="submit">{t("Close")}</button></form>
      </header>
      <ResearchForm selection={source} />
    </dialog>,
    document.body
  );
}
