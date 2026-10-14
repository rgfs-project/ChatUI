import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { UsageDto } from "@shared/usage";
import { formatBytes } from "../lib/format";
import { queries } from "../lib/query";
import "./usage.css";

const dayLabel = (iso: string, style: "short" | "long" = "short") =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    ...(style === "long" ? { weekday: "short" } : {}),
  });

/** Messages per day over the last 30 days: one series, so no legend. */
function ActivityChart({ days }: { days: UsageDto["days"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = days.map((d) => d.sent + d.replies);
  const max = Math.max(1, ...totals);
  const first = days[0];
  const last = days.at(-1);
  const active = hover === null ? null : days[hover];
  return (
    <figure className="chart">
      <figcaption className="chart-title">
        Messages per day <span className="chart-sub">last 30 days</span>
      </figcaption>
      <div className="chart-plot">
        <span className="chart-max" aria-hidden>
          {max}
        </span>
        <ol
          className="chart-bars"
          aria-label="Messages per day"
          onPointerLeave={() => {
            setHover(null);
          }}
        >
          {days.map((day, index) => {
            const total = totals[index] ?? 0;
            return (
              <li
                key={day.date}
                className={`chart-col${hover === index ? " on" : ""}`}
                // Each column is the hit target (wider than its bar) and a focus stop.
                tabIndex={0}
                aria-label={`${dayLabel(day.date, "long")}: ${String(total)} messages (${String(day.sent)} sent, ${String(day.replies)} replies)`}
                onPointerEnter={() => {
                  setHover(index);
                }}
                onFocus={() => {
                  setHover(index);
                }}
                onBlur={() => {
                  setHover(null);
                }}
              >
                {total > 0 ? (
                  <span
                    className="chart-bar"
                    style={{ height: `${String((total / max) * 100)}%` }}
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
        {active ? (
          <div
            className="chart-tip"
            aria-hidden
            style={{ left: `${String(((hover ?? 0) + 0.5) * (100 / days.length))}%` }}
          >
            <strong>{active.sent + active.replies}</strong>
            <span>
              {active.sent} sent · {active.replies} replies
            </span>
            <span className="chart-tip-date">{dayLabel(active.date, "long")}</span>
          </div>
        ) : null}
      </div>
      <div className="chart-axis" aria-hidden>
        <span>{first ? dayLabel(first.date) : ""}</span>
        <span>{last ? dayLabel(last.date) : ""}</span>
      </div>
      <details className="chart-table">
        <summary>Show as table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Sent</th>
              <th scope="col">Replies</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.date}>
                <th scope="row">{dayLabel(day.date, "long")}</th>
                <td>{day.sent}</td>
                <td>{day.replies}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** A used/total pair with a thin meter. */
function Meter({ label, used, total }: { label: string; used: number; total: number }) {
  const share = total > 0 ? Math.min(1, used / total) : 0;
  return (
    <div className="row stack">
      <div className="meter-head">
        <span className="row-label">{label}</span>
        <span className="row-value">
          {formatBytes(used)} of {formatBytes(total)}
        </span>
      </div>
      <span
        className="meter"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={used}
        aria-valuetext={`${formatBytes(used)} of ${formatBytes(total)}`}
      >
        <span style={{ width: `${String(share * 100)}%` }} />
      </span>
    </div>
  );
}

/** Settings → Usage: counts and storage, worked out from this account's own files. */
export default function UsageSettings({ userId }: { userId: string }) {
  const usage = useQuery(queries.usage(userId));
  const u = usage.data;
  return (
    <>
      <h1 className="page-title">Usage</h1>
      {usage.isPending ? <p className="hint">Loading…</p> : null}
      {usage.isError ? (
        <div className="alert danger" role="alert">
          <span className="alert-text">Usage couldn’t be loaded.</span>
          <button type="button" className="btn" onClick={() => void usage.refetch()}>
            Try again
          </button>
        </div>
      ) : null}
      {u ? (
        <>
          <section className="stat-grid" aria-label="Totals">
            {(
              [
                ["Messages sent", u.messages.sent],
                ["Replies", u.messages.replies],
                ["Chats", u.chats],
                ["Projects", u.projects],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="stat">
                <span className="stat-value">{value.toLocaleString()}</span>
                <span className="stat-label">{label}</span>
              </div>
            ))}
          </section>
          <section className="group chart-card">
            <ActivityChart days={u.days} />
          </section>
          {u.models.length > 0 ? (
            <section className="section">
              <h2 className="section-title">Replies by model</h2>
              <ul className="group">
                {u.models.map((m) => (
                  <li key={`${m.provider}/${m.model}`} className="row">
                    <span className="row-text">
                      <span className="row-label">{m.model}</span>
                      <span className="row-hint">{m.provider}</span>
                    </span>
                    <span className="row-value">{m.replies.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="section">
            <h2 className="section-title">Storage</h2>
            <div className="group">
              <Meter
                label="Attachments"
                used={u.storage.attachmentsBytes}
                total={u.storage.attachmentQuotaBytes}
              />
              <Meter
                label="Files from replies"
                used={u.storage.filesBytes}
                total={u.storage.filesQuotaBytes}
              />
              <div className="row">
                <span className="row-label">Chats</span>
                <span className="row-value">{formatBytes(u.storage.chatsBytes)}</span>
              </div>
            </div>
          </section>
          <section className="section">
            <h2 className="section-title">Also kept</h2>
            <div className="group">
              <div className="row">
                <span className="row-label">Archived chats</span>
                <span className="row-value">{u.archivedChats}</span>
              </div>
              <div className="row">
                <span className="row-label">Memories</span>
                <span className="row-value">{u.memories}</span>
              </div>
              <div className="row">
                <span className="row-label">Skills</span>
                <span className="row-value">{u.skills}</span>
              </div>
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}
