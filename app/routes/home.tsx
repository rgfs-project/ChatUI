import { useState, useSyncExternalStore } from "react";
import type { HealthDto } from "@shared/api";
import { appContext } from "../context";
import type { Route } from "./+types/home";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Status · ChatUI" }, { name: "description", content: "ChatUI server status" }];
}

export function loader({ context }: Route.LoaderArgs) {
  const { services, auth } = context.get(appContext);
  return { health: services.health(), signedIn: auth !== null };
}

function isHealth(value: unknown): value is HealthDto {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === "ok" &&
    typeof (value as { version?: unknown }).version === "string"
  );
}

const noSubscribe = () => () => undefined;

/** The public status page. */
export default function Status({ loaderData }: Route.ComponentProps) {
  const [health, setHealth] = useState(loaderData.health);
  const hydrated = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  const [state, setState] = useState<"idle" | "checking" | "failed">("idle");

  async function recheck() {
    setState("checking");
    try {
      const response = await fetch("/api/health", { headers: { Accept: "application/json" } });
      const body: unknown = await response.json();
      if (!response.ok || !isHealth(body)) throw new Error("bad health");
      setHealth(body);
      setState("idle");
    } catch {
      setState("failed");
    }
  }

  return (
    <main className="center-page">
      <div className="center-card">
        <h1>ChatUI</h1>
        <h2 className="muted">Server status</h2>
        <div className="group">
          <div className="row">
            <span>Server</span>
            <span data-testid="health-status">{health.status.toUpperCase()}</span>
          </div>
          <div className="row">
            <span>Version</span>
            <span data-testid="health-version">{health.version}</span>
          </div>
          <div className="row">
            <span>Page</span>
            <span data-testid="hydration-state">{hydrated ? "Interactive" : "Loading"}</span>
          </div>
        </div>
        {state === "failed" ? (
          <p className="error" role="alert">
            The server didn’t answer.
          </p>
        ) : null}
        <div className="actions">
          <button
            type="button"
            className="button"
            disabled={!hydrated || state === "checking"}
            onClick={() => void recheck()}
          >
            Check status again
          </button>
          <a className="button primary" href={loaderData.signedIn ? "/chat" : "/login"}>
            {loaderData.signedIn ? "Open your chats" : "Sign in"}
          </a>
        </div>
      </div>
    </main>
  );
}
