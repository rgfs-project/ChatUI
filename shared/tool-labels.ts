// Zod-free: the browser imports these values.

/** A tool call while a reply streams (SSE `tool`, D2 amendment). */
export interface ToolActivity {
  callId: string;
  name: string;
  state: "running" | "done" | "error";
}

/** Human labels for tool chips (shared by the live reply and saved replies). */
export const TOOL_LABELS: Record<string, string> = {
  search_chats: "Searched chats",
  read_chat: "Read a chat",
  list_files: "Listed files",
  read_file: "Read a file",
  get_current_time: "Checked the time",
  calculate: "Calculated",
  create_file: "Created a file",
  remember: "Suggested a memory",
  update_memory: "Suggested a memory update",
  forget_memory: "Suggested forgetting a memory",
};
