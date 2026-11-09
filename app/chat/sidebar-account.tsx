import { ChevronRight, CircleUserRound, Keyboard, LogOut, Settings, Shield } from "lucide-react";
import { useNavigate } from "react-router";
import { paths } from "../lib/paths";
import { Avatar } from "../ui/avatar";
import { Menu, MenuItem, MenuSeparator } from "../ui/menu";
import { useChat } from "./chat-context";
import { useOpenOverlay } from "./overlay";

/** The account row at the foot of the sidebar and its menu. */
export function AccountMenu() {
  const { userId, username, role, logout } = useChat();
  const roleLabel = role === "admin" ? "Administrator" : "Member";
  const openOverlay = useOpenOverlay();
  const navigate = useNavigate();
  return (
    <Menu
      label="Account"
      side="top"
      align="start"
      contentClassName="profile-menu"
      trigger={
        <button type="button" className="profile-row">
          <Avatar userId={userId} username={username} />
          {/* The visible name is part of the accessible name ("Account: alice"). */}
          <span className="visually-hidden">Account: </span>
          <span className="profile-text">
            <span className="profile-name" data-testid="signed-in-user">
              {username}
            </span>
            <span className="profile-role">{roleLabel}</span>
          </span>
        </button>
      }
    >
      <MenuItem
        icon={<Avatar userId={userId} username={username} />}
        onSelect={() => {
          void navigate(paths.profile());
        }}
      >
        <span className="profile-menu-head">
          <span className="profile-menu-name">{username}</span>
          <span className="profile-role">{roleLabel}</span>
        </span>
        <ChevronRight className="profile-menu-chevron" size={16} aria-hidden />
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={<CircleUserRound size={16} aria-hidden />}
        onSelect={() => {
          void navigate(paths.profile());
        }}
      >
        Profile
      </MenuItem>
      <MenuItem
        icon={<Settings size={16} aria-hidden />}
        onSelect={() => {
          openOverlay(paths.settings());
        }}
      >
        Settings
      </MenuItem>
      <MenuItem
        icon={<Keyboard size={16} aria-hidden />}
        onSelect={() => {
          openOverlay(paths.settings("shortcuts"));
        }}
      >
        Keyboard shortcuts
      </MenuItem>
      {role === "admin" ? (
        <MenuItem
          icon={<Shield size={16} aria-hidden />}
          onSelect={() => {
            openOverlay(paths.admin());
          }}
        >
          Administration
        </MenuItem>
      ) : null}
      <MenuSeparator />
      <MenuItem
        icon={<LogOut size={16} aria-hidden />}
        onSelect={() => {
          void logout();
        }}
      >
        Log out
      </MenuItem>
    </Menu>
  );
}
