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
