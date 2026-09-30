import { lazy, Suspense } from "react";
import { Link } from "react-router";
import { paths } from "../lib/paths";

// Only needed after a session expires: loaded on demand.
const ReauthDialog = lazy(() => import("./ReauthDialog"));

/**
 * The shell with no private content: while auth is `unknown` (a neutral
 * placeholder, never a login form), after sign-out, or after the session
 * expired mid-use (the re-authentication dialog, contracts §12).
 */
export function SignedOutShell(props: {
  expired: { userId: string; username: string } | null;
  unknown: boolean;
}) {
  if (props.unknown)
    return (
      <div className="app-main locked" aria-busy="true" data-testid="auth-unknown">
        <p className="placeholder">Checking your session…</p>
      </div>
    );
  return (
    <div className="app-main locked" data-testid="signed-out">
      <div className="empty-state">
        <h1>{props.expired ? "Your session has ended" : "You are signed out"}</h1>
        <p>
          <Link to={paths.login()}>Go to the sign-in page</Link>
        </p>
      </div>
      {props.expired ? (
        <Suspense fallback={null}>
          <ReauthDialog expired={props.expired} />
        </Suspense>
      ) : null}
    </div>
  );
}
