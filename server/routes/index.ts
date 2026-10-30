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
import {
  changePasswordRoute,
  loginRoute,
  logoutRoute,
  registerRoute,
  sessionRoute,
} from "./auth.ts";
import { healthRoute } from "./health.ts";
import { getPreferencesRoute, updatePreferencesRoute } from "./preferences.ts";
import { getOperationRoute } from "./operations.ts";
import { listModelsRoute, listProvidersRoute } from "./models.ts";
import {
  adminAuditRoute,
  adminCreateProviderRoute,
  adminCreateUserRoute,
  adminDeleteProviderRoute,
  adminDeleteUserRoute,
  adminGetSettingsRoute,
  adminListModelsRoute,
  adminListProvidersRoute,
  adminListUsersRoute,
  adminRebuildIndexRoute,
  adminRefreshModelsRoute,
  adminSetPasswordRoute,
  adminTestProviderRoute,
  adminUpdateModelRoute,
  adminUpdateProviderRoute,
  adminUpdateSettingsRoute,
  adminUpdateUserRoute,
  instanceRoute,
} from "./admin.ts";

/** The complete API route inventory. */
export const apiRoutes: readonly AnyApiRoute[] = [
  erase(healthRoute),
  erase(sessionRoute),
  erase(loginRoute),
  erase(registerRoute),
  erase(logoutRoute),
  erase(changePasswordRoute),
  erase(getPreferencesRoute),
  erase(updatePreferencesRoute),
  erase(listProvidersRoute),
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
  erase(instanceRoute),
  erase(adminListUsersRoute),
  erase(adminCreateUserRoute),
  erase(adminUpdateUserRoute),
  erase(adminSetPasswordRoute),
  erase(adminDeleteUserRoute),
  erase(adminListProvidersRoute),
  erase(adminCreateProviderRoute),
  erase(adminUpdateProviderRoute),
  erase(adminDeleteProviderRoute),
  erase(adminTestProviderRoute),
  erase(adminListModelsRoute),
  erase(adminUpdateModelRoute),
  erase(adminRefreshModelsRoute),
  erase(adminGetSettingsRoute),
  erase(adminUpdateSettingsRoute),
  erase(adminRebuildIndexRoute),
  erase(adminAuditRoute),
];
