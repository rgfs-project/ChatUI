import { data } from "react-router";
import { AdminPanel } from "../admin/AdminPanel";
import { Overlay } from "../components/Overlay";
import { appContext } from "../context";
import type { Route } from "./+types/admin";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Administration · ChatUI" }];
}

/** The server decides who may see it (404 otherwise, never a hint that it exists). */
export function loader({ context }: Route.LoaderArgs) {
  const { auth } = context.get(appContext);
  if (auth?.role !== "admin") throw data("Not found", { status: 404 });
  return null;
}

/** The admin overlay: its own lazy route chunk, never part of chat startup. */
export default function AdminOverlay() {
  return (
    <Overlay title="Administration" wide>
      <AdminPanel />
    </Overlay>
  );
}
