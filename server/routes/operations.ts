import { z } from "zod";
import { operationResultSchema } from "@shared/conversations";
import { ErrorCode } from "@shared/errors";
import { AppError } from "../errors.ts";
import { defineRoute } from "../registry.ts";

/** The owner's committed result for an operation key, else 404 (contracts §4.1). */
export const getOperationRoute = defineRoute({
  method: "get",
  path: "/api/operations/:operationKey",
  auth: "public",
  csrf: "none",
  availability: "chat-demo",
  request: { params: z.strictObject({ operationKey: z.uuid() }) },
  response: operationResultSchema,
  handler: async ({ params }, { services }) => {
    const record = await services.operations.read(services.userId, params.operationKey);
    if (record?.status !== "committed")
      throw new AppError(ErrorCode.NOT_FOUND, "No committed send with this key");
    return {
      conversationId: record.conversationId,
      generationId: record.generationId,
      userMessageId: record.userMessageId,
      assistantMessageId: record.assistantMessageId,
    };
  },
  fixture: { params: { operationKey: "00000000-0000-4000-8000-000000000000" }, expectStatus: 404 },
});
