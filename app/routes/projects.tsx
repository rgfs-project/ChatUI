import { ProjectsPage } from "../components/ProjectsPage";
import { useUserId } from "../lib/auth-store";
import type { Route } from "./+types/projects";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Projects · ChatUI" }];
}

/** Projects, and one project's instructions and chats (`/projects/:projectId`). */
export default function Projects({ params }: Route.ComponentProps) {
  return (
    <ProjectsPage
      key={params.projectId ?? "all"}
      userId={useUserId()}
      projectId={params.projectId}
    />
  );
}
