import { erase, type AnyApiRoute } from "../registry.ts";
import { healthRoute } from "./health.ts";

/** The complete API route inventory. */
export const apiRoutes: readonly AnyApiRoute[] = [erase(healthRoute)];
