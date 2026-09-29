import { useState, useSyncExternalStore } from "react";
import type { HealthDto } from "@shared/api";
import { appContext } from "../context";
import type { Route } from "./+types/home";

export function meta(): Route.MetaDescriptors {
  return [{ title: "ChatUI · Status" }, { name: "description", content: "ChatUI server status" }];
}

/** Uses the internal health service directly, never an HTTP self-call. */
export function loader({ context }: Route.LoaderArgs): { health: HealthDto; chatDemo: boolean } {
  const { services } = context.get(appContext);
  return { health: services.health(), chatDemo: services.chatDemoEnabled };
}

/** Lightweight guard: keeps the schema library out of the client bundle. */
function isHealthDto(value: unknown): value is HealthDto {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "ok" &&
    "version" in value &&
    typeof value.version === "string"
  );
}

const noopSubscribe = () => () => undefined;

/** false during SSR and hydration, true once React has hydrated on the client. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

type CheckState = { kind: "idle" } | { kind: "checking" } | { kind: "failed" };

export default function Home({ loaderData }: Route.ComponentProps) {
  const [health, setHealth] = useState<HealthDto>(loaderData.health);
  const hydrated = useHydrated();
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });

  async function recheck() {
    setCheck({ kind: "checking" });
    try {
      const response = await fetch("/api/health", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const body: unknown = await response.json();
      if (!isHealthDto(body)) throw new Error("Unexpected health response");
      setHealth(body);
      setCheck({ kind: "idle" });
    } catch {
      setCheck({ kind: "failed" });
    }
  }

  return (
    <main className="page">
      <h1>ChatUI</h1>
      <p className="lede">Self-hosted AI chat. This page reports the server status.</p>
      <dl className="status">
        <dt>Server</dt>
        <dd data-testid="health-status">{health.status.toUpperCase()}</dd>
        <dt>Version</dt>
        <dd data-testid="health-version">{health.version}</dd>
        <dt>Page</dt>
        <dd data-testid="hydration-state">
          {hydrated ? "Interactive" : "Server-rendered (JavaScript not yet active)"}
        </dd>
      </dl>
      <p>
        <button
          type="button"
          onClick={() => void recheck()}
          disabled={!hydrated || check.kind === "checking"}
        >
          {check.kind === "checking" ? "Checking…" : "Check again"}
        </button>{" "}
        <span role="status" aria-live="polite" data-testid="check-result">
          {check.kind === "failed" ? "The server could not be reached." : ""}
        </span>
      </p>
      {loaderData.chatDemo ? (
        <p>
          <a href="/chat">Open the local chat demo</a> (this computer only; nothing is saved).
        </p>
      ) : null}
    </main>
  );
}
