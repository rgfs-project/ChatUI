// Generation checkpoints (contracts §1, §4; Phase 6). Loadable natively.
// Unfinished checkpoints are recovery state; finalized ones are disposable.
import { atomicWrite, durableUnlink, ensureDir, listDir, readOrNull } from "./fs.ts";
import { isUuid, type DataPaths } from "./paths.ts";
import type { ContinuationMessages } from "../providers/types.ts";
import type { MemorySnapshotEntry } from "./memories.ts";
import type { ProposalRecord } from "./proposals.ts";
import type { StagedCapture } from "../artifacts/capture.ts";

export type CheckpointState = "running" | "terminal-decided" | "terminal";

export interface CheckpointOutcome {
  state: "completed" | "cancelled" | "failed" | "timed_out";
  content: string;
  reasoning: string;
  finishReason: string | null;
  error: { code: string; message: string } | null;
  finishedAt: string;
  /**
   * Staged proposals (Phase 13b, contracts §4.3): written after the assistant
   * only when `state` is `completed`; discarded otherwise.
   */
  proposals?: ProposalRecord[];
  /** Staged source captures (Phase 13c), written after the proposals. */
  captures?: StagedCapture[];
}

export interface GenerationCheckpoint {
  version: 1;
  generationId: string;
  userId: string;
  conversationId: string;
  assistantMessageId: string;
  operationKey: string;
  providerId: string;
  model: string;
  state: CheckpointState;
  /** Streamed so far (running) — never read as conversation history. */
  content: string;
  reasoning: string;
  lastEventId: number;
  createdAt: string;
  updatedAt: string;
  /** Recorded before the Markdown write (terminal-decided). */
  outcome: CheckpointOutcome | null;
  /** Approved notes the prompt included (Phase 13b, contracts §4.1 step 2). */
  memorySnapshot?: MemorySnapshotEntry[];
  /** Staged proposals while running (Phase 13b). */
  proposals?: ProposalRecord[];
  /** The continuation's tool-call and result messages; never written to Markdown. */
  continuation?: ContinuationMessages | null;
}

function isCheckpoint(value: unknown): value is GenerationCheckpoint {
  const c = value as Partial<GenerationCheckpoint> | null;
  return (
    c?.version === 1 &&
    typeof c.generationId === "string" &&
    isUuid(c.generationId) &&
    typeof c.userId === "string" &&
    isUuid(c.userId) &&
    typeof c.conversationId === "string" &&
    isUuid(c.conversationId) &&
    typeof c.assistantMessageId === "string" &&
    (c.state === "running" || c.state === "terminal-decided" || c.state === "terminal") &&
    typeof c.content === "string" &&
    typeof c.reasoning === "string"
  );
}

export class CheckpointStore {
  private readonly paths: DataPaths;
  /** Checkpoint writes that happened (tests assert the cadence). */
  writes = 0;

  constructor(paths: DataPaths) {
    this.paths = paths;
  }

  async write(checkpoint: GenerationCheckpoint): Promise<void> {
    await ensureDir(this.paths.generationsDir());
    await atomicWrite(
      this.paths.generationFile(checkpoint.generationId),
      JSON.stringify(checkpoint),
    );
    this.writes++;
  }

  async read(generationId: string): Promise<GenerationCheckpoint | null> {
    const bytes = await readOrNull(this.paths.generationFile(generationId));
    if (!bytes) return null;
    try {
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      return isCheckpoint(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async delete(generationId: string): Promise<void> {
    await durableUnlink(this.paths.generationFile(generationId));
  }

  async all(): Promise<GenerationCheckpoint[]> {
    const out: GenerationCheckpoint[] = [];
    for (const name of await listDir(this.paths.generationsDir())) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!isUuid(id)) continue;
      const checkpoint = await this.read(id);
      if (checkpoint) out.push(checkpoint);
    }
    return out;
  }
}
