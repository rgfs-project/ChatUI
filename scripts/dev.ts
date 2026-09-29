/**
 * `npm run dev`: runs `dev:server` (Express + embedded Vite with HMR, restarted
 * on server/shared changes) and `dev:client` (route type generation in watch
 * mode) together, and stops both on Ctrl+C.
 */
import { spawn, type ChildProcess } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children: ChildProcess[] = ["dev:client", "dev:server"].map((script) =>
  spawn(npm, ["run", "--silent", script], { stdio: "inherit", env: process.env }),
);

let stopping = false;
function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}

for (const child of children) {
  child.once("exit", (code) => {
    if (!stopping) process.exitCode = code ?? 1;
    stop("SIGTERM");
  });
}
process.once("SIGINT", () => {
  stop("SIGINT");
});
process.once("SIGTERM", () => {
  stop("SIGTERM");
});
