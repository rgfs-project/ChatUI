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
  SquarePen,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ProjectDto } from "@shared/library";
import { LIBRARY_LIMITS } from "@shared/library-limits";
import { paths } from "../lib/paths";
import { ApiError, apiJson, queries, queryKeys } from "../lib/query";
import { useSidebar } from "../lib/sidebar-context";
import { ConfirmDialog, TextDialog } from "./Dialogs";
import "./files.css";

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

function useProjectMutations(userId: string) {
  const client = useQueryClient();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: queryKeys.projects(userId) });
    void client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });
  };
  return {
    create: useMutation({
      mutationFn: (name: string) =>
        apiJson<ProjectDto>("/api/projects", { method: "POST", body: JSON.stringify({ name }) }),
      onSettled: refresh,
    }),
    rename: useMutation({
      mutationFn: ({ id, name }: { id: string; name: string }) =>
        apiJson<ProjectDto>(`/api/projects/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ name }),
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

/** Library: your projects. Opening one lists its chats. */
export function LibraryPage({
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
  const list = projects.data ?? [];
  return (
    <main className="files-page" data-testid="library-page">
      <MobileHeader title="Library" />
      <div className="page-scroll">
        <div className="page-body">
          <div className="page-head">
            <h1 className="page-title">Library</h1>
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
                  <h2 className="row-label">Group chats into projects</h2>
                  <p className="row-hint">
                    Create a project, then use “Move to project” in a chat’s menu.
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
            <section className="section">
              <h2 className="section-title">Projects</h2>
              <ul className="group" aria-label="Projects">
                {list.map((project) => (
                  <li key={project.id}>
                    <Link to={paths.library(project.id)} className="row project-row">
                      <span className="file-icon" aria-hidden>
                        <FolderClosed size={18} />
                      </span>
                      <span className="row-text grow">
                        <span className="row-label">{project.name}</span>
                        <span className="row-hint">
                          {project.chatCount} chat{project.chatCount === 1 ? "" : "s"}
                        </span>
                      </span>
                      <ChevronRight size={16} className="muted" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      <TextDialog
        key={String(creating)}
        open={creating}
        onOpenChange={setCreating}
        title="New project"
        description="A name for a group of chats."
        label="Project name"
        initial=""
        submitLabel="Create"
        maxLength={LIBRARY_LIMITS.projectName}
        onSubmit={(name) => {
          create.mutate(name, {
            onSuccess: (project) => void navigate(paths.library(project.id)),
            onError: (e) => {
              setError(e instanceof ApiError ? e.message : "The project couldn’t be created.");
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
  const { rename, remove } = useProjectMutations(userId);
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const project = projects.data?.find((p) => p.id === projectId);
  const inProject = (chats.data ?? [])
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <main className="files-page" data-testid="project-page">
      <MobileHeader title={project?.name ?? "Project"} />
      <div className="page-scroll">
        <div className="page-body">
          <Link to={paths.library()} className="back-link">
            <ArrowLeft size={16} aria-hidden /> Library
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
                <h1 className="page-title">{project.name}</h1>
                <Menu.Root modal={false}>
                  <Menu.Trigger className="icon-btn" aria-label={`Actions for ${project.name}`}>
                    <Ellipsis size={20} aria-hidden />
                  </Menu.Trigger>
                  <Menu.Portal>
                    <Menu.Content className="menu" align="end" sideOffset={4} collisionPadding={8}>
                      <Menu.Item
                        className="menu-item"
                        onSelect={() => {
                          setRenaming(true);
                        }}
                      >
                        <Pencil size={20} aria-hidden /> Rename
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
              {inProject.length === 0 ? (
                <section className="group">
                  <p className="row row-hint">
                    No chats yet. Use “Move to project” in a chat’s menu to add one.
                  </p>
                </section>
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
              <TextDialog
                key={project.name}
                open={renaming}
                onOpenChange={setRenaming}
                title="Rename project"
                description="A name for this group of chats."
                label="Project name"
                initial={project.name}
                submitLabel="Rename"
                maxLength={LIBRARY_LIMITS.projectName}
                onSubmit={(name) => {
                  rename.mutate({ id: project.id, name });
                }}
              />
              <ConfirmDialog
                open={deleting}
                onOpenChange={setDeleting}
                title={`Delete ${project.name}?`}
                description="The project goes; its chats stay, outside any project."
                confirmLabel="Delete project"
                onConfirm={() => {
                  remove.mutate(project.id, { onSuccess: () => void navigate(paths.library()) });
                }}
              />
            </>
          )}
        </div>
      </div>
    </main>
  );
}
