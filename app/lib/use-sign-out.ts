import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { apiFetch } from "./api";
import { authStore } from "./auth-store";
import { paths } from "./paths";

/**
 * Signs out: leaves the shell first (which discards tab-memory drafts and the
 * queue), then marks the tab signed out and drops every cached query (INV-55).
 */
export function useSignOut(): () => Promise<void> {
  const client = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    await navigate(paths.login(), { replace: true });
    authStore.signedOut();
    client.clear();
  };
}
