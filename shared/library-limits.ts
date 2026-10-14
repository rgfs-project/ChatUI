/** Library limits, zod-free so the browser can import them cheaply. */
export const LIBRARY_LIMITS = {
  maxProjects: 200,
  projectName: 80,
  projectDescription: 500,
  /** Project instructions, added to the system prompt of every chat in it. */
  projectInstructions: 8000,
} as const;
