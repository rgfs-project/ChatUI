import { useQuery } from "@tanstack/react-query";
import { Info, X } from "lucide-react";
import { instanceQuery } from "../lib/query/queries";
import { useUi } from "../lib/ui-context";

/** Short stable hash of the notice text: dismissing one notice never hides the next. */
export function noticeHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** The admin's instance notice (Phase 10), dismissable per browser. */
export function NoticeBanner({ userId }: { userId: string }) {
  const { data } = useQuery(instanceQuery(userId));
  const { noticeDismissed, dismissNotice } = useUi();
  const notice = data?.notice;
  if (!notice || noticeHash(notice) === noticeDismissed) return null;
  return (
    <div className="notice-banner" role="status" data-testid="notice">
      <Info size={16} aria-hidden />
      <p className="selectable">{notice}</p>
      <button
        type="button"
        className="icon-button"
        aria-label="Dismiss notice"
        onClick={() => {
          dismissNotice(noticeHash(notice));
        }}
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
