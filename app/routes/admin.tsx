import { data } from "react-router";
import { Overlay } from "../components/Overlay";
import { appContext } from "../context";
import type { Route } from "./+types/admin";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Administration · ChatUI" }];
}

/** Reserved until Phase 10; the server decides who may see it (404 otherwise). */
export function loader({ context }: Route.LoaderArgs) {
  const { auth } = context.get(appContext);
  if (auth?.role !== "admin") throw data("Not found", { status: 404 });
  return null;
}

export default function AdminOverlay() {
  return (
    <Overlay title="Administration">
      <p>Administration (users, providers, model settings) arrives in a later release.</p>
    </Overlay>
  );
}
