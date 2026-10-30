import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AttachmentList } from "@shared/attachments";
import type { PreferencesDto } from "@shared/preferences";
import { useChat } from "../chat/chat-context";
import { DEFAULT_IMAGE_MAX_EDGE } from "../chat/downscale";
import { formatSize } from "../chat/message-attachments";
import { apiJson } from "../lib/api";
import { qk } from "../lib/query/keys";
import { preferencesQuery } from "../lib/query/queries";
import { useToast } from "../ui/toast";
import { Row } from "./row";

function useSavePreference() {
  const { userId } = useChat();
  const client = useQueryClient();
  const toast = useToast();
  return (patch: Partial<PreferencesDto>) =>
    apiJson<PreferencesDto>("/api/preferences", { method: "PATCH", json: patch }).then(
      (updated) => {
        client.setQueryData(qk.preferences(userId), updated);
        toast("Saved.");
      },
      (error: unknown) => {
        toast(error instanceof Error ? error.message : "Could not save", "error");
      },
    );
}

const EDGES = [0, 1024, 2048, 4096];

export function ImageSizeRow() {
  const { userId } = useChat();
  const preferences = useQuery(preferencesQuery(userId));
  const save = useSavePreference();
  const edge = preferences.data?.imageMaxEdge ?? DEFAULT_IMAGE_MAX_EDGE;
  return (
    <Row
      label="Shrink large images"
      hint="Images are resized in your browser before upload; this also removes location data."
    >
      <select
        aria-label="Shrink large images"
        className="text-field native-select"
        value={EDGES.includes(edge) ? edge : DEFAULT_IMAGE_MAX_EDGE}
        onChange={(event) => {
          void save({ imageMaxEdge: Number(event.currentTarget.value) });
        }}
      >
        {EDGES.map((value) => (
          <option key={value} value={value}>
            {value === 0
              ? "Never"
              : `Longest side ${String(value)} px${value === DEFAULT_IMAGE_MAX_EDGE ? " (default)" : ""}`}
          </option>
        ))}
      </select>
    </Row>
  );
}

export function HistoryImagesRow() {
  const { userId } = useChat();
  const preferences = useQuery(preferencesQuery(userId));
  const save = useSavePreference();
  const include = (preferences.data?.historyImages ?? "include") === "include";
  return (
    <Row
      label="Send earlier images again"
      hint="Lets the model see images from earlier messages. Turn off to keep prompts small."
    >
      <input
        type="checkbox"
        role="switch"
        className="switch"
        aria-label="Send earlier images again"
        checked={include}
        onChange={(event) => {
          void save({ historyImages: event.currentTarget.checked ? "include" : "omit" });
        }}
      />
    </Row>
  );
}

export function StorageRow() {
  const { userId } = useChat();
  const list = useQuery({
    queryKey: qk.attachments(userId),
    queryFn: ({ signal }) => apiJson<AttachmentList>("/api/attachments", { signal }),
  });
  const data = list.data;
  return (
    <Row
      label="File storage"
      hint={
        data
          ? `${formatSize(data.usedBytes)} of ${formatSize(data.quotaBytes)} used · files up to ${formatSize(data.maxBytes)}`
          : "Loading…"
      }
    >
      {data ? (
        <progress
          className="storage-meter"
          max={data.quotaBytes}
          value={data.usedBytes}
          aria-label="File storage used"
        />
      ) : null}
    </Row>
  );
}
