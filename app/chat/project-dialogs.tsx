import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, FolderPlus } from "lucide-react";
import { useEffect, useState, type SyntheticEvent } from "react";
import type { PreferencesDto } from "@shared/preferences";
import { apiJson } from "../lib/api";
import { qk } from "../lib/query/keys";
import { preferencesQuery } from "../lib/query/queries";
import { Dialog } from "../ui/dialog";
import { useToast } from "../ui/toast";
import { useChat } from "./chat-context";

/** Opens a project dialog from anywhere (sidebar, header, slash menu). */
export type ProjectDialogRequest =
  | { kind: "create"; thenMove?: string }
  | { kind: "rename"; projectId: string; name: string }
  | { kind: "move"; conversationId: string };

const EVENT = "chatui:project-dialog";

export function openProjectDialog(request: ProjectDialogRequest): void {
  window.dispatchEvent(new CustomEvent<ProjectDialogRequest>(EVENT, { detail: request }));
}

function useSaveProjects() {
  const { userId } = useChat();
  const client = useQueryClient();
  const toast = useToast();
  return async (url: string, method: string, json?: unknown): Promise<PreferencesDto | null> => {
    try {
      const prefs = await apiJson<PreferencesDto>(url, {
        method,
        ...(json === undefined ? {} : { json }),
      });
      client.setQueryData(qk.preferences(userId), prefs);
      return prefs;
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not update projects", "error");
      return null;
    }
  };
}

function NameDialog({
  title,
  initial,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    void onSubmit(name.trim()).then((done) => {
      setBusy(false);
      if (done) onClose();
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
    >
      <form className="dialog-form" onSubmit={submit}>
        <input
          className="text-field selectable"
          aria-label="Project name"
          placeholder="Project name"
          maxLength={60}
          value={name}
          autoFocus
          onChange={(event) => {
            setName(event.currentTarget.value);
          }}
        />
        <div className="dialog-actions">
          <button type="button" className="pill-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="pill-button pill-primary"
            disabled={busy || name.trim() === ""}
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function MoveDialog({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const { userId } = useChat();
  const prefs = useQuery(preferencesQuery(userId)).data;
  const save = useSaveProjects();
  const toast = useToast();
  const current = prefs?.chatProjects[conversationId] ?? null;
  const move = (projectId: string | null) => {
    void save(`/api/conversations/${conversationId}/project`, "PUT", { projectId }).then((done) => {
      if (!done) return;
      const name = prefs?.projects.find((p) => p.id === projectId)?.name;
      toast(name ? `Moved to ${name}.` : "Removed from its project.");
      onClose();
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Move to project"
    >
      <ul className="project-choices" aria-label="Projects">
        {(prefs?.projects ?? []).map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className="side-row"
              aria-current={p.id === current ? "true" : undefined}
              onClick={() => {
                move(p.id);
              }}
            >
              <Folder size={16} aria-hidden />
              <span>{p.name}</span>
              {p.id === current ? <span className="project-current">Current</span> : null}
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            className="side-row"
            onClick={() => {
              onClose();
              openProjectDialog({ kind: "create", thenMove: conversationId });
            }}
          >
            <FolderPlus size={16} aria-hidden />
            <span>New project…</span>
          </button>
        </li>
      </ul>
      {current ? (
        <div className="dialog-actions">
          <button
            type="button"
            className="pill-button"
            onClick={() => {
              move(null);
            }}
          >
            Remove from project
          </button>
        </div>
      ) : null}
    </Dialog>
  );
}

/** Mounted once by the app layout; shows whichever project dialog was requested. */
export function ProjectDialogs() {
  const [request, setRequest] = useState<ProjectDialogRequest | null>(null);
  const save = useSaveProjects();
  useEffect(() => {
    const open = (event: Event) => {
      setRequest((event as CustomEvent<ProjectDialogRequest>).detail);
    };
    window.addEventListener(EVENT, open);
    return () => {
      window.removeEventListener(EVENT, open);
    };
  }, []);
  const close = () => {
    setRequest(null);
  };
  if (!request) return null;
  if (request.kind === "move")
    return <MoveDialog conversationId={request.conversationId} onClose={close} />;
  if (request.kind === "rename")
    return (
      <NameDialog
        title="Rename project"
        initial={request.name}
        submitLabel="Rename"
        onClose={close}
        onSubmit={async (name) =>
          (await save(`/api/projects/${request.projectId}`, "PATCH", { name })) !== null
        }
      />
    );
  return (
    <NameDialog
      title="New project"
      initial=""
      submitLabel="Create"
      onClose={close}
      onSubmit={async (name) => {
        const prefs = await save("/api/projects", "POST", { name });
        if (!prefs) return false;
        const created = prefs.projects.at(-1);
        if (request.thenMove && created)
          await save(`/api/conversations/${request.thenMove}/project`, "PUT", {
            projectId: created.id,
          });
        return true;
      }}
    />
  );
}
