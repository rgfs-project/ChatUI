import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { ArtifactList, ArtifactSummary } from "@shared/artifacts";
import { ConfirmDialog, IconButton } from "../components/ui";
import { api, messageOf } from "../lib/api";
import { formatBytes, formatDateTime } from "../lib/format";
import { paths } from "../lib/paths";
import { keys } from "../lib/query";
import { Empty, Group, Row, Status } from "./parts";

export function Files(props: { userId: string }) {
  const client = useQueryClient();
  const artifacts = useQuery({
    queryKey: keys.artifacts(props.userId),
    queryFn: ({ signal }) => api<ArtifactList>("/api/artifacts", { signal }),
  });
  const [deleting, setDeleting] = useState<ArtifactSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!deleting) return;
    try {
      await api(`/api/artifacts/${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
      await client.invalidateQueries({ queryKey: keys.artifacts(props.userId) });
    } catch (e) {
      setError(messageOf(e));
    }
    setDeleting(null);
  }

  const data = artifacts.data;
  return (
    <>
      <p className="muted section-intro">
        Files that replies created, kept as source. They’re never run.
      </p>
      {data?.artifacts.length === 0 ? (
        <Empty title="No files yet">When a reply writes a file, it appears here.</Empty>
      ) : (
        <Group
          note={
            data
              ? `${formatBytes(data.usedBytes)} of ${formatBytes(data.quotaBytes)} used`
              : undefined
          }
        >
          {data?.artifacts.map((a) => (
            <Row
              key={a.id}
              label={a.name}
              hint={
                <>
                  {[a.language, formatBytes(a.size), formatDateTime(a.createdAt)]
                    .filter(Boolean)
                    .join(" · ")}
                  {a.conversationId && a.backlinkAvailable ? (
                    <>
                      {" · "}
                      <Link to={paths.chat(a.conversationId)}>Open chat</Link>
                    </>
                  ) : null}
                </>
              }
            >
              <a
                className="icon-button muted-icon"
                href={`/api/artifacts/${encodeURIComponent(a.id)}/source?download=1`}
                aria-label={`Download ${a.name}`}
                title="Download"
              >
                <Download size={18} aria-hidden />
              </a>
              <IconButton
                label={`Delete ${a.name}`}
                className="muted-icon"
                onClick={() => {
                  setDeleting(a);
                }}
              >
                <Trash2 size={18} aria-hidden />
              </IconButton>
            </Row>
          ))}
        </Group>
      )}
      <Status error={error ?? (artifacts.isError ? "Couldn’t load your files." : null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete file?"
        description={`“${deleting?.name ?? ""}” will be permanently deleted.`}
        confirm="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </>
  );
}
