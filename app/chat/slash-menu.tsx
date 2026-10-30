import {
  ArrowLeft,
  Box,
  Check,
  ChevronRight,
  FolderInput,
  Pencil,
  SquarePen,
  Volume2,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { ProviderModelsDto } from "@shared/generations";
import type { ModelPair } from "./model-choice";

export interface SlashItem {
  id: string;
  label: string;
  detail?: string;
  icon: ReactNode;
  /** Opens a second list (the models) instead of running. */
  submenu?: boolean;
  selected?: boolean;
  run?: () => void;
}

export interface SlashCommands {
  groups: ProviderModelsDto[];
  selected: ModelPair | null;
  selectModel: (pair: ModelPair) => void;
  /** Present inside a conversation. */
  rename: (() => void) | null;
  /** Present inside a saved (not temporary) conversation (Phase 13g). */
  moveToProject: (() => void) | null;
  newChat: (() => void) | null;
  /** Present when the chat has a reply and the browser can speak. */
  readAloud: (() => void) | null;
}

/** Keys the composer forwards while the menu is open. */
export type SlashKey = "ArrowDown" | "ArrowUp" | "ArrowRight" | "ArrowLeft" | "Enter" | "Tab";

const MENU_ID = "slash-menu";
export const slashOptionId = (index: number) => `slash-option-${String(index)}`;

function commandItems(commands: SlashCommands): SlashItem[] {
  return [
    {
      id: "model",
      label: "Model",
      detail: commands.selected ? `Change from ${commands.selected[1]}` : "Choose a model",
      icon: <Box size={16} aria-hidden />,
      submenu: true,
    },
    ...(commands.readAloud
      ? [
          {
            id: "read",
            label: "Read aloud",
            detail: "Listen to the last response",
            icon: <Volume2 size={16} aria-hidden />,
            run: commands.readAloud,
          },
        ]
      : []),
    ...(commands.rename
      ? [
          {
            id: "rename",
            label: "Rename chat",
            icon: <Pencil size={16} aria-hidden />,
            run: commands.rename,
          },
        ]
      : []),
    ...(commands.moveToProject
      ? [
          {
            id: "project",
            label: "Move to project",
            icon: <FolderInput size={16} aria-hidden />,
            run: commands.moveToProject,
          },
        ]
      : []),
    ...(commands.newChat
      ? [
          {
            id: "new",
            label: "New chat",
            icon: <SquarePen size={16} aria-hidden />,
            run: commands.newChat,
          },
        ]
      : []),
  ];
}

function modelItems(commands: SlashCommands): SlashItem[] {
  return commands.groups.flatMap((group) =>
    group.models.map((model) => ({
      id: `${model.providerId}\u0000${model.id}`,
      label: model.id,
      detail:
        [
          commands.groups.length > 1 ? group.provider.name : null,
          model.status === "unloaded" ? "Not loaded" : null,
        ]
          .filter(Boolean)
          .join(" · ") || undefined,
      icon: <Box size={16} aria-hidden />,
      selected: commands.selected?.[0] === model.providerId && commands.selected[1] === model.id,
      run: () => {
        commands.selectModel([model.providerId, model.id]);
      },
    })),
  );
}

/**
 * Slash commands (reference UI): typing `/` in an empty composer lists
 * commands above it, filtered by what follows the slash. The textarea keeps
 * focus (combobox pattern: `aria-activedescendant`); the composer forwards
 * the navigation keys through `onKey`.
 */
export function useSlashMenu(query: string | null, commands: SlashCommands, done: () => void) {
  const [chosenLevel, setLevel] = useState<"commands" | "models">("commands");
  // A closed menu always reopens at the commands.
  const level = query === null ? "commands" : chosenLevel;
  const items = useMemo(() => {
    if (query === null) return [];
    const needle = query.toLowerCase();
    const list = level === "models" ? modelItems(commands) : commandItems(commands);
    return list.filter(
      (item) =>
        needle === "" ||
        item.label.toLowerCase().includes(needle) ||
        (level === "commands" && item.detail?.toLowerCase().includes(needle)),
    );
  }, [commands, level, query]);
  const open = query !== null && items.length > 0;
  // The highlight belongs to one list: a new filter or level starts at the
  // top (or at the current model).
  const [cursor, setCursor] = useState<{ list: string; index: number } | null>(null);
  const list = `${level}:${items.map((item) => item.id).join("|")}`;
  const initial = Math.max(
    0,
    items.findIndex((item) => item.selected),
  );
  const active = cursor?.list === list ? Math.min(cursor.index, items.length - 1) : initial;
  const setActive = (update: (index: number) => number) => {
    setCursor({ list, index: update(active) });
  };

  const choose = (index: number) => {
    const item = items[index];
    if (!item) return;
    if (item.submenu) {
      setLevel("models");
      return;
    }
    item.run?.();
    setLevel("commands");
    done();
  };

  /** Returns true when the key was handled. */
  const onKey = (key: SlashKey): boolean => {
    if (!open) return false;
    if (key === "ArrowDown") setActive((i) => (i + 1) % items.length);
    else if (key === "ArrowUp") setActive((i) => (i - 1 + items.length) % items.length);
    else if (key === "ArrowRight" && items[active]?.submenu) setLevel("models");
    else if (key === "ArrowLeft" && level === "models") setLevel("commands");
    else if (key === "Enter" || key === "Tab") choose(active);
    else return false;
    return true;
  };

  const menu = open ? (
    <div className="slash-menu" data-testid="slash-menu">
      {level === "models" ? (
        <button
          type="button"
          className="slash-back"
          onMouseDown={(event) => {
            event.preventDefault();
            setLevel("commands");
          }}
        >
          <ArrowLeft size={14} aria-hidden /> Model
        </button>
      ) : null}
      <ul role="listbox" id={MENU_ID} aria-label={level === "models" ? "Models" : "Commands"}>
        {items.map((item, index) => (
          <li
            key={item.id}
            id={slashOptionId(index)}
            role="option"
            aria-selected={index === active}
            className={`slash-option${index === active ? " is-active" : ""}`}
            onMouseEnter={() => {
              setActive(() => index);
            }}
            onMouseDown={(event) => {
              // Keeps focus in the textarea.
              event.preventDefault();
              choose(index);
            }}
          >
            <span className="slash-icon">{item.icon}</span>
            <span className="slash-label">{item.label}</span>
            {item.detail ? <span className="slash-detail">{item.detail}</span> : null}
            {item.selected ? <Check size={16} className="slash-end" aria-hidden /> : null}
            {item.submenu ? <ChevronRight size={16} className="slash-end" aria-hidden /> : null}
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return {
    open,
    menu,
    onKey,
    close: () => {
      setLevel("commands");
    },
    ariaProps: open
      ? {
          // A textarea keeps its textbox role (it can't be a combobox), so
          // the open list is tied to it by aria-controls and the active
          // option by aria-activedescendant.
          "aria-controls": MENU_ID,
          "aria-activedescendant": slashOptionId(active),
        }
      : {},
  };
}
