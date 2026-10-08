import { NARROW_QUERY, useMediaQuery } from "../lib/shell";
import {
  ArrowUp,
  BookOpen,
  Cpu,
  FileText,
  Music,
  Pencil,
  Plus,
  Settings,
  Square,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  acceptAttribute,
  attachmentContentUrl,
  type AttachmentDto,
  type AttachmentKind,
} from "@shared/attachments";
import type { ModelListDto } from "@shared/generations";
import type { SkillDto } from "@shared/skills";
import { messageOf } from "../lib/api";
import { deletePendingAttachment, uploadAttachment } from "../lib/attachments";
import { formatBytes } from "../lib/format";
import type { ModelChoice } from "../lib/models";
import { ModelPicker } from "./ModelPicker";
import { IconButton } from "./ui";

export type BuiltIn = "model" | "new" | "rename" | "delete" | "settings";

interface Command {
  name: string;
  hint: string;
  icon: ReactNode;
  builtIn?: BuiltIn;
  skill?: SkillDto;
}

const BUILT_INS: { name: BuiltIn; hint: string; icon: ReactNode; needsChat?: boolean }[] = [
  { name: "model", hint: "Choose the model for this chat", icon: <Cpu size={18} aria-hidden /> },
  { name: "new", hint: "Start a new chat", icon: <SquarePen size={18} aria-hidden /> },
  {
    name: "rename",
    hint: "Rename this chat",
    icon: <Pencil size={18} aria-hidden />,
    needsChat: true,
  },
  {
    name: "delete",
    hint: "Delete this chat",
    icon: <Trash2 size={18} aria-hidden />,
    needsChat: true,
  },
  { name: "settings", hint: "Open settings", icon: <Settings size={18} aria-hidden /> },
];

/** The commands a "/query" offers: skills first, then the built-ins. */
export function matchCommands(
  query: string,
  skills: readonly SkillDto[],
  inChat: boolean,
): Command[] {
  const q = query.toLowerCase();
  const fromSkills: Command[] = skills
    .filter((s) => s.enabled && s.name.startsWith(q))
    .map((s) => ({
      name: s.name,
      hint: s.description || "Your skill",
      icon: <BookOpen size={18} aria-hidden />,
      skill: s,
    }));
  const builtIns: Command[] = BUILT_INS.filter(
    (b) => b.name.startsWith(q) && (inChat || !b.needsChat),
  ).map((b) => ({
    name: b.name,
    hint: b.hint,
    icon: b.icon,
    builtIn: b.name,
  }));
  return [...fromSkills, ...builtIns];
}

interface Upload {
  key: string;
  file: File;
  status: "uploading" | "done" | "failed";
  dto?: AttachmentDto;
  error?: string;
}

export interface ComposerProps {
  models: ModelListDto | undefined;
  model: ModelChoice | null;
  onModelChange: (choice: ModelChoice) => void;
  /** Kinds the chosen model accepts besides text. */
  kinds: readonly AttachmentKind[];
  maxPerMessage: number;
  imageMaxEdge: number;
  skills: readonly SkillDto[];
  inChat: boolean;
  generating: boolean;
  /** While a reply runs, Send queues the message instead of being Stop. */
  canQueue?: boolean;
  onSend: (message: { content: string; attachments: AttachmentDto[] }) => Promise<boolean>;
  onStop: () => void;
  onCommand: (command: BuiltIn) => void;
  placeholder?: string;
}

/** The message bar: add files, text with a "/" menu, the model, Send or Stop. */
export function Composer(props: ComposerProps) {
  const [text, setText] = useState("");
  const [skill, setSkill] = useState<SkillDto | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [activeState, setActiveState] = useState({ query: "", index: 0 });
  const [menuDismissed, setMenuDismissed] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const phone = useMediaQuery(NARROW_QUERY);
  const fileInput = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Text typed before hydration is kept.
  useLayoutEffect(() => {
    const value = textarea.current?.value;
    if (value) setText(value);
  }, []);

  // The box grows with its text, up to a limit. An empty box is one line:
  // measuring the placeholder while the box is still narrow (first layout)
  // once left it hundreds of pixels tall. Width changes measure again.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    // More than one line moves the text to its own row above the controls.
    // Measured in the one-row layout so the wider box can't flip it back.
    const row = el.closest<HTMLElement>(".composer-row");
    const fit = () => {
      row?.removeAttribute("data-grown");
      el.style.height = "auto";
      if (el.value.includes("\n") || el.scrollHeight > 40) {
        row?.setAttribute("data-grown", "");
        el.style.height = "auto";
      }
      if (el.value !== "") el.style.height = `${String(Math.min(el.scrollHeight, 240))}px`;
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [text]);

  const slash = /^\/([a-z0-9-]*)$/.exec(text);
  const commands =
    slash && menuDismissed !== text
      ? matchCommands(slash[1] ?? "", props.skills, props.inChat)
      : [];
  const menuOpen = commands.length > 0;
  // The highlighted command resets whenever the query changes.
  const query = slash?.[1] ?? "";
  const active = activeState.query === query ? activeState.index : 0;
  const setActive = (index: number) => {
    setActiveState({ query, index });
  };
  const activeIndex = Math.min(active, Math.max(0, commands.length - 1));

  const uploading = uploads.some((u) => u.status === "uploading");
  const ready = uploads
    .filter((u) => u.status === "done" && u.dto)
    .map((u) => u.dto as AttachmentDto);
  const hasContent = text.trim() !== "" || ready.length > 0 || skill !== null;
  const canSend =
    hasContent &&
    !uploading &&
    !sending &&
    (!props.generating || props.canQueue === true) &&
    props.model !== null;

  function choose(command: Command) {
    setText("");
    setMenuDismissed(null);
    if (command.skill) {
      setSkill(command.skill);
      textarea.current?.focus();
      return;
    }
    if (command.builtIn === "model") {
      setModelOpen(true);
      return;
    }
    if (command.builtIn) props.onCommand(command.builtIn);
  }

  async function send() {
    if (!canSend) return;
    const body = text.trim();
    const content = skill ? `/${skill.name}${body ? ` ${body}` : ""}` : body;
    setSending(true);
    setError(null);
    // The box empties at once (the message shows as pending in the chat);
    // if the send fails, what was sent comes back, unless something new was typed.
    const sent = { text, skill, uploads };
    setText("");
    setSkill(null);
    setUploads([]);
    const restore = () => {
      if (textarea.current?.value !== "") return;
      setText(sent.text);
      setSkill(sent.skill);
      setUploads(sent.uploads);
    };
    try {
      if (!(await props.onSend({ content, attachments: ready }))) restore();
    } catch (e) {
      restore();
      setError(messageOf(e));
    } finally {
      setSending(false);
    }
  }

  function addFiles(files: readonly File[]) {
    const room = props.maxPerMessage - uploads.length;
    if (files.length > room)
      setError(`You can attach up to ${String(props.maxPerMessage)} files to a message.`);
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      setUploads((list) => [...list, { key, file, status: "uploading" }]);
      uploadAttachment(file, props.imageMaxEdge).then(
        (dto) => {
          setUploads((list) =>
            list.map((u) => (u.key === key ? { ...u, status: "done", dto } : u)),
          );
        },
        (e: unknown) => {
          setUploads((list) =>
            list.map((u) => (u.key === key ? { ...u, status: "failed", error: messageOf(e) } : u)),
          );
        },
      );
    }
  }

  function removeUpload(upload: Upload) {
    setUploads((list) => list.filter((u) => u.key !== upload.key));
    if (upload.dto) void deletePendingAttachment(upload.dto.id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (menuOpen) {
      const command = commands[activeIndex];
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((activeIndex + 1) % commands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((activeIndex - 1 + commands.length) % commands.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && command) {
        event.preventDefault();
        choose(command);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuDismissed(text);
        return;
      }
    }
    if (event.key === "Backspace" && text === "" && skill) {
      setSkill(null);
      return;
    }
    // On phones Return is a new line; the Send button sends.
    if (event.key === "Enter" && !event.shiftKey && !phone) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="composer-wrap">
      {menuOpen ? (
        <div id={listId} role="listbox" aria-label="Commands" className="command-menu">
          {commands.map((c, i) => (
            <div
              key={`${c.skill ? "skill" : "cmd"}-${c.name}`}
              id={`${listId}-${String(i)}`}
              role="option"
              aria-selected={i === activeIndex}
              className="command"
              onPointerDown={(e) => {
                e.preventDefault();
                choose(c);
              }}
              onPointerEnter={() => {
                setActive(i);
              }}
            >
              {c.icon}
              <div>
                <p>/{c.name}</p>
                <p className="menu-hint">{c.hint}</p>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length === 0) return;
          e.preventDefault();
          addFiles([...e.dataTransfer.files]);
        }}
      >
        {uploads.length > 0 ? (
          <ul className="tray" aria-label="Attachments">
            {uploads.map((u) => (
              <li key={u.key} className={`tray-item ${u.status}`}>
                <TrayPreview upload={u} />
                <span className="tray-text">
                  <span className="tray-name">{u.file.name}</span>
                  <span className="tray-meta">
                    {u.status === "uploading"
                      ? "Uploading…"
                      : u.status === "failed"
                        ? (u.error ?? "Failed")
                        : formatBytes(u.dto?.size ?? u.file.size)}
                  </span>
                </span>
                <IconButton
                  label={`Remove ${u.file.name}`}
                  className="muted-icon small"
                  onClick={() => {
                    removeUpload(u);
                  }}
                >
                  <X size={14} aria-hidden />
                </IconButton>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="composer-row">
          <IconButton
            label="Add files"
            onClick={() => fileInput.current?.click()}
            disabled={uploads.length >= props.maxPerMessage}
          >
            <Plus size={22} aria-hidden />
          </IconButton>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept={acceptAttribute(["text", ...props.kinds])}
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          {skill ? (
            <button
              type="button"
              className="skill-chip"
              aria-pressed="true"
              title="Remove skill"
              onClick={() => {
                setSkill(null);
              }}
            >
              <BookOpen size={16} aria-hidden />
              <span>{skill.name}</span>
            </button>
          ) : null}
          <label htmlFor="message" className="sr-only">
            Message
          </label>
          <textarea
            id="message"
            ref={textarea}
            rows={1}
            enterKeyHint={phone ? "enter" : "send"}
            value={text}
            placeholder={props.placeholder ?? "Ask anything"}
            role={menuOpen ? "combobox" : undefined}
            aria-expanded={menuOpen ? true : undefined}
            aria-controls={menuOpen ? listId : undefined}
            aria-activedescendant={menuOpen ? `${listId}-${String(activeIndex)}` : undefined}
            aria-autocomplete={menuOpen ? "list" : undefined}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length) {
                e.preventDefault();
                addFiles(files);
              }
            }}
          />
          <ModelPicker
            models={props.models}
            value={props.model}
            onChange={props.onModelChange}
            open={modelOpen}
            onOpenChange={setModelOpen}
          />
          {props.generating && !(props.canQueue && hasContent) ? (
            <IconButton label="Stop generating" className="send" onClick={props.onStop}>
              <Square size={14} fill="currentColor" aria-hidden />
            </IconButton>
          ) : (
            <IconButton
              label={props.generating ? "Queue message" : "Send"}
              type="submit"
              className="send"
              disabled={!canSend}
            >
              <ArrowUp size={20} strokeWidth={2.25} aria-hidden />
            </IconButton>
          )}
        </div>
      </form>
      {error ? (
        <p className="composer-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function TrayPreview(props: { upload: Upload }) {
  const dto = props.upload.dto;
  if (dto?.kind === "image")
    return <img className="tray-thumb" src={attachmentContentUrl(dto.id)} alt="" />;
  return (
    <span className="tray-icon" aria-hidden>
      {props.upload.file.type.startsWith("audio/") ? <Music size={18} /> : <FileText size={18} />}
    </span>
  );
}
