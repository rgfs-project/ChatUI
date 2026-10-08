import { Check, ChevronDown } from "lucide-react";
import type { ModelListDto } from "@shared/generations";
import { allModels, modelLabel, type ModelChoice } from "../lib/models";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "./ui";

const STATUS: Record<string, string> = {
  loaded: "Loaded",
  loading: "Loading",
  unloaded: "Not loaded",
  unknown: "",
};

/** The model beside Send: a menu grouped by provider. */
export function ModelPicker(props: {
  models: ModelListDto | undefined;
  value: ModelChoice | null;
  onChange: (choice: ModelChoice) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}) {
  const none = allModels(props.models).length === 0;
  const label = props.value ? modelLabel(props.value.model) : none ? "No models" : "Choose model";
  return (
    <Menu
      {...(props.open === undefined ? {} : { open: props.open })}
      {...(props.onOpenChange ? { onOpenChange: props.onOpenChange } : {})}
    >
      <MenuTrigger asChild disabled={props.disabled === true || none}>
        <button
          type="button"
          className="model-trigger"
          aria-label={
            props.value ? `Model: ${label}` : none ? "Model: none available" : "Model: choose"
          }
        >
          <span className="model-name">{label}</span>
          <ChevronDown size={16} aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent align="end" side="top" className="model-menu" tabIndex={0}>
        {props.models?.providers.map((group, _i, groups) =>
          group.models.length === 0 ? null : (
            <div key={group.provider.id} role="group" aria-label={group.provider.name}>
              {/* One provider needs no heading, unless it has a warning to carry. */}
              {groups.filter((g) => g.models.length > 0).length > 1 || group.stale ? (
                <MenuLabel>
                  {group.provider.name}
                  {group.stale ? " · may be out of date" : ""}
                </MenuLabel>
              ) : null}
              {group.models.map((m) => {
                const selected =
                  props.value?.providerId === m.providerId && props.value.model === m.id;
                const hints = [
                  STATUS[m.status],
                  m.capabilities.inputModalities.includes("image") ? "Images" : "",
                  m.capabilities.inputModalities.includes("audio") ? "Audio" : "",
                  m.capabilities.reasoning ? "Reasoning" : "",
                ].filter(Boolean);
                return (
                  <MenuItem
                    key={`${m.providerId}/${m.id}`}
                    data-model={JSON.stringify([m.providerId, m.id])}
                    hint={hints.length ? hints.join(" · ") : undefined}
                    icon={<Check size={18} aria-hidden className={selected ? "" : "invisible"} />}
                    onSelect={() => {
                      props.onChange({ providerId: m.providerId, model: m.id });
                    }}
                  >
                    {modelLabel(m.id)}
                  </MenuItem>
                );
              })}
            </div>
          ),
        )}
      </MenuContent>
    </Menu>
  );
}
