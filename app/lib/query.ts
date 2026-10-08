import { QueryClient, useQuery, type QueryKey } from "@tanstack/react-query";
import type { ConversationDto, ConversationList } from "@shared/conversations";
import type { ModelListDto } from "@shared/generations";
import type { SkillDto } from "@shared/skills";
import type { AttachmentLimitsDto } from "@shared/attachments";
import { api, ApiError } from "./api";

export interface Preferences {
  pins: string[];
  defaultProvider: string | null;
  defaultModel: string | null;
  historyImages: "include" | "omit" | null;
  imageMaxEdge: number | null;
}

/** Every key starts with the user id, so one account never reads another's cache. */
export const keys = {
  user: (userId: string) => ["user", userId] as const,
  conversations: (userId: string) => ["user", userId, "conversations"] as const,
  conversation: (userId: string, id: string) => ["user", userId, "conversation", id] as const,
  models: (userId: string) => ["user", userId, "models"] as const,
  preferences: (userId: string) => ["user", userId, "preferences"] as const,
  skills: (userId: string) => ["user", userId, "skills"] as const,
  memories: (userId: string) => ["user", userId, "memories"] as const,
  artifacts: (userId: string) => ["user", userId, "artifacts"] as const,
  attachmentLimits: (userId: string) => ["user", userId, "attachment-limits"] as const,
  admin: (userId: string, what: string) => ["user", userId, "admin", what] as const,
};

/** Queries the server may render into the first HTML (browser-safe, user-scoped). */
export function isDehydratable(key: QueryKey): boolean {
  return key[0] === "user" && (key[2] === "models" || key[2] === "conversation");
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (count, error) =>
          count < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      },
    },
  });
}

let browserClient: QueryClient | undefined;

/** One client per page in the browser; a fresh one per request on the server. */
export function getQueryClient(): QueryClient {
  if (typeof window === "undefined") return createQueryClient();
  browserClient ??= createQueryClient();
  return browserClient;
}

export const fetchConversation = (id: string, signal?: AbortSignal) =>
  api<ConversationDto>(`/api/conversations/${encodeURIComponent(id)}`, signal ? { signal } : {});

export function useConversations(userId: string) {
  return useQuery({
    queryKey: keys.conversations(userId),
    queryFn: ({ signal }) => api<ConversationList>("/api/conversations", { signal }),
  });
}

export function useConversation(userId: string, id: string | undefined) {
  return useQuery({
    queryKey: keys.conversation(userId, id ?? ""),
    queryFn: ({ signal }) => fetchConversation(id ?? "", signal),
    enabled: Boolean(id),
  });
}

export function useModels(userId: string) {
  return useQuery({
    queryKey: keys.models(userId),
    queryFn: ({ signal }) => api<ModelListDto>("/api/models", { signal }),
    staleTime: 60_000,
  });
}

export function usePreferences(userId: string) {
  return useQuery({
    queryKey: keys.preferences(userId),
    queryFn: ({ signal }) => api<Preferences>("/api/preferences", { signal }),
  });
}

export function useSkills(userId: string) {
  return useQuery({
    queryKey: keys.skills(userId),
    queryFn: ({ signal }) => api<{ skills: SkillDto[] }>("/api/skills", { signal }),
    select: (data) => data.skills,
  });
}

export function useAttachmentLimits(userId: string) {
  return useQuery({
    queryKey: keys.attachmentLimits(userId),
    queryFn: ({ signal }) => api<AttachmentLimitsDto>("/api/attachments/limits", { signal }),
  });
}
