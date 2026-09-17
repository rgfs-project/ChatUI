import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Brain,
  Database,
  KeyRound,
  Plus,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { UserDto } from '@shared/auth';
import {
  ApiError,
  clearMyHistory,
  deleteMyMemory,
  importExport,
  saveMyMemory,
  setMyDefaultModel,
  setMyHistoryImages,
  setMyImageMaxEdge,
  updateMyAccount,
  type ImportReport,
} from './api.ts';
import { DEFAULT_MAX_EDGE } from './shrinkImage.ts';
import { Dialog } from './Dialog.tsx';
import { ModelSelect, type ModelChoice } from './ModelSelect.tsx';
import { Select } from './Select.tsx';
import { keys, useModels, useMyMemories, useMyPreferences } from './queries.ts';
import { Spinner } from './Spinner.tsx';
import { showToast, type ToastTone } from './toast.ts';

/**
 * A reader's own settings.
 *
 * The same shell as the admin panel, and deliberately so: these are the three
 * things an administrator could already do to an account — set its model,
 * clear its conversations, change its password — offered to the person the
 * account belongs to. Everything here acts on the caller alone; the routes
 * behind it take no user to act on.
 */

type Section = 'account' | 'model' | 'history' | 'memory' | 'import';

const SECTIONS: { id: Section; label: string; icon: typeof KeyRound }[] = [
  { id: 'account', label: 'Account', icon: KeyRound },
  { id: 'model', label: 'Model', icon: SlidersHorizontal },
  { id: 'history', label: 'Chat history', icon: Database },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'import', label: 'Import', icon: Upload },
];

export function SettingsPanel({
  user,
  onClose,
}: {
  user: UserDto;
  onClose: () => void;
}): React.JSX.Element {
  const [section, setSection] = useState<Section>('account');

  return createPortal(
    <div
      className="panel"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="panel__card" role="dialog" aria-modal="true" aria-label="Settings">
        <nav className="panel__rail" aria-label="Settings sections">
          <button
            type="button"
            className="icon-button panel__close"
            onClick={onClose}
            aria-label="Close settings"
          >
            <X size={18} />
          </button>

          {/* Grouped so the narrow layout can scroll the sections sideways
              without the close button scrolling away with them. */}
          <div className="panel__rail-items">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={`panel__rail-item${section === id ? ' is-current' : ''}`}
                onClick={() => setSection(id)}
                aria-current={section === id}
              >
                <Icon size={17} />
                {label}
              </button>
            ))}
          </div>
        </nav>

        <div className="panel__pane">
          <h2 className="panel__title">{SECTIONS.find((s) => s.id === section)?.label}</h2>

          {section === 'account' && <Account user={user} />}
          {section === 'model' && (
            <>
              <DefaultModel />
              <HistoryImages />
              <ImageSize />
            </>
          )}
          {section === 'history' && <ChatHistory user={user} />}
          {section === 'memory' && <Memory />}
          {section === 'import' && <ImportChats />}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** One label/control row, the unit both panels are built from. */
function Row({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="panel__row">
      <div className="panel__row-text">
        <span className="panel__row-label">{label}</span>
        {description !== undefined && <p className="panel__row-desc">{description}</p>}
      </div>
      <div className="panel__row-control">{children}</div>
    </div>
  );
}

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}

/* --- account -------------------------------------------------------------- */

/**
 * Username and password, changed together.
 *
 * One form and one button, because both are the same request behind the same
 * proof: a session cookie says who you were when you signed in, which is not
 * the same as someone at the keyboard now being you. The new password is
 * optional so a rename does not force one.
 */
function Account({ user }: { user: UserDto }): React.JSX.Element {
  const client = useQueryClient();
  const [username, setUsername] = useState(user.username);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');

  const renaming = username.trim() !== '' && username.trim() !== user.username;
  const changed = renaming || next !== '';

  const save = useMutation({
    mutationFn: () =>
      updateMyAccount({
        ...(renaming ? { username: username.trim() } : {}),
        currentPassword: current,
        ...(next === '' ? {} : { newPassword: next }),
      }),
    onSuccess: () => {
      showToast('success', 'Saved.');
      setCurrent('');
      setNext('');
      // The session carries the username the header and the account row show.
      void client.invalidateQueries({ queryKey: keys.session() });
    },
    onError: (err) => showToast('error', message(err, 'Could not save those changes.')),
  });

  return (
    <form
      className="panel__form"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <p className="panel__row-desc">
        Changing your username or password needs your current password.
      </p>

      <label className="field">
        <span>Username</span>
        <input
          value={username}
          autoComplete="username"
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>
      <label className="field">
        <span>Current password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
      </label>
      <label className="field">
        <span>
          New password <span className="muted">— leave blank to keep it</span>
        </span>
        <input
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
      </label>

      <div className="panel__form-actions">
        <button
          type="submit"
          className="button-primary"
          disabled={!changed || current === '' || save.isPending}
        >
          Save changes
        </button>
      </div>
    </form>
  );
}

/* --- default model -------------------------------------------------------- */

function DefaultModel(): React.JSX.Element {
  const client = useQueryClient();
  const models = useModels(true);
  const preferences = useMyPreferences();

  const save = useMutation({
    mutationFn: (choice: ModelChoice | null) => setMyDefaultModel(choice),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.preferences() }),
    onError: (err) => showToast('error', message(err, 'Could not save your default model.')),
  });

  return (
    <Row
      label="Default model"
      description="What a new conversation starts on. A conversation you are already in keeps the model it was using."
    >
      <ModelSelect
        label="Default model"
        groups={models.data?.providers ?? []}
        value={preferences.data?.defaultModel ?? null}
        onChange={(choice) => save.mutate(choice)}
        disabled={preferences.isPending || models.isPending}
      />
    </Row>
  );
}

/* --- re-sent images ------------------------------------------------------- */

/** What the toggle turns on to, and what the stepper offers. */
const HISTORY_IMAGES_DEFAULT = 2;
const HISTORY_IMAGES_MAX = 20;

/**
 * How many earlier images go back up with each message.
 *
 * Two controls for one value because the value has two independent parts: it
 * is either "whatever the server decides" or a number this reader chose, and
 * `0` is one of the numbers they can choose. A stepper alone could not express
 * the difference between "re-send none" and "I have no opinion", which is why
 * the cleared state is a separate switch rather than a sentinel in the number.
 */
function HistoryImages(): React.JSX.Element {
  const client = useQueryClient();
  const preferences = useMyPreferences();
  const stored = preferences.data?.historyImages ?? null;

  /* Held while typing so a half-typed number is not saved on every keystroke;
     dropped on blur, when the stored value takes over again. */
  const [draft, setDraft] = useState<string | undefined>(undefined);

  const save = useMutation({
    mutationFn: (limit: number | null) => setMyHistoryImages(limit),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.preferences() }),
    onError: (err) => showToast('error', message(err, 'Could not save that setting.')),
  });

  const enabled = stored !== null;
  const shown = stored ?? HISTORY_IMAGES_DEFAULT;

  const commit = (raw: string): void => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(HISTORY_IMAGES_MAX, Math.max(0, Math.round(parsed)));
    if (clamped !== stored) save.mutate(clamped);
  };

  return (
    <Row
      label="Limit re-sent images"
      description="Each reply re-sends the images from earlier messages, and your provider encodes every one of them again. Limiting how many are re-sent makes replies faster in a conversation with several pictures in it. The images on the message you are sending now are always included."
    >
      <label className="switch">
        <input
          type="checkbox"
          checked={enabled}
          disabled={preferences.isPending || save.isPending}
          onChange={(event) => save.mutate(event.target.checked ? HISTORY_IMAGES_DEFAULT : null)}
        />
        <span className="switch__track" aria-hidden="true">
          <span className="switch__thumb" />
        </span>
        <span className="sr-only">Limit how many earlier images are re-sent</span>
      </label>

      <input
        className="sampler__number"
        type="number"
        min={0}
        max={HISTORY_IMAGES_MAX}
        step={1}
        value={draft ?? String(shown)}
        aria-label="Earlier images to re-send"
        disabled={!enabled || save.isPending}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          setDraft(undefined);
          if (event.target.value !== String(shown)) commit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </Row>
  );
}

/* --- picture size --------------------------------------------------------- */

/** Long edges offered, in pixels. The first is the built-in default. */
const EDGES = [
  { value: '1536', label: '1536 px — default' },
  { value: '2048', label: '2048 px — more detail' },
  { value: '1024', label: '1024 px — cheaper' },
  { value: '768', label: '768 px — cheapest' },
];

/**
 * How large a picture goes up.
 *
 * A model is charged for an image by area, and past the resolution it tiles to
 * the extra pixels are re-sampled away upstream and paid for on the way — so
 * the default is not a compromise for most pictures, it is free. It is worth
 * turning off for the case where the detail is the point: a dense screenshot,
 * a scan, a photograph of small print.
 */
function ImageSize(): React.JSX.Element {
  const client = useQueryClient();
  const preferences = useMyPreferences();
  const stored = preferences.data?.imageMaxEdge ?? null;

  const save = useMutation({
    mutationFn: (edge: number | null) => setMyImageMaxEdge(edge),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.preferences() }),
    onError: (err) => showToast('error', message(err, 'Could not save that setting.')),
  });

  /* `0` is off; `null` is "never chosen", which shrinks at the default. */
  const shrinking = stored !== 0;
  const edge = stored === null || stored === 0 ? DEFAULT_MAX_EDGE : stored;

  return (
    <Row
      label="Shrink pictures before sending"
      description="A model is charged for an image by its area, and past the size it works at the extra pixels are thrown away upstream and billed on the way. Turn this off when the detail is the point — a dense screenshot, or small print worth reading."
    >
      <label className="switch">
        <input
          type="checkbox"
          checked={shrinking}
          disabled={preferences.isPending || save.isPending}
          onChange={(event) => save.mutate(event.target.checked ? DEFAULT_MAX_EDGE : 0)}
        />
        <span className="switch__track" aria-hidden="true">
          <span className="switch__thumb" />
        </span>
        <span className="sr-only">Shrink pictures before sending</span>
      </label>

      <Select
        label="Longest edge"
        value={String(edge)}
        options={EDGES}
        disabled={!shrinking || save.isPending}
        onChange={(value) => save.mutate(Number(value))}
      />
    </Row>
  );
}

/* --- chat history --------------------------------------------------------- */

const WINDOWS = [
  { value: '1', label: 'Last hour' },
  { value: '6', label: 'Last 6 hours' },
  { value: '12', label: 'Last 12 hours' },
  { value: '24', label: 'Last day' },
  { value: '', label: 'Everything' },
];

function ChatHistory({ user }: { user: UserDto }): React.JSX.Element {
  const client = useQueryClient();
  const [window, setWindow] = useState('1');
  const [confirming, setConfirming] = useState(false);

  const clear = useMutation({
    mutationFn: () => clearMyHistory(window === '' ? undefined : Number(window)),
    onSuccess: (result) => {
      showToast(
        'success',
        `${result.deleted} conversation${result.deleted === 1 ? '' : 's'} deleted.`
      );
      void client.invalidateQueries({ queryKey: keys.conversations() });
    },
    onError: (err) => showToast('error', message(err, 'Could not clear your history.')),
  });

  return (
    <>
      <Row
        label="Clear chat history"
        description="Deletes your own stored conversations within a chosen window. The files go from disk; there is no undo."
      >
        <Select label="How far back" value={window} options={WINDOWS} onChange={setWindow} />
        <button type="button" onClick={() => setConfirming(true)}>
          <Trash2 size={15} />
          Clear
        </button>
      </Row>

      {confirming && (
        <Dialog
          title="Clear chat history?"
          body={`${WINDOWS.find((w) => w.value === window)?.label ?? 'Everything'}, for ${user.username}. The conversation files are removed from disk and cannot be recovered.`}
          confirmLabel="Clear"
          destructive
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            clear.mutate();
          }}
        />
      )}
    </>
  );
}

/* --- memory --------------------------------------------------------------- */

/**
 * What the model is told about this reader before every conversation.
 *
 * A list of plain statements rather than named documents: a memory is usually
 * one sentence, and making somebody name a file before they can write one down
 * is a tax on the feature. The list is shown in full because a memory nobody
 * can read back is one nobody can correct — and nothing is added to it except
 * by the person reading it.
 */
function Memory(): React.JSX.Element {
  const client = useQueryClient();
  const memories = useMyMemories();
  const [draft, setDraft] = useState('');

  const invalidate = (): void => void client.invalidateQueries({ queryKey: keys.memories() });

  const add = useMutation({
    mutationFn: (content: string) => saveMyMemory(content),
    onSuccess: () => {
      setDraft('');
      invalidate();
    },
    onError: (err) => showToast('error', message(err, 'Could not save that memory.')),
  });

  const remove = useMutation({
    mutationFn: (name: string) => deleteMyMemory(name),
    onSuccess: invalidate,
    onError: (err) => showToast('error', message(err, 'Could not delete that memory.')),
  });

  const list = memories.data ?? [];

  return (
    <>
      <p className="panel__row-desc">
        Told to the model at the start of every chat, in every conversation. Nothing is added here
        on its own — this list is exactly what it is told.
      </p>

      {memories.isPending && <Spinner small label="Loading memories…" />}

      <ul className="memories">
        {list.map((memory) => (
          <li key={memory.name} className="memories__item">
            <span className="memories__text">{memory.content.trim()}</span>
            <button
              type="button"
              className="icon-button"
              aria-label={`Forget: ${memory.content.trim().slice(0, 40)}`}
              title="Forget this"
              onClick={() => remove.mutate(memory.name)}
            >
              <X size={15} />
            </button>
          </li>
        ))}
      </ul>

      <form
        className="memories__add"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim() === '') return;
          add.mutate(draft.trim());
        }}
      >
        <input
          value={draft}
          placeholder="My dog's name is Beans"
          aria-label="Something to remember"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="submit"
          className="icon-button"
          aria-label="Remember this"
          title="Remember this"
          disabled={draft.trim() === '' || add.isPending}
        >
          <Plus size={16} />
        </button>
      </form>
    </>
  );
}

/* --- import --------------------------------------------------------------- */

function plural(count: number, word: string, irregular?: string): string {
  return count === 1 ? word : (irregular ?? `${word}s`);
}

/**
 * What an import actually did, one fact per line, as a toast to fire.
 *
 * The report used to be a single run-on sentence assembled from optional
 * clauses — including one that printed the literal string "memory/memories"
 * regardless of count, and left out the artifacts an export can carry
 * entirely. A reader could not tell at a glance what happened to what; this
 * says each thing plainly, and only says the things that are true (a count of
 * zero for some category is not news).
 */
function summarizeImport(report: ImportReport): { tone: ToastTone; message: React.ReactNode } {
  const lines: string[] = [];

  if (report.imported > 0) {
    lines.push(`Imported ${report.imported} ${plural(report.imported, 'chat')}`);
  }
  if (report.artifacts > 0) {
    lines.push(`Imported ${report.artifacts} ${plural(report.artifacts, 'artifact')}`);
  }
  if (report.memories > 0) {
    lines.push(`Imported ${report.memories} ${plural(report.memories, 'memory', 'memories')}`);
  }
  if (report.skippedExisting > 0) {
    lines.push(`${report.skippedExisting} ${plural(report.skippedExisting, 'chat')} already here`);
  }
  if (report.skippedEmpty > 0) {
    lines.push(`${report.skippedEmpty} empty ${plural(report.skippedEmpty, 'chat')} skipped`);
  }
  if (report.memoriesSkipped > 0) {
    lines.push(
      `${report.memoriesSkipped} ${plural(report.memoriesSkipped, 'memory', 'memories')} already here`
    );
  }
  if (report.artifactsSkipped > 0) {
    lines.push(`${report.artifactsSkipped} ${plural(report.artifactsSkipped, 'artifact')} skipped`);
  }
  if (report.toolBlocks > 0) {
    lines.push(`${report.toolBlocks} tool ${plural(report.toolBlocks, 'block')} left out`);
  }
  if (report.attachments > 0) {
    lines.push(`${report.attachments} ${plural(report.attachments, 'attachment')} left out`);
  }
  if (lines.length === 0) {
    lines.push('Nothing new to import.');
  }

  /*
   * Green only when the import was cleanly what it set out to be: something
   * new arrived and nothing was skipped or left out. Anything mixed — a
   * partial import, or one that added nothing because it had all been
   * imported before — is amber rather than green: true, but not a win.
   */
  const added = report.imported > 0 || report.artifacts > 0 || report.memories > 0;
  const partial =
    report.skippedExisting > 0 ||
    report.skippedEmpty > 0 ||
    report.memoriesSkipped > 0 ||
    report.artifactsSkipped > 0 ||
    report.toolBlocks > 0 ||
    report.attachments > 0;
  const clean = added && !partial;

  return {
    tone: clean ? 'success' : 'warning',
    message: (
      <span className="notice__lines">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    ),
  };
}

/**
 * Bringing conversations in from a Claude export.
 *
 * The whole zip is accepted, or any single file out of it, because that is
 * what people have to hand — and what was uploaded is decided by reading the
 * bytes rather than by trusting the name.
 */
function ImportChats(): React.JSX.Element {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement | null>(null);

  const upload = useMutation({
    mutationFn: (file: File) => importExport(file),
    onSuccess: (result) => {
      const summary = summarizeImport(result);
      showToast(summary.tone, summary.message);
      // Everything an export can carry, not only the conversations it is named
      // for. An import that brought artifacts in while the artifact list was
      // already cached left that list showing "nothing here yet" until a
      // reload — the data was on disk, and only the browser disagreed.
      void client.invalidateQueries({ queryKey: keys.conversations() });
      void client.invalidateQueries({ queryKey: keys.memories() });
      void client.invalidateQueries({ queryKey: keys.artifacts() });
    },
    onError: (err) => showToast('error', message(err, 'Could not import any data.')),
  });

  return (
    <>
      <p className="panel__row-desc">
        Import a Claude data export — the zip from Settings → Privacy → Export data, or the
        conversations.json inside it. Conversations already here are left alone, so importing the
        same export twice imports it once.
      </p>

      <input
        ref={input}
        type="file"
        accept=".zip,.json,application/zip,application/json"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file === undefined) return;
          upload.mutate(file);
        }}
      />

      <div className="panel__actions">
        <button type="button" onClick={() => input.current?.click()} disabled={upload.isPending}>
          <Upload size={15} />
          {upload.isPending ? 'Importing…' : 'Import chats'}
        </button>
      </div>
    </>
  );
}
