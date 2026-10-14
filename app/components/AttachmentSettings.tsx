import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { DEFAULT_IMAGE_MAX_EDGE } from "../lib/attachments";
import { apiJson, queries, queryKeys, type PreferencesDto } from "../lib/query";

const EDGES = [1024, 1536, 2048, 3072, 4096];

/**
 * Two rows of Settings → General → Chat. "Earlier images and audio" decides
 * whether earlier files go to the model again with each message; "Shrink large
 * images" resizes photos in the browser before upload (default edge, or never).
 */
export function AttachmentSettings({ userId }: { userId: string }) {
  const client = useQueryClient();
  const preferences = useQuery(queries.preferences(userId));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (patch: Partial<PreferencesDto>) =>
      apiJson<PreferencesDto>("/api/preferences", { method: "PATCH", body: JSON.stringify(patch) }),
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
    <>
      <div className="row">
        <label className="row-label" htmlFor="history-images">
          Earlier images and audio
        </label>
        <select
          id="history-images"
          className="select"
          disabled={disabled}
          title="Send earlier messages’ images and audio to the model again"
          value={prefs?.historyImages ?? "include"}
          onChange={(event) => {
            save.mutate({ historyImages: event.currentTarget.value as "include" | "omit" });
          }}
        >
          <option value="include">Include</option>
          <option value="omit">Omit</option>
        </select>
      </div>
      <div className="row">
        <label className="row-label" htmlFor="image-max-edge">
          Shrink large images
        </label>
        <select
          id="image-max-edge"
          className="select"
          disabled={disabled}
          title="Resize photos before upload so their longest side fits"
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
          <option value="0">Never</option>
        </select>
      </div>
      {error || preferences.isError ? (
        <p className="row form-error" role="alert">
          {error ?? "Your settings couldn’t be loaded."}
        </p>
      ) : null}
    </>
  );
}
