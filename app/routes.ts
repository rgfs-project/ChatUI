import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/index.tsx"),
  route("status", "routes/status.tsx"),
  route("login", "routes/login.tsx"),
  route("register", "routes/register.tsx"),
  // Old addresses redirect to their central paths.
  route("chat", "routes/chat-redirect.tsx"),
  route("account", "routes/account-redirect.tsx"),
  // Every protected route, including the catch-all, shares the layout's auth guard (INV-53).
  layout("routes/app-layout.tsx", [
    route("chat/new", "routes/chat-new.tsx"),
    route("chat/:conversationId", "routes/chat-conversation.tsx"),
    route("settings/:section?", "routes/settings.tsx"),
    route("admin", "routes/admin.tsx"),
    route("*", "routes/not-found.tsx"),
  ]),
] satisfies RouteConfig;
