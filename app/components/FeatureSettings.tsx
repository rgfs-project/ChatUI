import { useQuery } from "@tanstack/react-query";
import { FEATURES, modelProvides, type Feature, type FeatureOrigin } from "@shared/features";
import { queries } from "../lib/query";

const GROUPS: { origin: FeatureOrigin; title: string; hint: string }[] = [
  {
    origin: "chatui",
    title: "Built into ChatUI",
    hint: "Always available, whichever model you choose.",
  },
  {
    origin: "model",
    title: "Depends on the model",
    hint: "ChatUI supports these, but only with a model that can do them.",
  },
  {
    origin: "unavailable",
    title: "Not available",
    hint: "ChatUI doesn't offer these, even if you've seen them in other chat apps.",
  },
];

/**
 * Settings → Features (Phase 14, INV-52): what ChatUI can do and where each
 * capability comes from. Model-dependent features name the available models
 * that provide them, from the server's model list.
 */
export function FeatureSettings({ userId }: { userId: string }) {
  const models = useQuery(queries.models(userId));
  const all = models.data?.providers.flatMap((group) => group.models) ?? [];

  function availability(feature: Feature): string | null {
    if (feature.origin !== "model" || !feature.requires) return null;
    if (!models.data) return models.isError ? "The model list couldn’t be loaded." : "Checking…";
    const capability = feature.requires;
    const names = all.filter((m) => modelProvides(m, capability)).map((m) => m.id);
    if (names.length === 0) return "None of the available models.";
    const shown = names.slice(0, 4).join(", ");
    return `With ${shown}${names.length > 4 ? ` and ${String(names.length - 4)} more` : ""}.`;
  }

  return (
    <section className="settings-body" aria-labelledby="settings-features">
      <h2 id="settings-features">Features</h2>
      {GROUPS.map((group) => (
        <section
          key={group.origin}
          className="feature-group"
          aria-labelledby={`features-${group.origin}`}
          data-testid={`features-${group.origin}`}
        >
          <h3 id={`features-${group.origin}`} className="feature-group-title">
            {group.title}
          </h3>
          <p className="settings-hint">{group.hint}</p>
          <ul className="feature-list">
            {FEATURES.filter((f) => f.origin === group.origin).map((feature) => {
              const note = availability(feature);
              return (
                <li key={feature.id} className="feature-item">
                  <p className="settings-label">{feature.name}</p>
                  <p className="settings-hint">{feature.description}</p>
                  {note ? <p className="settings-hint feature-models">{note}</p> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </section>
  );
}
