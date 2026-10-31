import { useEffect, useState } from "react";
import { apiJson } from "../lib/api";

/**
 * A captured HTML/SVG file running in a sandboxed frame (Phase 19, INV-51;
 * docs/threat-model-19.md). The frame gets a single-use link and the
 * `allow-scripts` sandbox only: an opaque origin with no cookies, storage,
 * network, forms, popups or navigation of the page. The app never listens to
 * it. Unmounting removes the frame and everything running in it.
 */
export function PreviewFrame({ artifactId, filename }: { artifactId: string; filename: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    apiJson<{ url: string; expiresAt: string }>(`/api/artifacts/${artifactId}/preview`, {
      method: "POST",
    }).then(
      (minted) => {
        if (!cancelled) setUrl(minted.url);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [artifactId]);
  if (failed)
    return (
      <p className="source-note" role="alert">
        The preview could not be started.
      </p>
    );
  if (!url) return <p className="source-note">Starting preview…</p>;
  return (
    <div className="preview">
      <p className="preview-label">Preview of a file from a reply: it can't reach your account.</p>
      <iframe
        className="preview-frame"
        src={url}
        title={`Preview of ${filename}`}
        sandbox="allow-scripts"
        allow=""
        referrerPolicy="no-referrer"
        data-testid="preview-frame"
      />
    </div>
  );
}
