import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { DEFAULT_IMAGE_MAX_EDGE } from "../lib/attachments";
import { apiJson, queries, queryKeys, type PreferencesDto } from "../lib/query";

const EDGES = [1024, 1536, 2048, 3072, 4096];

/**
 * Settings → Customize → Attachments (Phase 12): the two prompt/upload
 * preferences. `historyImages` decides whether earlier images and audio are
 * sent to the model again; `imageMaxEdge` shrinks large images in the browser
 * before upload (unset: the default edge; 0: never).
 */
export function AttachmentSettings({ userId }: { userId: string }) {
  const client = useQueryClient();
  const preferences = useQuery(queries.preferences(userId));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (patch: Partial<PreferencesDto>) =>
      apiJson<PreferencesDto>("/api/preferences", {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: (data) => {
      setError(null);
      client.setQueryData(queryKeys.preferences(userId), data);
    },
    onError: () => {
      setError("The setting couldn’t be saved. Try again.");
    },
  });
  const prefs = preferences.data;
  const disabled = !prefs || save.isPending;
  return (
    <section className="settings-body" tabIndex={0} aria-labelledby="settings-attachments">
      <h2 id="settings-attachments">Attachments</h2>
      <div className="settings-row">
        <div>
          <label className="settings-label" htmlFor="history-images">
            Earlier images and audio
          </label>
          <p className="settings-hint">
            Send the images and audio of earlier messages to the model again with each new message.
            Omitting them saves context and time; the files stay in the conversation.
          </p>
        </div>
        <select
          id="history-images"
          className="text-input settings-select"
          disabled={disabled}
          value={prefs?.historyImages ?? "include"}
          onChange={(event) => {
            save.mutate({ historyImages: event.currentTarget.value as "include" | "omit" });
          }}
        >
          <option value="include">Include</option>
          <option value="omit">Omit</option>
        </select>
      </div>
      <div className="settings-row">
        <div>
          <label className="settings-label" htmlFor="image-max-edge">
            Shrink large images
          </label>
          <p className="settings-hint">
            Before uploading, larger photos are resized in your browser so their longest side fits.
          </p>
        </div>
        <select
          id="image-max-edge"
          className="text-input settings-select"
          disabled={disabled}
          value={String(prefs?.imageMaxEdge ?? "")}
          onChange={(event) => {
            const value = event.currentTarget.value;
            save.mutate({ imageMaxEdge: value === "" ? null : Number(value) });
          }}
        >
          <option value="">Default ({DEFAULT_IMAGE_MAX_EDGE} px)</option>
          {EDGES.map((edge) => (
            <option key={edge} value={String(edge)}>
              {edge} px
            </option>
          ))}
          <option value="0">Never shrink</option>
        </select>
      </div>
      {error || preferences.isError ? (
        <p className="error" role="alert">
          {error ?? "Your settings couldn’t be loaded."}
        </p>
      ) : null}
    </section>
  );
}
