import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { HealthDto } from "@shared/api";
import { RELEASE_NOTES } from "@shared/release-notes";
import { REPORT_LIMITS } from "@shared/reports";
import { ApiError, apiJson } from "../lib/query";
import { DialogClose, DialogFrame } from "./Dialogs";
import type { HelpTopic } from "./HelpEntry";
import "./help.css";

const FAQ: readonly { q: string; a: string }[] = [
  {
    q: "Where are my chats kept?",
    a: "On the server this ChatUI runs on, one Markdown file per chat. Nothing is sent anywhere except the model provider your administrator configured.",
  },
  {
    q: "Can I send a message while a reply is still being written?",
    a: "Yes. It waits in a queue above the message box and goes out when the reply finishes. “Send now” stops the reply and sends it straight away.",
  },
  {
    q: "What are skills?",
    a: "Instructions you can apply to any message. Type / in the message box and pick one, or start a message with /name. Manage them in Settings → Skills.",
  },
  {
    q: "What are memories?",
    a: "Notes the assistant reads in every chat. It may suggest new ones under a reply; nothing is saved until you press Save. Review them in Settings → Memories.",
  },
  {
    q: "How do projects work?",
    a: "Use “Move to project” in a chat’s menu to group it. Library lists your projects and the chats in each.",
  },
  {
    q: "What does archiving do?",
    a: "It hides a chat from the sidebar without deleting it. Find archived chats in Settings → General → Archived chats.",
  },
  {
    q: "Can I bring chats from elsewhere?",
    a: "Settings → Data imports a ChatUI export, a Claude data export or a chat downloaded from duck.ai. Nothing changes until you confirm.",
  },
];

const SHORTCUTS: readonly { keys: string; does: string }[] = [
  { keys: "Ctrl / ⌘ + K", does: "Search chats" },
  { keys: "Enter", does: "Send the message" },
  { keys: "Shift + Enter", does: "New line" },
  { keys: "/", does: "Commands and skills (at the start of a message)" },
  { keys: "↑ / ↓", does: "Move through menus, commands and search results" },
  { keys: "Esc", does: "Close a menu or dialog, or cancel an edit" },
  { keys: "Ctrl / ⌘ + Enter", does: "Save an edit and get a new reply" },
  { keys: "+ / − / 0", does: "Zoom an image in, out, or to fit" },
  { keys: "← / →", does: "Previous or next image" },
];

function Done() {
  return (
    <div className="dialog-actions">
      <DialogClose asChild>
        <button type="button" className="btn dialog primary">
          Done
        </button>
      </DialogClose>
    </div>
  );
}

function About() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => apiJson<HealthDto>("/api/health"),
    staleTime: 60_000,
  });
  return (
    <>
      <div className="group">
        <div className="row">
          <span>Version</span>
          <span className="row-value">{health.data?.version ?? "…"}</span>
        </div>
        <div className="row">
          <span>Server</span>
          <span className="row-value">
            {health.isError ? "Unreachable" : health.data ? "Running" : "Checking…"}
          </span>
        </div>
      </div>
      <Done />
    </>
  );
}

function Faq() {
  return (
    <>
      <div className="help-list">
        {FAQ.map((item) => (
          <details key={item.q} className="help-item">
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </div>
      <Done />
    </>
  );
}

function Shortcuts() {
  return (
    <>
      <dl className="group shortcut-list">
        {SHORTCUTS.map((item) => (
          <div key={item.keys} className="row">
            <dt>{item.does}</dt>
            <dd>
              <kbd>{item.keys}</kbd>
            </dd>
          </div>
        ))}
      </dl>
      <Done />
    </>
  );
}

function Releases() {
  return (
    <>
      <div className="help-list">
        {RELEASE_NOTES.map((note) => (
          <section key={note.date} className="release">
            <h3>
              {note.title} <time dateTime={note.date}>{note.date}</time>
            </h3>
            <ul>
              {note.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <Done />
    </>
  );
}

function Report({ onSent }: { onSent: () => void }) {
  const [text, setText] = useState("");
  const [details, setDetails] = useState(true);
  const send = useMutation({
    mutationFn: () =>
      apiJson("/api/reports", {
        method: "POST",
        body: JSON.stringify({
          description: text.trim(),
          ...(details
            ? { page: location.pathname, userAgent: navigator.userAgent.slice(0, 300) }
            : {}),
        }),
      }),
    onSuccess: onSent,
  });
  return (
    <form
      className="dialog-body"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) send.mutate();
      }}
    >
      <label htmlFor="report-text" className="visually-hidden">
        What went wrong?
      </label>
      <textarea
        id="report-text"
        className="textarea"
        placeholder="What went wrong? What did you expect?"
        maxLength={REPORT_LIMITS.maxDescription}
        value={text}
        required
        onChange={(event) => {
          setText(event.currentTarget.value);
        }}
      />
      <label className="check-row">
        <input
          type="checkbox"
          className="switch"
          checked={details}
          onChange={(event) => {
            setDetails(event.currentTarget.checked);
          }}
        />
        Include this page’s address and my browser version
      </label>
      {send.isError ? (
        <p className="form-error" role="alert">
          {send.error instanceof ApiError ? send.error.message : "The report couldn’t be sent."}
        </p>
      ) : null}
      <div className="dialog-actions">
        <DialogClose asChild>
          <button type="button" className="btn dialog">
            Cancel
          </button>
        </DialogClose>
        <button
          type="submit"
          className="btn dialog primary"
          disabled={send.isPending || text.trim() === ""}
        >
          Send report
        </button>
      </div>
    </form>
  );
}

const TITLES: Record<HelpTopic, { title: string; description: string; wide?: boolean }> = {
  about: { title: "About ChatUI", description: "Self-hosted AI chat." },
  faq: { title: "Help & FAQ", description: "Answers to common questions.", wide: true },
  shortcuts: {
    title: "Keyboard shortcuts",
    description: "Work faster from the keyboard.",
    wide: true,
  },
  releases: { title: "Release notes", description: "What’s new in ChatUI.", wide: true },
  report: {
    title: "Report a problem",
    description: "Your administrator sees this report in Logs.",
  },
};

/** The dialogs behind the header menu's help items. */
export default function HelpDialogs(props: {
  userId: string;
  topic: HelpTopic | null;
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const [sent, setSent] = useState(false);
  const topic = props.topic ?? "about";
  const meta = TITLES[topic];
  return (
    <>
      <DialogFrame
        open={props.topic !== null}
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
        title={meta.title}
        description={meta.description}
        wide={meta.wide}
        returnFocus={props.returnFocus}
      >
        {topic === "about" ? <About /> : null}
        {topic === "faq" ? <Faq /> : null}
        {topic === "shortcuts" ? <Shortcuts /> : null}
        {topic === "releases" ? <Releases /> : null}
        {topic === "report" ? (
          <Report
            onSent={() => {
              props.onClose();
              setSent(true);
            }}
          />
        ) : null}
      </DialogFrame>
      <p className="visually-hidden" role="status" aria-live="polite">
        {sent ? "Report sent. Thank you." : ""}
      </p>
    </>
  );
}
