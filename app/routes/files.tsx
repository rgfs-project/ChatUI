import { FilesPage } from "../components/FilesPage";
import { useUserId } from "../lib/auth-store";
import type { Route } from "./+types/files";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Files · ChatUI" }];
}

/** Every file you have on the server: uploads and files replies produced. */
export default function Files() {
  return <FilesPage userId={useUserId()} />;
}
