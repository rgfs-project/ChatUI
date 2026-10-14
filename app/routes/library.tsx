import { LibraryPage } from "../components/LibraryPage";
import { useUserId } from "../lib/auth-store";
import type { Route } from "./+types/library";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Library · ChatUI" }];
}

/** Projects, and the chats in one (`/library/:projectId`). */
export default function Library({ params }: Route.ComponentProps) {
  return (
    <LibraryPage
      key={params.projectId ?? "all"}
      userId={useUserId()}
      projectId={params.projectId}
    />
  );
}
