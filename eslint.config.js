import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import { routeInventoryRestriction } from "./eslint.route-inventory.js";

export default defineConfig(
  globalIgnores([
    "build/",
    ".react-router/",
    "node_modules/",
    "data/",
    "test-results/",
    "playwright-report/",
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: ["app/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat["recommended-latest"]],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // React Router loaders throw `data()` responses to set HTTP status.
      "@typescript-eslint/only-throw-error": [
        "error",
        { allow: [{ from: "package", package: "react-router", name: "DataWithResponseInit" }] },
      ],
    },
  },
  {
    files: ["server/**/*.ts"],
    ignores: ["server/registry.ts"],
    rules: {
      "no-restricted-syntax": ["error", routeInventoryRestriction],
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
