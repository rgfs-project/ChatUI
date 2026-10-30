import { ChevronDown, RefreshCw } from "lucide-react";
import type { ProviderModelsDto } from "@shared/generations";
import type React from "react";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../ui/menu";
import { pairKey, pairOfKey, type ModelPair } from "./model-choice";

function providerNote(group: ProviderModelsDto): string {
  if (group.provider.status === "unavailable") return " (unavailable)";
  if (group.stale) return " (list may be out of date)";
  return "";
}

/** Notes for a model: missing image/audio input for attached files, and load state. */
function modelDetail(
  model: ProviderModelsDto["models"][number],
  needs: { image: boolean; audio: boolean } | undefined,
): string | undefined {
  const inputs = model.capabilities.inputModalities;
  const notes = [
    needs?.image && !inputs.includes("image") ? "Can't view images" : null,
    needs?.audio && !inputs.includes("audio") ? "Can't listen to audio" : null,
    model.status === "unloaded" ? "Not loaded" : null,
  ].filter((note): note is string => note !== null);
  return notes.length > 0 ? notes.join(" · ") : undefined;
}

/** Model selector on Radix DropdownMenu radio groups, grouped by provider. */
export function ModelMenu({
  groups,
  selected,
  onSelect,
  onRefresh,
  loading,
  label,
  extraOption,
  triggerClassName = "model-trigger",
  trigger,
  before,
  side = "bottom",
  needs,
}: {
  groups: ProviderModelsDto[];
  selected: ModelPair | null;
  onSelect: (pair: ModelPair | null) => void;
  onRefresh?: () => void;
  loading: boolean;
  label: string;
  /** An extra first choice, e.g. "No default". Selecting it passes null. */
  extraOption?: string;
  triggerClassName?: string;
  /** Replaces the default "current model" trigger (e.g. the composer's + button). */
  trigger?: React.ReactElement;
  /** Items shown above the model list (e.g. attachments, Phase 12). */
  before?: React.ReactNode;
  side?: "top" | "bottom";
  /** Attached media: models without that input are marked (Phase 12). */
  needs?: { image: boolean; audio: boolean };
}) {
  const value = selected ? pairKey(selected) : "";
  const count = groups.reduce((n, g) => n + g.models.length, 0);
  const current = selected
    ? selected[1]
    : (extraOption ?? (loading ? "Loading models…" : "No models available"));
  return (
    <Menu
      label={label}
      align="start"
      side={side}
      contentClassName="model-menu"
      trigger={
        trigger ?? (
          <button
            type="button"
            className={triggerClassName}
            data-testid="model-picker"
            aria-label={`${label}: ${current}`}
          >
            <span className="model-name">{current}</span>
            <ChevronDown size={16} aria-hidden />
          </button>
        )
      }
    >
      {before}
      {extraOption ? (
        <MenuRadioGroup
          value={value}
          onValueChange={() => {
            onSelect(null);
          }}
        >
          <MenuRadioItem value="">{extraOption}</MenuRadioItem>
        </MenuRadioGroup>
      ) : null}
      {count === 0 && !extraOption ? (
        <MenuLabel>{loading ? "Loading models…" : "No models available"}</MenuLabel>
      ) : null}
      {groups.map((group) => (
        <MenuGroup key={group.provider.id}>
          <MenuLabel>
            {group.provider.name}
            {providerNote(group)}
          </MenuLabel>
          <MenuRadioGroup
            value={value}
            onValueChange={(key) => {
              const pair = pairOfKey(key);
              if (pair) onSelect(pair);
            }}
          >
            {group.models.map((model) => (
              <MenuRadioItem
                key={model.id}
                value={pairKey([model.providerId, model.id])}
                {...(modelDetail(model, needs) ? { detail: modelDetail(model, needs) } : {})}
              >
                {model.id}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      ))}
      {onRefresh ? (
        <>
          <MenuSeparator />
          <MenuItem icon={<RefreshCw size={16} aria-hidden />} onSelect={onRefresh}>
            Refresh models
          </MenuItem>
        </>
      ) : null}
    </Menu>
  );
}
