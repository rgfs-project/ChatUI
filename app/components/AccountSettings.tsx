import * as Menu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Pencil, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import {
  ACCOUNT_LIMITS,
  AVATAR_COLOR_NAMES,
  AVATAR_COLORS,
  type AccountDto,
  type AvatarColor,
  type UpdateAccount,
} from "@shared/account";
import { apiFetch } from "../lib/api";
import { authStore } from "../lib/auth-store";
import { ApiError, apiJson, queries, queryKeys } from "../lib/query";
import { useSignOut } from "../lib/use-sign-out";
import { displayNameOf, ProfileAvatar } from "./AccountLabel";
import { PasswordDialog, TextDialog } from "./Dialogs";

const COLOR_LABEL: Record<AvatarColor, string> = {
  black: "Black",
  blue: "Blue",
  green: "Green",
  amber: "Amber",
  red: "Red",
  purple: "Purple",
  pink: "Pink",
};

/** Center-crops and shrinks a photo in the browser, so only a small square is uploaded. */
async function squarePhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const edge = Math.min(ACCOUNT_LIMITS.photoEdge, side);
  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser can’t prepare the photo.");
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    edge,
    edge,
  );
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/webp", 0.9);
  });
  if (blob?.type === "image/webp") return blob;
  // No WebP encoder (older Safari): PNG instead.
  const png = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (!png) throw new Error("This browser can’t prepare the photo.");
  return png;
}

type Editing = "displayName" | "username" | "email" | "password" | null;

/**
 * Settings → Account: the profile (photo or coloured initials, display name,
 * username, email) and the password. Loaded with its section.
 */
export default function AccountSettings({ userId }: { userId: string }) {
  const client = useQueryClient();
  const account = useQuery(queries.account(userId));
  const signOut = useSignOut();
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const a = account.data;

  const settle = (dto: AccountDto) => {
    client.setQueryData(queryKeys.account(userId), dto);
    // The sidebar shows the name and photo; a new username is the session's too.
    authStore.updateProfile(dto);
  };
  const update = useMutation({
    mutationFn: (patch: UpdateAccount) =>
      apiJson<AccountDto>("/api/account", { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (dto) => {
      setError(null);
      settle(dto);
    },
    onError: (e) => {
      setError(e instanceof ApiError ? e.message : "The change couldn’t be saved.");
    },
  });
  const photo = useMutation({
    mutationFn: async (file: File | null) => {
      if (!file) return apiJson<AccountDto>("/api/account/photo", { method: "DELETE" });
      const blob = await squarePhoto(file);
      const response = await apiFetch("/api/account/photo", {
        method: "PUT",
        headers: { "Content-Type": blob.type, Accept: "application/json" },
        body: blob,
      });
      const body = (await response.json().catch(() => null)) as
        (AccountDto & { error?: { message?: string } }) | null;
      if (!response.ok || !body)
        throw new Error(body?.error?.message ?? "The photo couldn’t be saved.");
      return body;
    },
    onSuccess: (dto) => {
      setError(null);
      settle(dto);
    },
    onError: (e) => {
      setError(e instanceof Error ? e.message : "The photo couldn’t be saved.");
    },
  });

  if (account.isPending)
    return (
      <>
        <h1 className="page-title">Account</h1>
        <p className="hint">Loading…</p>
      </>
    );
  if (!a)
    return (
      <>
        <h1 className="page-title">Account</h1>
        <div className="alert danger" role="alert">
          <span className="alert-text">Your account couldn’t be loaded.</span>
          <button type="button" className="btn" onClick={() => void account.refetch()}>
            Try again
          </button>
        </div>
      </>
    );

  const name = displayNameOf(a);
  const row = (key: Exclude<Editing, null>, label: string, value: string) => (
    <button
      type="button"
      className="row"
      aria-haspopup="dialog"
      aria-label={`${label}: ${value}`}
      onClick={() => {
        setEditing(key);
      }}
    >
      <span className="row-label">{label}</span>
      <span className="row-value">
        {value}
        <ChevronRight size={16} aria-hidden />
      </span>
    </button>
  );

  return (
    <>
      <h1 className="page-title">Account</h1>
      <section className="group">
        <div className="row profile-row">
          <div className="profile-photo">
            <ProfileAvatar user={a} className="lg" />
            <Menu.Root modal={false}>
              <Menu.Trigger
                className="photo-edit"
                aria-label="Edit profile picture"
                title="Edit profile picture"
              >
                <Pencil size={14} aria-hidden />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content
                  className="menu wide photo-menu"
                  align="start"
                  sideOffset={8}
                  collisionPadding={8}
                >
                  <Menu.Item
                    className="menu-item"
                    onSelect={() => {
                      fileRef.current?.click();
                    }}
                  >
                    <Upload size={20} aria-hidden /> Upload photo
                  </Menu.Item>
                  <Menu.Item
                    className="menu-item"
                    disabled={!a.photoVersion}
                    onSelect={() => {
                      photo.mutate(null);
                    }}
                  >
                    <Trash2 size={20} aria-hidden /> Remove photo
                  </Menu.Item>
                  <Menu.Separator className="menu-separator" />
                  <Menu.Label className="menu-label">Initials colour</Menu.Label>
                  <Menu.RadioGroup
                    className="swatches"
                    value={a.avatarColor}
                    onValueChange={(value) => {
                      update.mutate({ avatarColor: value as AvatarColor });
                    }}
                  >
                    {AVATAR_COLOR_NAMES.map((color) => (
                      <Menu.RadioItem
                        key={color}
                        value={color}
                        className="swatch"
                        aria-label={COLOR_LABEL[color]}
                        style={{ background: AVATAR_COLORS[color] }}
                        onSelect={(event) => {
                          // Keep the menu open to compare colours.
                          event.preventDefault();
                        }}
                      >
                        <Menu.ItemIndicator>
                          <Check size={14} aria-hidden />
                        </Menu.ItemIndicator>
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              tabIndex={-1}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) photo.mutate(file);
              }}
            />
          </div>
          <div className="row-text grow">
            <span className="row-label profile-name">{name}</span>
            <span className="row-hint">{a.role === "admin" ? "Administrator" : "Member"}</span>
          </div>
        </div>
        {row("displayName", "Display name", a.displayName ?? "Not set")}
        {row("username", "Username", a.username)}
        {row("email", "Email", a.email ?? "Not set")}
        {row("password", "Password", "••••••••")}
      </section>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="group">
        <div className="row">
          <span className="row-label">Sign out on this device</span>
          <button type="button" className="btn sm" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </section>

      <TextDialog
        key={`display-${a.displayName ?? ""}`}
        open={editing === "displayName"}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title="Display name"
        description="Shown in the sidebar instead of your username."
        label="Display name"
        initial={a.displayName ?? ""}
        submitLabel="Save"
        maxLength={ACCOUNT_LIMITS.displayName}
        allowEmpty
        onSubmit={(value) => {
          update.mutate({ displayName: value === "" ? null : value });
        }}
      />
      <TextDialog
        key={`username-${a.username}`}
        open={editing === "username"}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title="Username"
        description="What you sign in with: 3–32 lowercase letters, digits, dots, dashes or underscores."
        label="Username"
        initial={a.username}
        submitLabel="Save"
        maxLength={32}
        onSubmit={(value) => {
          update.mutate({ username: value });
        }}
      />
      <TextDialog
        key={`email-${a.email ?? ""}`}
        open={editing === "email"}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title="Email"
        description="For your records; ChatUI doesn’t send email."
        label="Email"
        type="email"
        initial={a.email ?? ""}
        submitLabel="Save"
        maxLength={ACCOUNT_LIMITS.email}
        allowEmpty
        onSubmit={(value) => {
          update.mutate({ email: value });
        }}
      />
      <PasswordDialog
        open={editing === "password"}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        // The change ended every session; leave the way signing out does.
        onChanged={() => void signOut()}
      />
    </>
  );
}
