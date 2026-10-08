import { useQueryClient } from "@tanstack/react-query";
import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import type { Theme } from "@shared/theme";
import { Switch } from "../components/ui";
import { api, messageOf } from "../lib/api";
import { DEFAULT_IMAGE_MAX_EDGE } from "../lib/attachments";
import { applyReasoningShown, applyTheme, currentTheme, reasoningShown } from "../lib/display";
import { keys, usePreferences, type Preferences } from "../lib/query";
import { Choice, Group, Row, Status } from "./parts";

const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function General(props: { userId: string }) {
  const client = useQueryClient();
  const prefs = usePreferences(props.userId);
  // Settings render only in the browser (a portal), so the document is there.
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const [reasoning, setReasoning] = useState(reasoningShown);
  const [error, setError] = useState<string | null>(null);

  async function save(change: Partial<Preferences>) {
    setError(null);
    client.setQueryData<Preferences>(keys.preferences(props.userId), (p) =>
      p ? { ...p, ...change } : p,
    );
    try {
      client.setQueryData(
        keys.preferences(props.userId),
        await api<Preferences>("/api/preferences", { method: "PATCH", body: change }),
      );
    } catch (e) {
      setError(messageOf(e));
      void prefs.refetch();
    }
  }

  return (
    <>
      <Group heading="Appearance" note="The model’s reasoning, above its replies.">
        <Row label="Theme" id="g-theme">
          <div role="radiogroup" aria-labelledby="g-theme" className="segmented">
            {THEMES.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                aria-label={label}
                title={label}
                onClick={() => {
                  setTheme(value);
                  applyTheme(value);
                }}
              >
                <Icon size={18} aria-hidden />
              </button>
            ))}
          </div>
        </Row>
        <Row label="Show thought process">
          <Switch
            label="Show thought process"
            checked={reasoning}
            onChange={(shown) => {
              setReasoning(shown);
              applyReasoningShown(shown);
            }}
          />
        </Row>
      </Group>
      <Group
        heading="Images and audio"
        note="Earlier ones go to the model again with each message. Large images shrink in your browser."
      >
        <Row label="Earlier images and audio" id="g-hist">
          <Choice
            labelledBy="g-hist"
            value={prefs.data?.historyImages ?? "include"}
            options={[
              { value: "include", label: "Include" },
              { value: "omit", label: "Leave out" },
            ]}
            disabled={!prefs.data}
            onChange={(v) => void save({ historyImages: v })}
          />
        </Row>
        <Row label="Shrink large images" id="g-edge">
          <Choice
            labelledBy="g-edge"
            value={prefs.data?.imageMaxEdge ?? DEFAULT_IMAGE_MAX_EDGE}
            options={[
              { value: 1024, label: "1024 px" },
              { value: 2048, label: "2048 px" },
              { value: 3072, label: "3072 px" },
              { value: 4096, label: "4096 px" },
              { value: 0, label: "Don’t shrink" },
            ]}
            disabled={!prefs.data}
            onChange={(v) => void save({ imageMaxEdge: v })}
          />
        </Row>
      </Group>
      <Status error={error} />
    </>
  );
}
