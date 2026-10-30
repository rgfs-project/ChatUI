import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { applyAppearance, type Appearance } from "./appearance";
import type { TimeFormat } from "./time";
import { UI_COOKIES, writeUiCookie, type UiHints } from "./ui-cookies";

/** Below this width the sidebar overlays the chat instead of sitting beside it. */
export const NARROW_QUERY = "(max-width: 767px)";

/** Phones (decided by device, `html[data-phone]`) and narrow windows use the drawer. */
export function usesDrawer(): boolean {
  return (
    document.documentElement.hasAttribute("data-phone") || window.matchMedia(NARROW_QUERY).matches
  );
}

interface UiState {
  appearance: Appearance;
  /** Hash of the dismissed instance notice (cookie, so SSR hides it too). */
  noticeDismissed: string | null;
  dismissNotice: (hash: string) => void;
  setAppearance: (next: Appearance) => void;
  /** Desktop preference, remembered in a cookie and rendered by the server. */
  sidebarCollapsed: boolean;
  /** The Recents section is folded (cookie, so the server renders it the same way). */
  recentsCollapsed: boolean;
  setRecentsCollapsed: (collapsed: boolean) => void;
  pinnedCollapsed: boolean;
  setPinnedCollapsed: (collapsed: boolean) => void;
  /** Narrow windows: the overlay sidebar is open (never persisted). */
  narrowOpen: boolean;
  /** Opens or closes the sidebar the way the current window width uses it. */
  setSidebarOpen: (open: boolean) => void;
  closeNarrow: () => void;
  timeFormat: TimeFormat;
}

const UiContext = createContext<UiState | null>(null);

const noopSubscribe = () => () => undefined;

function browserZoneKey(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  return `${navigator.language || resolved.locale}|${resolved.timeZone}`;
}

/**
 * Presentation state from validated cookie hints: the server renders with it
 * and hydration starts from the same values, so nothing changes on hydrate.
 */
export function UiProvider({
  hints,
  renderedAt,
  children,
}: {
  hints: UiHints;
  renderedAt: string;
  children: ReactNode;
}) {
  const [sidebarCollapsed, setCollapsed] = useState(hints.sidebarCollapsed);
  const [recentsCollapsed, setRecentsState] = useState(hints.recentsCollapsed);
  const setRecentsCollapsed = useCallback((collapsed: boolean) => {
    setRecentsState(collapsed);
    writeUiCookie(UI_COOKIES.recents, collapsed ? "collapsed" : "open");
  }, []);
  const [pinnedCollapsed, setPinnedState] = useState(hints.pinnedCollapsed);
  const setPinnedCollapsed = useCallback((collapsed: boolean) => {
    setPinnedState(collapsed);
    writeUiCookie(UI_COOKIES.pinned, collapsed ? "collapsed" : "open");
  }, []);
  const [appearance, setAppearanceState] = useState(hints.appearance);
  const [noticeDismissed, setNoticeDismissed] = useState(hints.noticeDismissed);
  const dismissNotice = useCallback((hash: string) => {
    setNoticeDismissed(hash);
    writeUiCookie(UI_COOKIES.notice, hash);
  }, []);
  const setAppearance = useCallback((next: Appearance) => {
    setAppearanceState(next);
    applyAppearance(next);
  }, []);
  // Hydration renders with the server's values; the browser's own apply right after.
  const zoneKey = useSyncExternalStore(
    noopSubscribe,
    browserZoneKey,
    () => `${hints.locale}|${hints.timeZone}`,
  );
  const zone = useMemo(() => {
    const [locale = hints.locale, timeZone = hints.timeZone] = zoneKey.split("|");
    return { locale, timeZone };
  }, [zoneKey, hints.locale, hints.timeZone]);

  // Teach the server this browser's locale and time zone for the next document.
  useEffect(() => {
    if (zone.timeZone !== hints.timeZone) writeUiCookie(UI_COOKIES.timeZone, zone.timeZone);
    if (zone.locale !== hints.locale) writeUiCookie(UI_COOKIES.locale, zone.locale);
  }, [zone, hints.locale, hints.timeZone]);

  const [narrowOpen, setNarrowOpen] = useState(false);
  const setSidebarOpen = useCallback((open: boolean) => {
    if (usesDrawer()) {
      setNarrowOpen(open);
      return;
    }
    setCollapsed(!open);
    writeUiCookie(UI_COOKIES.sidebar, open ? "open" : "collapsed");
  }, []);
  const closeNarrow = useCallback(() => {
    setNarrowOpen(false);
  }, []);

  const value = useMemo(
    () => ({
      appearance,
      setAppearance,
      noticeDismissed,
      dismissNotice,
      sidebarCollapsed,
      recentsCollapsed,
      setRecentsCollapsed,
      pinnedCollapsed,
      setPinnedCollapsed,
      narrowOpen,
      setSidebarOpen,
      closeNarrow,
      timeFormat: { ...zone, now: renderedAt },
    }),
    [
      appearance,
      setAppearance,
      noticeDismissed,
      dismissNotice,
      sidebarCollapsed,
      recentsCollapsed,
      setRecentsCollapsed,
      pinnedCollapsed,
      setPinnedCollapsed,
      narrowOpen,
      setSidebarOpen,
      closeNarrow,
      zone,
      renderedAt,
    ],
  );
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): UiState {
  const ui = useContext(UiContext);
  if (!ui) throw new Error("useUi outside UiProvider");
  return ui;
}
