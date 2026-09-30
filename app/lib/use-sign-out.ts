import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { apiFetch } from "./api";
import { paths } from "./paths";

/** Signs out, drops every cached query (INV-55) and goes to sign-in. */
export function useSignOut(): () => Promise<void> {
  const client = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    client.clear();
    await navigate(paths.login(), { replace: true });
  };
}
