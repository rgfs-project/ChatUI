import * as Menu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { ConversationSummary } from "@shared/conversations";

/**
 * Per-conversation actions (Radix DropdownMenu, INV-47). Loaded on demand:
 * the sidebar renders after hydration and shows a same-looking plain trigger
 * until this chunk arrives, so the menu and Floating UI stay out of the
 * critical chat bundle.
 */
export default function ConversationMenu(props: {
  item: ConversationSummary;
  defaultOpen: boolean;
  onTriggerFocus: (element: HTMLElement) => void;
  onRename: () => void;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const { item } = props;
  return (
    <Menu.Root
      defaultOpen={props.defaultOpen}
      onOpenChange={(open) => {
        if (open) props.onOpen();
      }}
    >
      <Menu.Trigger asChild>
        <button
          type="button"
          className="icon-button"
          aria-label={`Actions for ${item.title}`}
          title="Actions"
          onFocus={(event) => {
            props.onTriggerFocus(event.currentTarget);
          }}
        >
          <MoreHorizontal size={16} aria-hidden />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu-content" align="end" sideOffset={4}>
          {item.malformed ? null : (
            <Menu.Item className="menu-item" onSelect={props.onRename}>
              <Pencil size={14} aria-hidden /> Rename
            </Menu.Item>
          )}
          <Menu.Item className="menu-item danger" onSelect={props.onDelete}>
            <Trash2 size={14} aria-hidden /> Delete
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
