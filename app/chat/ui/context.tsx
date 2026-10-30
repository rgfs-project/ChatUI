import { createContext, useContext } from "react";

/** Whether ```ui blocks render (Settings, Phase 14b) and whether the reply is still streaming. */
export const UiBlocksContext = createContext<{ enabled: boolean; streaming: boolean }>({
  enabled: true,
  streaming: false,
});

export function useUiBlocks(): { enabled: boolean; streaming: boolean } {
  return useContext(UiBlocksContext);
}
