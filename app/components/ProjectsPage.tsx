import * as Menu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronRight,
  Ellipsis,
  FolderClosed,
  FolderPlus,
  MessageCircle,
  PanelLeft,
  Pencil,
  Plus,
  SquarePen,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ProjectChanges, ProjectDto } from "@shared/library";
import { LIBRARY_LIMITS } from "@shared/library-limits";
import { paths } from "../lib/paths";
import { ApiError, apiJson, queries, queryKeys } from "../lib/query";
import { useSidebar } from "../lib/sidebar-context";
import { ConfirmDialog, DialogClose, DialogFrame } from "./Dialogs";
import "./files.css";
import "./projects.css";

function MobileHeader({ title }: { title: string }) {
  const { narrow, show, drawerOpen, setDrawerTrigger, warmDrawer } = useSidebar();
  if (!narrow) return null;
  return (
    <header className="app-header">
      <span className="header-nav">
        <button
          ref={setDrawerTrigger}
          type="button"
          className="icon-btn"
          aria-label="Open sidebar"
          aria-expanded={drawerOpen}
          aria-haspopup="dialog"
          onPointerDown={warmDrawer}
          onClick={show}
        >
          <PanelLeft size={20} aria-hidden />
        </button>
      </span>
      <div className="header-title">
        <span className="title-text">{title}</span>
      </div>
      <div className="header-actions">
        <Link to={paths.newChat()} className="icon-btn" aria-label="New chat">
          <SquarePen size={20} aria-hidden />
        </Link>
      </div>
    </header>
  );
}

interface ProjectFields {
  name: string;
  description: string;
  instructions?: string;
}

function useProjectMutations(userId: string) {
  const client = useQueryClient();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: queryKeys.projects(userId) });
    void client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });
  };
  return {
    create: useMutation({
      mutationFn: (fields: ProjectFields) =>
        apiJson<ProjectDto>("/api/projects", { method: "POST", body: JSON.stringify(fields) }),
      onSettled: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, changes }: { id: string; changes: ProjectChanges }) =>
        apiJson<ProjectDto>(`/api/projects/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(changes),
        }),
      onSettled: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) =>
        apiJson(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
      onSettled: refresh,
    }),
  };
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** A project's name and what it's for: creating one, or editing its details. */
function DetailsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submitLabel: string;
  initial: { name: string; description: string };
  onSubmit: (fields: { name: string; description: string }) => void;
}) {
  const [name, setName] = useState(props.initial.name);
  const [description, setDescription] = useState(props.initial.description);
  return (
    <DialogFrame
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.title}
      description="Projects keep related chats, and the instructions they follow, in one place."
    >
      <form
        className="dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          props.onSubmit({ name: name.trim(), description: description.trim() });
          props.onOpenChange(false);
        }}
      >
        <label className="field">
          <span className="field-label">What are you working on?</span>
          <input
            className="input"
            value={name}
            required
            maxLength={LIBRARY_LIMITS.projectName}
            placeholder="Name your project"
            onChange={(event) => {
              setName(event.currentTarget.value);
            }}
          />
        </label>
        <label className="field">
          <span className="field-label">What are you trying to achieve?</span>
          <textarea
            className="textarea project-description-input"
            value={description}
            maxLength={LIBRARY_LIMITS.projectDescription}
            placeholder="Describe your project, goals, subject, etc. (optional)"
            onChange={(event) => {
              setDescription(event.currentTarget.value);
            }}
          />
        </label>
        <div className="dialog-actions">
          <DialogClose asChild>
            <button type="button" className="btn dialog-btn">
              Cancel
            </button>
          </DialogClose>
          <button type="submit" className="btn dialog-btn primary" disabled={!name.trim()}>
            {props.submitLabel}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}

function InstructionsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  initial: string;
  onSubmit: (instructions: string) => void;
}) {
  const [value, setValue] = useState(props.initial);
  return (
    <DialogFrame
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Project instructions"
      description={`Every chat in ${props.projectName} follows these, e.g. a tone, a role or what to focus on.`}
      wide
    >
      <form
        className="dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit(value.trim());
          props.onOpenChange(false);
        }}
      >
        <label htmlFor="project-instructions" className="visually-hidden">
          Instructions
        </label>
        <textarea
          id="project-instructions"
          className="textarea project-instructions-input"
          value={value}
          maxLength={LIBRARY_LIMITS.projectInstructions}
          placeholder="Think step by step and answer in British English."
          onChange={(event) => {
            setValue(event.currentTarget.value);
          }}
        />
        <div className="dialog-actions">
          <DialogClose asChild>
            <button type="button" className="btn dialog-btn">
              Cancel
            </button>
          </DialogClose>
          <button type="submit" className="btn dialog-btn primary">
            Save instructions
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}

/** Projects: chats grouped with shared instructions. Opening one shows them. */
export function ProjectsPage({
  userId,
  projectId,
}: {
  userId: string;
  projectId?: string | undefined;
}) {
  return projectId ? (
    <ProjectView userId={userId} projectId={projectId} />
  ) : (
    <ProjectList userId={userId} />
  );
}

function ProjectList({ userId }: { userId: string }) {
  const projects = useQuery(queries.projects(userId));
  const { create } = useProjectMutations(userId);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = [...(projects.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <main className="files-page" data-testid="projects-page">
      <MobileHeader title="Projects" />
      <div className="page-scroll">
        <div className="page-body">
          <div className="page-head">
            <h1 className="page-title">Projects</h1>
            <button
              type="button"
              className="btn sm primary"
              onClick={() => {
                setCreating(true);
              }}
            >
              <FolderPlus size={16} aria-hidden /> New project
            </button>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          {projects.isPending ? (
            <p className="hint">Loading projects…</p>
          ) : projects.isError ? (
            <div className="alert danger" role="alert">
              <span className="alert-text">Your projects couldn’t be loaded.</span>
              <button type="button" className="btn" onClick={() => void projects.refetch()}>
                Try again
              </button>
            </div>
          ) : list.length === 0 ? (
            <section className="group">
              <div className="row">
                <div className="row-text">
                  <h2 className="row-label">Keep related chats together</h2>
                  <p className="row-hint">
                    A project groups chats and gives them shared instructions.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setCreating(true);
                  }}
                >
                  New project
                </button>
              </div>
            </section>
          ) : (
            <ul className="group" aria-label="Projects">
              {list.map((project) => (
                <li key={project.id}>
                  <Link to={paths.projects(project.id)} className="row project-row">
                    <span className="file-icon" aria-hidden>
                      <FolderClosed size={18} />
                    </span>
                    <span className="row-text grow">
                      <span className="row-label">{project.name}</span>
                      {project.description ? (
                        <span className="row-hint project-summary">{project.description}</span>
                      ) : null}
                      <span className="row-hint">
                        {project.chatCount} chat{project.chatCount === 1 ? "" : "s"} · Updated{" "}
                        {new Date(project.updatedAt).toLocaleDateString()}
                      </span>
                    </span>
                    <ChevronRight size={16} className="muted" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <DetailsDialog
        key={String(creating)}
        open={creating}
        onOpenChange={setCreating}
        title="New project"
        submitLabel="Create project"
        initial={{ name: "", description: "" }}
        onSubmit={(fields) => {
          setError(null);
          create.mutate(fields, {
            onSuccess: (project) => void navigate(paths.projects(project.id)),
            onError: (e) => {
              setError(errorText(e, "The project couldn’t be created."));
            },
          });
        }}
      />
    </main>
  );
}

function ProjectView({ userId, projectId }: { userId: string; projectId: string }) {
  const projects = useQuery(queries.projects(userId));
  const chats = useQuery(queries.conversations(userId));
  const { update, remove } = useProjectMutations(userId);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [instructing, setInstructing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = projects.data?.find((p) => p.id === projectId);
  const inProject = (chats.data ?? [])
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const save = (changes: ProjectChanges) => {
    setError(null);
    update.mutate(
      { id: projectId, changes },
      {
        onError: (e) => {
          setError(errorText(e, "The project couldn’t be saved."));
        },
      },
    );
  };
  return (
    <main className="files-page" data-testid="project-page">
      <MobileHeader title={project?.name ?? "Project"} />
      <div className="page-scroll">
        <div className="page-body">
          <Link to={paths.projects()} className="back-link">
            <ArrowLeft size={16} aria-hidden /> All projects
          </Link>
          {projects.isPending ? (
            <p className="hint">Loading…</p>
          ) : !project ? (
            <div className="alert" role="alert">
              <span className="alert-text">This project doesn’t exist any more.</span>
            </div>
          ) : (
            <>
              <div className="page-head">
                <div className="project-head">
                  <h1 className="page-title">{project.name}</h1>
                  {project.description ? (
                    <p className="project-description">{project.description}</p>
                  ) : null}
                </div>
                <Menu.Root modal={false}>
                  <Menu.Trigger className="icon-btn" aria-label={`Actions for ${project.name}`}>
                    <Ellipsis size={20} aria-hidden />
                  </Menu.Trigger>
                  <Menu.Portal>
                    <Menu.Content className="menu" align="end" sideOffset={4} collisionPadding={8}>
                      <Menu.Item
                        className="menu-item"
                        onSelect={() => {
                          setEditing(true);
                        }}
                      >
                        <Pencil size={20} aria-hidden /> Edit details
                      </Menu.Item>
                      <Menu.Separator className="menu-separator" />
                      <Menu.Item
                        className="menu-item"
                        onSelect={() => {
                          setDeleting(true);
                        }}
                      >
                        <Trash2 size={20} aria-hidden /> Delete project
                      </Menu.Item>
                    </Menu.Content>
                  </Menu.Portal>
                </Menu.Root>
              </div>
              {error ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}
              <Link to={paths.newChat(project.id)} className="btn primary project-new-chat">
                <SquarePen size={16} aria-hidden /> New chat in this project
              </Link>
              <section className="section">
                <h2 className="section-title">Instructions</h2>
                <div className="group">
                  <div className="row">
                    <div className="row-text">
                      {project.instructions ? (
                        <p className="row-label project-instructions">{project.instructions}</p>
                      ) : (
                        <p className="row-hint">
                          Tell the assistant how to work in this project. Every chat in it follows
                          these.
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        setInstructing(true);
                      }}
                    >
                      {project.instructions ? (
                        <>
                          <Pencil size={16} aria-hidden /> Edit
                        </>
                      ) : (
                        <>
                          <Plus size={16} aria-hidden /> Add
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </section>
              <section className="section">
                <h2 className="section-title">Chats</h2>
                {inProject.length === 0 ? (
                  <div className="group">
                    <p className="row row-hint">
                      No chats yet. Start one above, or use “Move to project” in a chat’s menu.
                    </p>
                  </div>
                ) : (
                  <ul className="group" aria-label={`Chats in ${project.name}`}>
                    {inProject.map((chat) => (
                      <li key={chat.id}>
                        <Link to={paths.chat(chat.id)} className="row project-row">
                          <span className="file-icon" aria-hidden>
                            <MessageCircle size={18} />
                          </span>
                          <span className="row-text grow">
                            <span className="row-label">{chat.title}</span>
                            <span className="row-hint">
                              {new Date(chat.updatedAt).toLocaleDateString()}
                              {chat.archived ? " · Archived" : ""}
                            </span>
                          </span>
                          <ChevronRight size={16} className="muted" aria-hidden />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <DetailsDialog
                key={`details:${String(editing)}`}
                open={editing}
                onOpenChange={setEditing}
                title="Edit project"
                submitLabel="Save"
                initial={{ name: project.name, description: project.description }}
                onSubmit={save}
              />
              <InstructionsDialog
                key={`instructions:${String(instructing)}`}
                open={instructing}
                onOpenChange={setInstructing}
                projectName={project.name}
                initial={project.instructions}
                onSubmit={(instructions) => {
                  save({ instructions });
                }}
              />
              <ConfirmDialog
                open={deleting}
                onOpenChange={setDeleting}
                title={`Delete ${project.name}?`}
                description="The project and its instructions go; its chats stay, outside any project."
                confirmLabel="Delete project"
                onConfirm={() => {
                  remove.mutate(project.id, { onSuccess: () => void navigate(paths.projects()) });
                }}
              />
            </>
          )}
        </div>
      </div>
    </main>
  );
}
