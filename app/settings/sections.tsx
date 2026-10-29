import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Keyboard, Palette, Settings as SettingsIcon, UserRound } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { useNavigate } from "react-router";
import type { PreferencesDto } from "@shared/preferences";
import { useChat } from "../chat/chat-context";
import { ModelMenu } from "../chat/model-picker";
import { apiJson } from "../lib/api";
import { paths } from "../lib/paths";
import { qk } from "../lib/query/keys";
import { modelsQuery, preferencesQuery } from "../lib/query/queries";
import { useToast } from "../ui/toast";
import { appearanceRows } from "./appearance";
import { Row, type SettingsSection } from "./row";

function General() {
  const { userId, refreshModels } = useChat();
  const client = useQueryClient();
  const toast = useToast();
  const models = useQuery(modelsQuery(userId));
  const preferences = useQuery(preferencesQuery(userId));
  const prefs = preferences.data;
  const selected =
    prefs?.defaultProvider && prefs.defaultModel
      ? ([prefs.defaultProvider, prefs.defaultModel] as const)
      : null;
  return (
    <Row label="Default model" hint="Used for new chats until you pick another.">
      <ModelMenu
        label="Default model"
        triggerClassName="pill-button pill-select"
        groups={models.data ?? []}
        selected={selected}
        loading={models.isPending}
        extraOption="Last model I used"
        onRefresh={() => {
          void refreshModels();
        }}
        onSelect={(pair) => {
          void apiJson<PreferencesDto>("/api/preferences", {
            method: "PATCH",
            json: { defaultProvider: pair?.[0] ?? null, defaultModel: pair?.[1] ?? null },
          }).then(
            (updated) => {
              client.setQueryData(qk.preferences(userId), updated);
              toast("Default model saved.");
            },
            (error: unknown) => {
              toast(error instanceof Error ? error.message : "Could not save", "error");
            },
          );
        }}
      />
    </Row>
  );
}

function ChangePassword() {
  const navigate = useNavigate();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function changePassword(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setMessage(null);
    try {
      await apiJson("/api/auth/password", {
        method: "POST",
        json: { currentPassword: form.get("current"), newPassword: form.get("next") },
      });
      // Every session was revoked, including this one.
      await navigate(paths.login(), { replace: true });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not change the password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="settings-form" onSubmit={(event) => void changePassword(event)}>
        <h3 className="settings-subtitle">Change password</h3>
        <label htmlFor="current">Current password</label>
        <input
          id="current"
          name="current"
          type="password"
          className="text-field selectable"
          autoComplete="current-password"
          required
        />
        <label htmlFor="next">New password (at least 10 characters)</label>
        <input
          id="next"
          name="next"
          type="password"
          className="text-field selectable"
          autoComplete="new-password"
          minLength={10}
          required
        />
        <div className="dialog-actions">
          <button type="submit" className="pill-button pill-primary" disabled={busy}>
            Change password and sign out everywhere
          </button>
        </div>
        {message ? (
          <p className="form-error" role="alert">
            {message}
          </p>
        ) : null}
      </form>
    </>
  );
}

function Identity() {
  const { username, role } = useChat();
  return (
    <>
      <Row label="Username">
        <span className="settings-value">{username}</span>
      </Row>
      <Row label="Role">
        <span className="settings-value">{role === "admin" ? "Admin" : "Member"}</span>
      </Row>
    </>
  );
}

function LogOut() {
  const { logout } = useChat();
  return (
    <Row label="Log out on this device">
      <button
        type="button"
        className="pill-button"
        onClick={() => {
          void logout();
        }}
      >
        Log out
      </button>
    </Row>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Send message", "Enter"],
  ["New line", "Shift + Enter"],
  ["New chat", "Ctrl/⌘ + Shift + O"],
  ["Show or hide the sidebar", "Ctrl/⌘ + Shift + S"],
  ["Select the conversation", "Ctrl/⌘ + A"],
  ["Close a menu or dialog", "Esc"],
];

function Shortcut({ what, keys }: { what: string; keys: string }) {
  return (
    <Row label={what}>
      <kbd>{keys}</kbd>
    </Row>
  );
}

/** Every settings section; later phases add theirs here. */
export const SECTIONS: SettingsSection[] = [
  {
    id: "general",
    label: "General",
    icon: <SettingsIcon size={18} aria-hidden />,
    rows: [
      {
        id: "default-model",
        label: "Default model",
        keywords: "model provider new chat",
        render: () => <General />,
      },
    ],
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: <Palette size={18} aria-hidden />,
    rows: appearanceRows,
  },
  {
    id: "account",
    label: "Account",
    icon: <UserRound size={18} aria-hidden />,
    rows: [
      {
        id: "identity",
        label: "Username",
        keywords: "role account name",
        render: () => <Identity />,
      },
      {
        id: "password",
        label: "Change password",
        keywords: "password security login",
        render: () => <ChangePassword />,
      },
      { id: "logout", label: "Log out", keywords: "sign out", render: () => <LogOut /> },
    ],
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    icon: <Keyboard size={18} aria-hidden />,
    rows: SHORTCUTS.map(([what, keys]) => ({
      id: what,
      label: what,
      keywords: `shortcut keyboard ${keys}`,
      render: () => <Shortcut what={what} keys={keys} />,
    })),
  },
];
