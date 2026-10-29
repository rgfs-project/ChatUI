import { useState } from "react";
import { Dialog } from "../ui/dialog";
import { useChat } from "./chat-context";

export function RenameDialog() {
  const { renameTarget, closeRename, submitRename } = useChat();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={renameTarget !== null}
      onOpenChange={(open) => {
        if (!open) closeRename();
      }}
      title="Rename chat"
      className="rename-dialog"
    >
      {renameTarget ? (
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            const title = new FormData(event.currentTarget).get("title");
            if (typeof title !== "string" || title.trim() === "") return;
            setBusy(true);
            void submitRename(title.trim()).finally(() => {
              setBusy(false);
            });
          }}
        >
          <label htmlFor="rename-title" className="visually-hidden">
            Chat title
          </label>
          <input
            id="rename-title"
            name="title"
            className="text-field selectable"
            defaultValue={renameTarget.title}
            maxLength={200}
            required
            autoFocus
          />
          <div className="dialog-actions">
            <button type="button" className="pill-button" onClick={closeRename}>
              Cancel
            </button>
            <button type="submit" className="pill-button pill-primary" disabled={busy}>
              Save
            </button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}
