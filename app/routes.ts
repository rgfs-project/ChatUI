import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  // `/` redirects into the app or to sign-in; the public status page is /status.
  index("routes/root-redirect.tsx"),
  route("status", "routes/home.tsx"),
  route("login", "routes/login.tsx"),
  route("register", "routes/register.tsx"),
  route("account", "routes/account.tsx"),
  // One guarded, persistent shell for every protected route, including the
  // catch-all (INV-53).
  layout("routes/app-layout.tsx", [
    route("chat", "routes/chat-index.tsx"),
    route("chat/new", "routes/chat-new.tsx"),
    route("chat/:conversationId", "routes/chat-conversation.tsx"),
    route("settings", "routes/settings.tsx"),
    route("admin", "routes/admin.tsx"),
    route("*", "routes/not-found.tsx"),
  ]),
] satisfies RouteConfig;
