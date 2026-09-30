/** A composer command, opened by typing "/" at the start of an empty message. */
export interface Command {
  name: string;
  description: string;
  /** A built-in action (runs now) or one of the user's skills (inserted as "/name "). */
  kind?: "command" | "skill";
}

/** The "/filter" typed so far, or null when the message is not a command. */
export function commandQuery(value: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(value);
  return match ? (match[1] ?? "") : null;
}

/** Prefix matches first, then other matches, in declaration order. */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const q = query.toLowerCase();
  const prefix = commands.filter((c) => c.name.startsWith(q));
  const rest = commands.filter((c) => !c.name.startsWith(q) && c.name.includes(q));
  return [...prefix, ...rest];
}

export const COMMAND_MENU_ID = "command-menu";
export const commandOptionId = (name: string) => `command-${name}`;

/**
 * The listbox under the "/" prefix. The message box keeps focus (it points
 * here with aria-controls/aria-activedescendant); pointer picks do not steal it.
 */
export function CommandMenu(props: {
  commands: readonly Command[];
  activeIndex: number;
  onPick: (command: Command) => void;
  onHover: (index: number) => void;
}) {
  const option = (command: Command, index: number) => (
    <div
      key={command.name}
      id={commandOptionId(command.name)}
      role="option"
      aria-selected={index === props.activeIndex}
      className="command-option"
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onPick(command);
      }}
      onMouseEnter={() => {
        props.onHover(index);
      }}
    >
      <span className="command-name">{command.name}</span>
      <span className="command-description">{command.description}</span>
    </div>
  );
  const indexed = props.commands.map((command, index) => ({ command, index }));
  const builtIn = indexed.filter(({ command }) => command.kind !== "skill");
  const skills = indexed.filter(({ command }) => command.kind === "skill");
  return (
    <div className="command-menu" id={COMMAND_MENU_ID} role="listbox" aria-label="Commands">
      {builtIn.map(({ command, index }) => option(command, index))}
      {skills.length > 0 ? (
        <div role="group" aria-labelledby="command-group-skills">
          <div className="command-group" id="command-group-skills" role="presentation">
            Skills
          </div>
          {skills.map(({ command, index }) => option(command, index))}
        </div>
      ) : null}
    </div>
  );
}
