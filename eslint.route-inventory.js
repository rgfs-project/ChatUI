/**
 * Route inventory rule (contracts §5): API routes are registered only through
 * server/registry.ts. A literal-path registration anywhere else in server/ is a
 * bypass. Shared by eslint.config.js and tests/server/registry.test.ts.
 */
export const routeInventoryRestriction = {
  selector:
    "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(get|post|put|patch|delete|options|head|all|route)$/][arguments.0.type='Literal'][arguments.0.value=/^\\//]",
  message: "Register API routes through server/registry.ts (defineRoute).",
};

/**
 * DTO rule (Phase 16, INV-03): JSON responses are written only by the
 * registry (through each route's response schema) and by the error contract,
 * so no handler can send an internal record as it is.
 */
export const dtoRestriction = {
  selector:
    "CallExpression[callee.type='MemberExpression'][callee.property.name='json'][arguments.length>0]:not([callee.object.name='express'])",
  message:
    "Return a DTO from a registry route (its response schema writes it); never res.json() an internal record.",
};
