/** What changed, newest first: shown in Help → Release notes. */
export interface ReleaseNote {
  /** ISO date (YYYY-MM-DD) of the release. */
  date: string;
  title: string;
  changes: readonly string[];
}

export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    date: "2026-10-14",
    title: "Projects",
    changes: [
      "Library is now Projects.",
      "Give a project a description and instructions: every chat in it follows them.",
      "Start a new chat straight from a project’s page.",
    ],
  },
  {
    date: "2026-10-13",
    title: "A new interface",
    changes: [
      "Every screen rebuilt from the ChatUI design, in light and dark.",
      "Projects: group chats with “Move to project”, and browse them in Projects.",
      "Archive chats you want out of the sidebar without deleting them.",
      "Files: every file you attached or a reply produced, in one place.",
      "Replies can be read aloud.",
      "Queued messages can be sent right away with “Send now”.",
      "A profile: display name, email, photo and initials colour.",
      "Settings → Usage shows your chats, messages and storage.",
      "Help, keyboard shortcuts and problem reports from the “…” menu.",
      "Administrators get Logs, with every recorded event and its details.",
    ],
  },
];
