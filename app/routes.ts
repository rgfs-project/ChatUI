import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("chat", "routes/chat.tsx"),
  route("login", "routes/login.tsx"),
  route("register", "routes/register.tsx"),
  route("account", "routes/account.tsx"),
] satisfies RouteConfig;
