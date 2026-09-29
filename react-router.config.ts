import type { Config } from "@react-router/dev/config";

export default {
  appDirectory: "app",
  // Framework Mode runtime SSR from the first commit (contracts §9.2). SPA mode is not allowed.
  ssr: true,
} satisfies Config;
