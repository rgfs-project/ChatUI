import { useEffect, useRef } from 'react';
import { Navigate, useLocation } from 'react-router';
import { SignIn } from '../SignIn.tsx';
import { showToast } from '../toast.ts';
import { paths } from './paths.ts';
import { useAppSession } from './session.ts';
import type { Location } from 'react-router';

/**
 * The sign-in screen, as the only route outside `RequireAuth`.
 *
 * Signing in does not navigate from here. `onSignedIn` refetches the session,
 * `authState` becomes `authenticated`, and the redirect below fires on the
 * next render — so there is one path back into the application rather than a
 * navigation here and a guard elsewhere that can disagree about where "back"
 * is.
 */

/** What `RequireAuth` puts in history state when it sends someone here. */
interface LoginState {
  from?: Location;
}

export function LoginRoute(): React.JSX.Element {
  const { authState, registrationOpen, expired, user, onSignedIn } = useAppSession();
  const location = useLocation();

  // Fired once per expiry, not on every render it stays true for — a toast
  // that re-armed itself on an unrelated re-render would refire on its own.
  const announced = useRef(false);
  useEffect(() => {
    if (expired && user !== null && !announced.current) {
      announced.current = true;
      showToast('warning', 'Your session ended. Please sign in again.');
    }
    if (!expired) announced.current = false;
  }, [expired, user]);

  if (authState === 'authenticated') {
    /*
     * Back to whatever they were denied, or to a new chat if they simply
     * visited /login. `replace` so Back does not return to a login screen that
     * will immediately bounce them forward again.
     */
    const state = location.state as LoginState | null;
    const from = state?.from;
    return (
      <Navigate to={from === undefined ? paths.newChat : from.pathname + from.search} replace />
    );
  }

  return <SignIn registrationOpen={registrationOpen} onSignedIn={onSignedIn} />;
}
