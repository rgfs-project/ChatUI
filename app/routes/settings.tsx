import { Search } from "lucide-react";
import { Fragment, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { OverlayDialog } from "../chat/overlay";
import { paths } from "../lib/paths";
import { matches } from "../settings/row";
import { SECTIONS } from "../settings/sections";

export const handle = { kind: "overlay" };

export default function Settings() {
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");
  const current = SECTIONS.find((s) => s.id === params.section) ?? SECTIONS[0];
  const searching = query.trim() !== "";
  const results = SECTIONS.map((s) => ({
    ...s,
    rows: s.rows.filter((r) => matches(r, query)),
  })).filter((s) => s.rows.length > 0);
  if (!current) return null;
  return (
    <OverlayDialog title="Settings" className="settings-dialog">
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-search">
            <Search size={16} aria-hidden />
            <input
              type="search"
              className="selectable"
              placeholder="Search settings"
              aria-label="Search settings"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`side-row${!searching && s.id === current.id ? " is-active" : ""}`}
              aria-current={!searching && s.id === current.id ? "page" : undefined}
              onClick={() => {
                setQuery("");
                // Sections replace each other, so one Back still closes Settings.
                void navigate(paths.settings(s.id), {
                  replace: true,
                  state: location.state as unknown,
                });
              }}
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          ))}
        </nav>
        <section className="settings-panel" aria-labelledby="settings-section-title">
          {searching ? (
            <>
              <h2 id="settings-section-title" className="settings-title">
                Results
              </h2>
              {results.length === 0 ? (
                <p className="settings-row-hint">No settings match “{query.trim()}”.</p>
              ) : null}
              {results.map((s) => (
                <Fragment key={s.id}>
                  <h3 className="settings-subtitle">{s.label}</h3>
                  {s.rows.map((row) => (
                    <Fragment key={row.id}>{row.render()}</Fragment>
                  ))}
                </Fragment>
              ))}
            </>
          ) : (
            <>
              <h2 id="settings-section-title" className="settings-title">
                {current.label}
              </h2>
              {current.rows.map((row) => (
                <Fragment key={row.id}>{row.render()}</Fragment>
              ))}
            </>
          )}
        </section>
      </div>
    </OverlayDialog>
  );
}
