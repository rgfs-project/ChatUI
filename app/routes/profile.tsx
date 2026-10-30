import { useQuery, useQueryClient } from "@tanstack/react-query";
import "./profile.css";
import { Camera, Check, ImageUp, Shapes, Trash2 } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PHOTO_SHAPES, type PhotoShape } from "@shared/photo-shapes";
import type { ProfileDto, ProfileStats } from "@shared/profile";
import { useChat } from "../chat/chat-context";
import { apiJson } from "../lib/api";
import { qk } from "../lib/query/keys";
import { profileQuery } from "../lib/query/queries";
import { useUi } from "../lib/ui-context";
import { PhotoDialog } from "../profile/photo-dialog";
import { Avatar } from "../ui/avatar";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../ui/menu";
import { PageHeader } from "../ui/page-header";
import { useToast } from "../ui/toast";

export const handle = { kind: "page" };

const SHAPE_LABEL: Record<PhotoShape, string> = {
  circle: "Circle",
  flower: "Flower",
  rounded: "Rounded square",
  oval: "Oval",
  cookie: "Cookie",
};

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 86_400_000;

/**
 * Profile (Phase 12b): your photo and its shape, counts and streaks, a year
 * of daily activity and a few observations, all computed on the server from
 * your own conversations in your time zone.
 */
export default function Profile() {
  const { userId, username, role } = useChat();
  const { timeFormat } = useUi();
  const client = useQueryClient();
  const toast = useToast();
  const profile = useQuery(profileQuery(userId)).data;
  const stats = useQuery({
    queryKey: qk.profileStats(userId, timeFormat.timeZone),
    queryFn: ({ signal }) =>
      apiJson<ProfileStats>(
        `/api/profile/stats?timeZone=${encodeURIComponent(timeFormat.timeZone)}`,
        { signal },
      ),
  });
  const [file, setFile] = useState<File | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const closeDialog = useCallback(() => {
    setFile(null);
  }, []);

  const update = (request: Promise<ProfileDto>, done: string) =>
    request.then(
      (next) => {
        client.setQueryData(qk.profile(userId), next);
        toast(done);
      },
      (error: unknown) => {
        toast(error instanceof Error ? error.message : "Could not save", "error");
      },
    );

  const since = profile
    ? new Intl.DateTimeFormat(timeFormat.locale, {
        dateStyle: "long",
        timeZone: timeFormat.timeZone,
      }).format(new Date(profile.createdAt))
    : "";

  return (
    <div className="page profile">
      <title>Profile · ChatUI</title>
      <PageHeader title="Profile" />
      <div className="page-body">
        <section className="profile-card" aria-label="Your profile">
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            data-testid="photo-input"
            onChange={(event) => {
              setFile(event.currentTarget.files?.[0] ?? null);
              event.currentTarget.value = "";
            }}
          />
          <Menu
            label="Profile photo"
            align="start"
            trigger={
              <button
                type="button"
                className="profile-photo-button"
                aria-label="Change profile photo"
              >
                <Avatar userId={userId} username={username} size="large" />
                <span className="profile-photo-badge" aria-hidden>
                  <Camera size={14} />
                </span>
              </button>
            }
          >
            <MenuItem
              icon={<ImageUp size={16} aria-hidden />}
              onSelect={() => {
                picker.current?.click();
              }}
            >
              {profile?.photoVersion ? "Change photo" : "Upload photo"}
            </MenuItem>
            <MenuSeparator />
            <MenuLabel>
              <Shapes size={14} aria-hidden /> Shape
            </MenuLabel>
            {PHOTO_SHAPES.map((shape) => (
              <MenuItem
                key={shape}
                icon={profile?.shape === shape ? <Check size={16} aria-hidden /> : <span />}
                onSelect={() => {
                  void update(
                    apiJson<ProfileDto>("/api/profile", { method: "PATCH", json: { shape } }),
                    "Shape saved.",
                  );
                }}
              >
                {SHAPE_LABEL[shape]}
              </MenuItem>
            ))}
            {profile?.photoVersion ? (
              <>
                <MenuSeparator />
                <MenuItem
                  danger
                  icon={<Trash2 size={16} aria-hidden />}
                  onSelect={() => {
                    void update(
                      apiJson<ProfileDto>("/api/profile/photo", { method: "DELETE" }),
                      "Photo removed.",
                    );
                  }}
                >
                  Remove photo
                </MenuItem>
              </>
            ) : null}
          </Menu>
          <div className="profile-identity">
            <h2 className="profile-username selectable">{username}</h2>
            <p className="library-muted">
              {role === "admin" ? "Administrator" : "Member"}
              {since ? ` · since ${since}` : ""}
            </p>
          </div>
        </section>

        {stats.isPending ? (
          <p className="library-note">Counting…</p>
        ) : stats.isError ? (
          <p className="library-note" role="alert">
            Your activity could not be loaded.
          </p>
        ) : (
          <>
            <dl className="profile-stats" data-testid="profile-stats">
              <Stat label="Chats" value={stats.data.chats} />
              <Stat label="Messages" value={stats.data.messages} />
              <Stat label="Current streak" value={stats.data.currentStreak} unit="days" />
              <Stat label="Longest streak" value={stats.data.longestStreak} unit="days" />
              <Stat label="Files" value={stats.data.files} />
            </dl>
            <Activity stats={stats.data} locale={timeFormat.locale} />
            <Insights stats={stats.data} />
          </>
        )}
      </div>
      <PhotoDialog userId={userId} file={file} onClose={closeDialog} />
    </div>
  );
}

function Stat({ label, value, unit }: { label: string; value: number; unit?: string }) {
  return (
    <div className="profile-stat">
      <dt>{label}</dt>
      <dd>
        {value.toLocaleString()}
        {unit ? (
          <span className="profile-stat-unit"> {value === 1 ? unit.replace(/s$/, "") : unit}</span>
        ) : null}
      </dd>
    </div>
  );
}

function level(count: number, max: number): number {
  if (count === 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4)));
}

/**
 * 53 weeks of daily messages, Sunday to Saturday in columns. On narrow
 * screens it scrolls horizontally and opens at the newest weeks.
 */
function Activity({ stats, locale }: { stats: ProfileStats; locale: string }) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const cells = useMemo(() => {
    const counts = new Map(stats.days.map((d) => [d.date, d.count]));
    const today = Date.parse(`${stats.today}T00:00:00Z`);
    const weekday = new Date(today).getUTCDay();
    // The grid ends with the week containing today; earlier days fill 52 more weeks.
    const start = today - (52 * 7 + weekday) * DAY_MS;
    const max = Math.max(1, ...stats.days.map((d) => d.count));
    const days: { date: string; count: number; level: number; future: boolean }[] = [];
    for (let t = start; t < start + 53 * 7 * DAY_MS; t += DAY_MS) {
      const date = new Date(t).toISOString().slice(0, 10);
      const count = counts.get(date) ?? 0;
      days.push({ date, count, level: level(count, max), future: t > today });
    }
    return days;
  }, [stats]);
  const label = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }),
    [locale],
  );
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [cells]);
  const total = stats.days.reduce((sum, d) => sum + d.count, 0);
  return (
    <section className="profile-section" aria-labelledby="activity-title">
      <h2 id="activity-title" className="settings-subtitle">
        Activity
      </h2>
      <p className="library-muted">
        {total.toLocaleString()} {total === 1 ? "message" : "messages"} in the last year
      </p>
      <div className="activity-scroll" ref={scroller}>
        <ol className="activity-grid" data-testid="activity-grid" aria-label="Messages per day">
          {cells.map((cell) => (
            <li
              key={cell.date}
              className={`activity-cell level-${String(cell.level)}${cell.future ? " is-future" : ""}`}
              title={`${cell.count === 0 ? "No" : cell.count.toLocaleString()} ${cell.count === 1 ? "message" : "messages"} on ${label.format(new Date(`${cell.date}T00:00:00Z`))}`}
              data-date={cell.date}
              data-count={cell.count}
            />
          ))}
        </ol>
      </div>
      <div className="activity-legend" aria-hidden>
        Less
        {[0, 1, 2, 3, 4].map((n) => (
          <span key={n} className={`activity-cell level-${String(n)}`} />
        ))}
        More
      </div>
    </section>
  );
}

function Insights({ stats }: { stats: ProfileStats }) {
  const items: string[] = [];
  if (stats.busiestWeekday !== null)
    items.push(`You chat most on ${WEEKDAY[stats.busiestWeekday] ?? ""}s.`);
  if (stats.busiestHour !== null)
    items.push(`Your busiest hour is ${String(stats.busiestHour).padStart(2, "0")}:00.`);
  if (stats.favoriteModel) items.push(`Your most used model is ${stats.favoriteModel}.`);
  if (stats.activeDays > 0)
    items.push(
      `You average ${(stats.messages / stats.activeDays).toFixed(1)} messages on the ${stats.activeDays.toLocaleString()} ${stats.activeDays === 1 ? "day" : "days"} you chat.`,
    );
  if (items.length === 0) return null;
  return (
    <section className="profile-section" aria-labelledby="insights-title">
      <h2 id="insights-title" className="settings-subtitle">
        Insights
      </h2>
      <ul className="profile-insights">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
