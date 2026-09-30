import { erase, type AnyApiRoute } from "../registry.ts";
import {
  cancelGenerationRoute,
  getGenerationRoute,
  startGenerationRoute,
  streamGenerationRoute,
} from "./generations.ts";
import {
  clearHistoryRoute,
  createConversationRoute,
  deleteConversationRoute,
  deleteExchangeRoute,
  editMessageRoute,
  getConversationRoute,
  listConversationsRoute,
  pinConversationRoute,
  regenerateRoute,
  renameConversationRoute,
  searchRoute,
  unpinConversationRoute,
} from "./conversations.ts";
import {
  changePasswordRoute,
  loginRoute,
  logoutRoute,
  registerRoute,
  sessionRoute,
} from "./auth.ts";
import { healthRoute } from "./health.ts";
import {
  attachmentContentRoute,
  attachmentLimitsRoute,
  deleteAttachmentRoute,
  getAttachmentRoute,
  uploadAttachmentRoute,
} from "./attachments.ts";
import { getPreferencesRoute, updatePreferencesRoute } from "./preferences.ts";
import {
  acceptProposalRoute,
  createMemoryRoute,
  deleteMemoryRoute,
  listMemoriesRoute,
  listProposalsRoute,
  rejectProposalRoute,
  updateMemoryRoute,
} from "./memories.ts";
import { getOperationRoute } from "./operations.ts";
import { createSkillRoute, deleteSkillRoute, listSkillsRoute, updateSkillRoute } from "./skills.ts";
import { listModelsRoute, listProvidersRoute } from "./models.ts";
import {
  adminAuditRoute,
  adminCreateProviderRoute,
  adminCreateUserRoute,
  adminDeleteProviderRoute,
  adminDeleteUserRoute,
  adminGetSettingsRoute,
  adminGetUserRoute,
  adminListModelsRoute,
  adminListProvidersRoute,
  adminListUsersRoute,
  adminModelSettingsRoute,
  adminRebuildIndexRoute,
  adminSetPasswordRoute,
  adminTestProviderRoute,
  adminUpdateProviderRoute,
  adminUpdateSettingsRoute,
  adminUpdateUserRoute,
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
  // Conversation operations (Phase 13a).
  erase(clearHistoryRoute),
  erase(editMessageRoute),
  erase(deleteExchangeRoute),
  erase(regenerateRoute),
  erase(pinConversationRoute),
  erase(unpinConversationRoute),
  erase(searchRoute),
  // Approved memories and proposals (Phase 13b).
  erase(listMemoriesRoute),
  erase(createMemoryRoute),
  erase(updateMemoryRoute),
  erase(deleteMemoryRoute),
  erase(listProposalsRoute),
  erase(acceptProposalRoute),
  erase(rejectProposalRoute),
  // Attachments (Phase 12). The literal /limits path is registered before /:id.
  erase(uploadAttachmentRoute),
  erase(attachmentLimitsRoute),
  erase(getAttachmentRoute),
  erase(attachmentContentRoute),
  erase(deleteAttachmentRoute),
  // Skills (user request, Phase 10).
  erase(listSkillsRoute),
  erase(createSkillRoute),
  erase(updateSkillRoute),
  erase(deleteSkillRoute),
  // Phase 10 administration (registry `admin` policy on every route).
  erase(adminListUsersRoute),
  erase(adminGetUserRoute),
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
  erase(adminModelSettingsRoute),
  erase(adminGetSettingsRoute),
  erase(adminUpdateSettingsRoute),
  erase(adminRebuildIndexRoute),
  erase(adminAuditRoute),
];
