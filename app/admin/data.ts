import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { apiJson } from "../lib/api";
import { useToast } from "../ui/toast";

/** Admin data is user-scoped like everything else and purged on account change. */
export const adminKey = (userId: string, resource: string) =>
  ["u", userId, "admin", resource] as const;

export function useAdminQuery<T>(userId: string, resource: string, url: string) {
  return useQuery({
    queryKey: adminKey(userId, resource),
    queryFn: ({ signal }) => apiJson<T>(url, { signal }),
  });
}

/** Runs an admin mutation, toasts the outcome and refreshes the named resources. */
export function useAdminAction(userId: string) {
  const client = useQueryClient();
  const toast = useToast();
  return useCallback(
    async <T>(
      run: () => Promise<T>,
      options: { done?: string; refresh: string[] },
    ): Promise<T | null> => {
      try {
        const result = await run();
        if (options.done) toast(options.done);
        return result;
      } catch (error) {
        toast(error instanceof Error ? error.message : "That did not work", "error");
        return null;
      } finally {
        for (const resource of options.refresh)
          void client.invalidateQueries({ queryKey: adminKey(userId, resource) });
      }
    },
    [client, toast, userId],
  );
}

/** A text field's value (file fields and absent fields read as ""). */
export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
