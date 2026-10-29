import { useEffect } from "react";

type Probe = (event: string) => void;

function probe(): Probe | undefined {
  return (globalThis as { __chatuiRenderProbe?: Probe }).__chatuiRenderProbe;
}

/**
 * Test instrumentation (INV-32): reports renders and mounts of a component
 * when a test installs `globalThis.__chatuiRenderProbe`. A no-op otherwise.
 */
export function useRenderProbe(name: string): void {
  probe()?.(`render:${name}`);
  useEffect(() => {
    probe()?.(`mount:${name}`);
  }, [name]);
}
