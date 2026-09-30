import type { AttachmentDto } from "@shared/attachments";
import type { StartGenerationResponse } from "@shared/generations";
import { AccountChangedError, SessionExpiredError } from "./api";
import { authStore } from "./auth-store";
import { ApiError, apiJson } from "./query";

/**
 * Sends (contracts §4.1 client rules). A send is a TanStack mutation whose
 * variables carry the client-temporary message id and the operation key; the
 * optimistic message is rendered from mutation state, so there is no second
 * source of truth. Outcomes:
 * - a contract error other than INTERNAL → rejected: roll back with the error;
 * - INTERNAL, no response, a network error or a non-contract response →
 *   unknown: resend the identical request with the same key (bounded);
 * - OPERATION_EXPIRED or exhausted retries → "outcome unknown";
 * - an account change or expiry → discarded, never re-sent as someone else.
 * A new key is never minted for an unresolved send.
 */
export interface SendVariables {
  userId: string;
  /** Authentication epoch at send time. */
  epoch: number;
  /** The conversation id, or the draft key for /chat/new. */
  conversationKey: string;
  conversationId?: string;
  providerId: string;
  model: string;
  content: string;
  /** Uploaded, pending attachments sent with the message (Phase 12). */
  attachments?: AttachmentDto[];
  operationKey: string;
  operationIssuedAt: string;
  /** Client-temporary id of the optimistic user message. */
  tempId: string;
}

export class SendRejectedError extends Error {
  override name = "SendRejectedError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class SendUnknownError extends Error {
  override name = "SendUnknownError";
  readonly reason: "expired" | "exhausted";
  constructor(reason: "expired" | "exhausted") {
    super(
      reason === "expired"
        ? "This send is too old to confirm."
        : "The outcome of this send is unknown.",
    );
    this.reason = reason;
  }
}

/** Resends after an unknown outcome (the first attempt is not counted). */
export const SEND_RETRIES = 3;

/** Backoff between resends (1 s, 2 s, 3 s); tests shorten it. */
export const sendTiming = { baseMs: 1_000, retries: SEND_RETRIES };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function newSendVariables(
  fields: Omit<SendVariables, "epoch" | "operationKey" | "operationIssuedAt" | "tempId">,
): SendVariables {
  return {
    ...fields,
    epoch: authStore.get().epoch,
    operationKey: crypto.randomUUID(),
    operationIssuedAt: new Date().toISOString(),
    tempId: `temp-${crypto.randomUUID()}`,
  };
}

function stillCurrent(vars: SendVariables): boolean {
  const auth = authStore.get();
  return (
    auth.status === "authenticated" &&
    auth.epoch === vars.epoch &&
    auth.session?.user?.id === vars.userId
  );
}

export async function sendWithRetries(vars: SendVariables): Promise<StartGenerationResponse> {
  // Identical bytes on every attempt: the server compares payload hashes.
  const body = JSON.stringify({
    ...(vars.conversationId ? { conversationId: vars.conversationId } : {}),
    providerId: vars.providerId,
    model: vars.model,
    content: vars.content,
    operationKey: vars.operationKey,
    operationIssuedAt: vars.operationIssuedAt,
    ...(vars.attachments?.length ? { attachmentIds: vars.attachments.map((a) => a.id) } : {}),
  });
  for (let attempt = 0; ; attempt++) {
    if (!stillCurrent(vars)) throw new AccountChangedError("The signed-in account changed");
    try {
      return await apiJson<StartGenerationResponse>("/api/generations", {
        method: "POST",
        body,
        isCurrent: () => stillCurrent(vars),
      });
    } catch (error) {
      if (error instanceof AccountChangedError) throw error;
      // A 401 is answered before acceptance: nothing was saved.
      if (error instanceof SessionExpiredError)
        throw new SendRejectedError("UNAUTHENTICATED", "Your session ended. Sign in to send.");
      if (error instanceof ApiError && error.code === "OPERATION_EXPIRED")
        throw new SendUnknownError("expired");
      if (error instanceof ApiError && error.code && error.code !== "INTERNAL")
        throw new SendRejectedError(error.code, error.message);
      // Otherwise the outcome is unknown: fall through and resend.
    }
    if (attempt >= sendTiming.retries) throw new SendUnknownError("exhausted");
    await sleep(sendTiming.baseMs * (attempt + 1));
  }
}

/** Looks up an unresolved send by its key (contracts §4.1): the result, or null. */
export async function lookUpOperation(
  operationKey: string,
): Promise<StartGenerationResponse | null> {
  try {
    return await apiJson<StartGenerationResponse>(
      `/api/operations/${encodeURIComponent(operationKey)}`,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
