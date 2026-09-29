import { erase, type AnyApiRoute } from "../registry.ts";
import {
  cancelGenerationRoute,
  getGenerationRoute,
  startGenerationRoute,
  streamGenerationRoute,
} from "./generations.ts";
import {
  createConversationRoute,
  deleteConversationRoute,
  getConversationRoute,
  listConversationsRoute,
  renameConversationRoute,
} from "./conversations.ts";
import { healthRoute } from "./health.ts";
import { getOperationRoute } from "./operations.ts";
import { listModelsRoute } from "./models.ts";

/** The complete API route inventory. */
export const apiRoutes: readonly AnyApiRoute[] = [
  erase(healthRoute),
  erase(listModelsRoute),
  erase(startGenerationRoute),
  erase(getGenerationRoute),
  erase(cancelGenerationRoute),
  erase(streamGenerationRoute),
  erase(getOperationRoute),
  erase(listConversationsRoute),
  erase(createConversationRoute),
  erase(getConversationRoute),
  erase(renameConversationRoute),
  erase(deleteConversationRoute),
];
