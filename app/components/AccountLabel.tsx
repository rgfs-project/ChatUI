import type { ReactNode } from "react";
import { AVATAR_COLORS, isAvatarColor, photoUrl } from "@shared/avatar";

/** The initial in a circle (or whatever is passed instead). */
export function Avatar(props: { name: string; className?: string; children?: ReactNode }) {
  return (
    <span className={`avatar${props.className ? ` ${props.className}` : ""}`} aria-hidden>
      {props.children ?? (props.name.at(0) ?? "?").toUpperCase()}
    </span>
  );
}

/** The name to show: the display name when one is set, else the username. */
export function displayNameOf(user: {
  username: string;
  displayName?: string | null | undefined;
}): string {
  // An empty or blank display name falls back too (?? would keep "").
  const display = user.displayName?.trim() ?? "";
  return display === "" ? user.username : display;
}

export interface ProfileUser {
  id: string;
  username: string;
  displayName?: string | null | undefined;
  avatarColor?: string | undefined;
  photoVersion?: string | null | undefined;
}

/** A user's photo, else their initial in their colour. */
export function ProfileAvatar({ user, className }: { user: ProfileUser; className?: string }) {
  const name = displayNameOf(user);
  if (user.photoVersion)
    return (
      <Avatar name={name} className={className}>
        <img src={photoUrl(user.id, user.photoVersion)} alt="" />
      </Avatar>
    );
  const color =
    isAvatarColor(user.avatarColor) && user.avatarColor !== "black" ? user.avatarColor : null;
  return (
    <span
      className={`avatar${color ? " tinted" : ""}${className ? ` ${className}` : ""}`}
      aria-hidden
      style={color ? { background: AVATAR_COLORS[color] } : undefined}
    >
      {(name.at(0) ?? "?").toUpperCase()}
    </span>
  );
}

/** Avatar and name: the account row and its placeholder share it. */
export function AccountLabel({ user }: { user: ProfileUser }) {
  return (
    <>
      <ProfileAvatar user={user} />
      <span className="label" data-testid="signed-in-user">
        {displayNameOf(user)}
      </span>
    </>
  );
}
