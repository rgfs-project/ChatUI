import { useLocation, useNavigate, useSearchParams } from "react-router";
import { ChatView } from "../components/ChatView";
import { paths } from "../lib/paths";
import { useShell } from "../lib/shell";
import { SettingsDialog } from "../settings/Settings";
import type { Route } from "./+types/settings";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Settings · ChatUI" }];
}

/** Settings open over the chat the reader came from (or a new one). */
export default function SettingsRoute() {
  const shell = useShell();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const background = (location.state as { background?: string } | null | undefined)?.background;
  const segment = background?.startsWith("/chat/")
    ? decodeURIComponent(background.slice(6))
    : undefined;
  const behind = segment && segment !== "new" ? segment : undefined;

  return (
    <>
      <ChatView key={behind ?? "new"} conversationId={behind} inert />
      <SettingsDialog
        user={shell.user}
        section={params.get("section")}
        narrow={shell.narrow}
        onSection={(id) => {
          void navigate(paths.settings(id ?? undefined), {
            replace: true,
            state: location.state as unknown,
          });
        }}
        onClose={() => {
          void navigate(background ?? paths.newChat());
        }}
      />
    </>
  );
}
