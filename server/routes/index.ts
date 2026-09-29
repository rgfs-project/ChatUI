import { erase, type AnyApiRoute } from "../registry.ts";
import {
  cancelGenerationRoute,
  getGenerationRoute,
  startGenerationRoute,
  streamGenerationRoute,
} from "./generations.ts";
import { healthRoute } from "./health.ts";
import { listModelsRoute } from "./models.ts";

/** The complete API route inventory. */
export const apiRoutes: readonly AnyApiRoute[] = [
  erase(healthRoute),
  erase(listModelsRoute),
  erase(startGenerationRoute),
  erase(getGenerationRoute),
  erase(cancelGenerationRoute),
  erase(streamGenerationRoute),
];
