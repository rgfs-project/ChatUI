import { MoreHorizontal, PanelLeftOpen, Pencil, SquarePen, Trash2 } from "lucide-react";
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
  const { sidebarCollapsed, setSidebarOpen } = useUi();
  const navigate = useNavigate();
  const conversation = result?.ok ? result.conversation : null;

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
        {sidebarCollapsed && conversationId !== null ? (
          <IconButton
            label="New chat"
            onClick={() => {
              void navigate(paths.newChat());
            }}
          >
            <SquarePen size={20} aria-hidden />
          </IconButton>
        ) : null}
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
