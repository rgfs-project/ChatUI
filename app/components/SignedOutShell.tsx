import { lazy, Suspense } from "react";
import { Link } from "react-router";
import { paths } from "../lib/paths";

// Needed only after a session expires.
const ReauthDialog = lazy(() => import("./ReauthDialog"));

/**
 * The shell without private content: while auth is still `unknown` (a quiet
 * placeholder, never a login form), after signing out, or after the session
 * expired mid-use (with the re-authentication dialog).
 */
export function SignedOutShell(props: {
  expired: { userId: string; username: string } | null;
  unknown: boolean;
}) {
  if (props.unknown)
    return (
      <div className="app-main" aria-busy="true" data-testid="auth-unknown">
        <p className="empty-state hint">Checking your session…</p>
      </div>
    );
  return (
    <div className="app-main" data-testid="signed-out">
      <div className="empty-state">
        <h1>{props.expired ? "Your session has ended" : "You’re signed out"}</h1>
        <Link to={paths.login()} className="btn lg primary">
          Sign in
        </Link>
      </div>
      {props.expired ? (
        <Suspense fallback={null}>
          <ReauthDialog expired={props.expired} />
        </Suspense>
      ) : null}
    </div>
  );
}
