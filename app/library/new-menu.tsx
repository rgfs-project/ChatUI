import { useQueryClient } from "@tanstack/react-query";
import { Plus, SquarePen, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ACCEPT } from "../chat/composer-files";
import { apiUpload } from "../lib/api";
import { paths } from "../lib/paths";
import { qk } from "../lib/query/keys";
import { Menu, MenuItem } from "../ui/menu";
import { useToast } from "../ui/toast";

export function NewMenu({ userId }: { userId: string }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const picker = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(0);
  async function upload(list: File[]) {
    setUploading((n) => n + list.length);
    let failed = 0;
    for (const file of list) {
      try {
        await apiUpload("/api/attachments?to=library", file, file.name);
      } catch (error) {
        failed++;
        toast(`${file.name}: ${error instanceof Error ? error.message : "upload failed"}`, "error");
      } finally {
        setUploading((n) => n - 1);
      }
    }
    await client.invalidateQueries({ queryKey: qk.attachments(userId) });
    if (failed < list.length)
      toast(list.length - failed === 1 ? "File uploaded." : "Files uploaded.");
  }
  return (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        data-testid="library-file-input"
        onChange={(event) => {
          void upload(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      {uploading > 0 ? (
        <span className="library-uploading" role="status">
          Uploading {uploading}…
        </span>
      ) : null}
      <Menu
        label="New"
        align="end"
        trigger={
          <button type="button" className="pill-button pill-primary" aria-label="New">
            <Plus size={16} aria-hidden />
            <span>New</span>
          </button>
        }
      >
        <MenuItem
          icon={<Upload size={16} aria-hidden />}
          onSelect={() => {
            picker.current?.click();
          }}
        >
          Upload files
        </MenuItem>
        <MenuItem
          icon={<SquarePen size={16} aria-hidden />}
          onSelect={() => {
            void navigate(paths.newChat());
          }}
        >
          New chat
        </MenuItem>
      </Menu>
    </>
  );
}
