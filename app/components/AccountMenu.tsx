import { LogOut, Settings } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { initial } from "../lib/format";
import { paths } from "../lib/paths";
import type { ShellUser } from "../lib/shell";
import { signOut } from "../lib/sign-out";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui";

/** The account button at the foot of the sidebar (or the rail). */
export function AccountMenu(props: { user: ShellUser; compact?: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className={props.compact ? "icon-button account compact" : "account"}
          aria-label={`Account: ${props.user.username}`}
        >
          <span className="avatar" aria-hidden>
            {initial(props.user.username)}
          </span>
          {props.compact ? null : (
            <span className="account-name" data-testid="signed-in-user">
              {props.user.username}
            </span>
          )}
        </button>
      </MenuTrigger>
      <MenuContent side="top" align="start" className="account-menu">
        <div className="account-menu-head" aria-hidden>
          <span className="avatar">{initial(props.user.username)}</span>
          <span className="account-name">{props.user.username}</span>
        </div>
        <MenuSeparator />
        <MenuItem
          icon={<Settings size={18} aria-hidden />}
          onSelect={() =>
            void navigate(paths.settings(), { state: { background: location.pathname } })
          }
        >
          Settings
        </MenuItem>
        <MenuItem icon={<LogOut size={18} aria-hidden />} onSelect={() => void signOut()}>
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
