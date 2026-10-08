import { apiFetch } from "./api";

/** Ends the session on the server, then leaves with a full page load (no cached state survives). */
export async function signOut() {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } finally {
    window.location.assign("/login");
  }
}
