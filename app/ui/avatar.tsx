import { useQuery } from "@tanstack/react-query";
import { profileQuery } from "../lib/query/queries";

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

export const photoUrl = (version: string) => `/api/profile/photo?v=${version}`;

/**
 * The signed-in user's picture in its chosen shape, or their initials. The
 * profile is dehydrated with the document, so the server renders the photo.
 */
export function Avatar({
  userId,
  username,
  size = "small",
}: {
  userId: string;
  username: string;
  size?: "small" | "large";
}) {
  const profile = useQuery(profileQuery(userId)).data;
  const version = profile?.photoVersion ?? null;
  return (
    <span
      className={`avatar shape-${profile?.shape ?? "circle"}${size === "large" ? " avatar-large" : ""}${version ? " has-photo" : ""}`}
      aria-hidden
      // Initials are drawn by CSS: the avatar is decoration inside a named
      // button, and real text would not match the button's name.
      {...(version ? {} : { "data-initials": initials(username) })}
    >
      {version ? (
        <img
          src={photoUrl(version)}
          alt=""
          width={size === "large" ? 96 : 24}
          height={size === "large" ? 96 : 24}
        />
      ) : null}
    </span>
  );
}
