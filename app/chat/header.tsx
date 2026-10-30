import {
  MoreHorizontal,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  SquarePen,
  Trash2,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { preferencesQuery } from "../lib/query/queries";
import { useConversationOps } from "./conversation-ops";
import { memo } from "react";
import { useNavigate } from "react-router";
import { paths } from "../lib/paths";
import { useUi } from "../lib/ui-context";
import { IconButton } from "../ui/icon-button";
import { Menu, MenuItem } from "../ui/menu";
import { useChat } from "./chat-context";
import { ModelMenu } from "./model-picker";

export const Header = memo(function Header() {
  const {
    result,
    conversationId,
    groups,
    modelsState,
    selectedPair,
    selectModel,
    refreshModels,
    rename,
    remove,
  } = useChat();
  const { setSidebarOpen } = useUi();
  const navigate = useNavigate();
  const conversation = result?.ok ? result.conversation : null;
  const ops = useConversationOps();
  const { userId } = useChat();
  const pinned =
    useQuery(preferencesQuery(userId)).data?.pins.includes(conversation?.id ?? "") ?? false;

  return (
    <header className="chat-header">
      <div className="header-start">
        <IconButton
          label="Open sidebar"
          className="sidebar-open"
          tooltipSide="right"
          onClick={() => {
            setSidebarOpen(true);
          }}
        >
          <PanelLeftOpen size={20} aria-hidden />
        </IconButton>
        {/* Shown when the sidebar isn't (collapsed, phone, narrow); never on the draft itself. */}
        {conversationId !== null ? (
          <IconButton
            label="New chat"
            className="header-new-chat"
            onClick={() => {
              void navigate(paths.newChat());
            }}
          >
            <SquarePen size={20} aria-hidden />
          </IconButton>
        ) : null}
        {conversation ? (
          <h1 className="header-title" title={conversation.title}>
            {conversation.title}
          </h1>
        ) : (
          <ModelMenu
            label="Model"
            groups={groups}
            selected={selectedPair}
            loading={modelsState === "loading"}
            onSelect={(pair) => {
              if (pair) selectModel(pair);
            }}
            onRefresh={() => {
              void refreshModels();
            }}
          />
        )}
      </div>
      <div className="header-end">
        {conversation ? (
          <Menu
            label="Chat options"
            align="end"
            trigger={
              <button type="button" className="icon-button" aria-label="Chat options">
                <MoreHorizontal size={20} aria-hidden />
              </button>
            }
          >
            <MenuItem
              icon={pinned ? <PinOff size={16} aria-hidden /> : <Pin size={16} aria-hidden />}
              onSelect={() => {
                void ops.togglePin(conversation.id);
              }}
            >
              {pinned ? "Unpin" : "Pin"}
            </MenuItem>
            <MenuItem
              icon={<Pencil size={16} aria-hidden />}
              onSelect={() => {
                rename({
                  id: conversation.id,
                  title: conversation.title,
                  revision: conversation.revision,
                });
              }}
            >
              Rename
            </MenuItem>
            <MenuItem
              danger
              icon={<Trash2 size={16} aria-hidden />}
              onSelect={() => {
                void remove(conversation.id, conversation.title);
              }}
            >
              Delete
            </MenuItem>
          </Menu>
        ) : null}
      </div>
    </header>
  );
});
