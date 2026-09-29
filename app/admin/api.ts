import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type {
  AdminModelSettings,
  AdminProviderDto,
  AdminSettingsDto,
  AdminUserDto,
  AuditEntryDto,
} from "@shared/admin";
import type { ProviderModelsDto } from "@shared/generations";
import { apiJson } from "../lib/query";

/**
 * Admin data (Phase 10), loaded only in the lazy admin route. Keys live
 * under the admin's own user scope, so an account change purges them with
 * everything else (INV-55). The server authorizes every request (INV-24).
 */
export const adminKeys = {
  all: (userId: string) => ["user", userId, "admin"] as const,
  users: (userId: string) => ["user", userId, "admin", "users"] as const,
  providers: (userId: string) => ["user", userId, "admin", "providers"] as const,
  models: (userId: string) => ["user", userId, "admin", "models"] as const,
  settings: (userId: string) => ["user", userId, "admin", "settings"] as const,
  audit: (userId: string) => ["user", userId, "admin", "audit"] as const,
};

export const adminQueries = {
  users: (userId: string) =>
    queryOptions({
      queryKey: adminKeys.users(userId),
      queryFn: async ({ signal }) =>
        (await apiJson<{ users: AdminUserDto[] }>("/api/admin/users", { signal })).users,
    }),
  providers: (userId: string) =>
    queryOptions({
      queryKey: adminKeys.providers(userId),
      queryFn: async ({ signal }) =>
        (await apiJson<{ providers: AdminProviderDto[] }>("/api/admin/providers", { signal }))
          .providers,
    }),
  models: (userId: string) =>
    queryOptions({
      queryKey: adminKeys.models(userId),
      queryFn: ({ signal }) =>
        apiJson<{ providers: ProviderModelsDto[]; settings: AdminModelSettings[] }>(
          "/api/admin/models",
          { signal },
        ),
    }),
  settings: (userId: string) =>
    queryOptions({
      queryKey: adminKeys.settings(userId),
      queryFn: ({ signal }) => apiJson<AdminSettingsDto>("/api/admin/settings", { signal }),
    }),
  audit: (userId: string) =>
    queryOptions({
      queryKey: adminKeys.audit(userId),
      queryFn: async ({ signal }) =>
        (await apiJson<{ entries: AuditEntryDto[] }>("/api/admin/audit?limit=100", { signal }))
          .entries,
    }),
};

/** A mutation through the shared adapter (CSRF, expected user), then a refresh. */
export async function adminWrite<T>(
  client: QueryClient,
  userId: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
): Promise<T> {
  try {
    return await apiJson<T>(url, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } finally {
    // Every change is audited: refresh the admin data and the audit log.
    await client.invalidateQueries({ queryKey: adminKeys.all(userId) });
  }
}
