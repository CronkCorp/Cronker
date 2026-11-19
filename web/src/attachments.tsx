import { useState, type ChangeEvent } from "react";
import { api, attachmentUrl, type Attachment, type AttachmentOwner } from "./api.js";
import { Actor } from "./ui/actor.js";
import { buttonClass, Button, FormError, RelativeTime } from "./ui/controls.js";
import { ConfirmDialog, Dialog, DialogActions, DialogClose } from "./ui/overlays.js";

/** A size as people read it. */
export function sized(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How Markdown refers to the Attachment: shown as a picture when it is one, otherwise as a link. */
export function markdownReference(attachment: Attachment): string {
  const name = attachment.name.replace(/[[\]\\]/g, "\\$&");
  return `${attachment.mediaType.startsWith("image/") ? "!" : ""}[${name}](attachment:${attachment.id})`;
}

const isImage = (attachment: Attachment) => attachment.mediaType.startsWith("image/");

/** A file's type as a short word, such as PDF, for files that aren't pictures. */
const typeOf = (attachment: Attachment) =>
  (attachment.name.includes(".") ? attachment.name.split(".").pop()! : attachment.mediaType.split("/").pop()!).slice(0, 6).toUpperCase();

/** Attaches files one by one; Cronk refuses what isn't allowed, such as a file over its size limit. */
export async function attachAll(owner: AttachmentOwner, files: File[]): Promise<void> {
  for (const file of files) await api.attach(owner, file);
}

/**
 * The files attached to a Ticket, Document or Comment as thumbnails, each opening in a wide dialog, and a picker
 * to attach more, where the User may. Cronk decides who may; this only asks.
 */
export function Attachments({
  owner,
  attachments,
  label,
  canAttach = true,
  compact = false,
  dropHint,
  onChanged,
}: {
  owner: AttachmentOwner;
  attachments: Attachment[];
  label: string;
  canAttach?: boolean;
  /** Smaller thumbnails, as under a Comment. */
  compact?: boolean;
  /** Where else files may be dropped or pasted, beside the picker. */
  dropHint?: string;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Attachment | null>(null);

  const attach = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    input.value = "";
    setError(null);
    setBusy(true);
    attachAll(owner, files)
      .then(onChanged, (e: Error) => {
        setError(e.message);
        onChanged();
      })
      .finally(() => setBusy(false));
  };

  if (attachments.length === 0 && !canAttach) return null;
  return (
    <section aria-label={label} className={`attachments${compact ? " attachments-compact" : ""}`}>
      {attachments.length > 0 && (
        <ul className="thumbs">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <button type="button" className="thumb" onClick={() => setOpen(attachment)} aria-label={`Open ${attachment.name}`}>
                <span className="thumb-preview">
                  {isImage(attachment) ? (
                    <img src={attachmentUrl(attachment.id)} alt="" loading="lazy" />
                  ) : (
                    <span className="thumb-type">{typeOf(attachment)}</span>
                  )}
                </span>
                <span className="thumb-name">{attachment.name}</span>
                {!compact && (
                  <span className="thumb-meta">
                    {sized(attachment.size)} · {attachment.actor.name}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {canAttach && (
        <label className={`attach-drop${compact ? " attach-compact" : ""}`}>
          <input type="file" multiple disabled={busy} onChange={attach} className="sr-only" aria-label="Attach a file" />
          <span className={buttonClass(compact ? "ghost" : "secondary", "small")} aria-hidden="true">
            {busy ? "Attaching…" : compact ? "Attach a file" : "Attach files"}
          </span>
          {dropHint && <span className="muted small">{dropHint}</span>}
        </label>
      )}
      <FormError error={error} />
      {open && <AttachmentDialog attachment={open} canRemove={canAttach} onClose={() => setOpen(null)} onRemoved={onChanged} />}
    </section>
  );
}

/** Every file on a Ticket, in its Comments and Reports too, as a list for the side panel. */
export function FileList({ attachments, onChanged }: { attachments: Attachment[]; onChanged: () => void }) {
  const [open, setOpen] = useState<Attachment | null>(null);
  return (
    <section aria-label="Files" className="panel side-section">
      <h2 className="side-title">Files</h2>
      {attachments.length === 0 ? (
        <p className="muted small">None yet. Files attached to the Ticket, its Comments and Reports gather here.</p>
      ) : (
        <ul className="side-list">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <button type="button" className="link-button" onClick={() => setOpen(attachment)}>
                {attachment.name}
              </button>{" "}
              <span className="muted small">{sized(attachment.size)}</span>
            </li>
          ))}
        </ul>
      )}
      {open && <AttachmentDialog attachment={open} canRemove={false} onClose={() => setOpen(null)} onRemoved={onChanged} />}
    </section>
  );
}

/** One file in a wide dialog: a picture in full, anything else as its type, with Download; Remove asks first. */
function AttachmentDialog({
  attachment,
  canRemove,
  onClose,
  onRemoved,
}: {
  attachment: Attachment;
  canRemove: boolean;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <Dialog open={!removing} onOpenChange={(next) => !next && onClose()} title={attachment.name} wide>
        <p className="attachment-meta">
          {sized(attachment.size)} · <Actor actor={attachment.actor} /> · <RelativeTime at={attachment.createdAt} />
        </p>
        {isImage(attachment) ? (
          <img className="attachment-full" src={attachmentUrl(attachment.id)} alt={attachment.name} />
        ) : (
          <div className="attachment-type">{typeOf(attachment)}</div>
        )}
        <p className="small">
          <span className="muted">Markdown that shows it: </span>
          <code>{markdownReference(attachment)}</code>
        </p>
        <DialogActions>
          {canRemove && (
            <Button variant="ghost" onClick={() => setRemoving(true)}>
              Remove…
            </Button>
          )}
          <DialogClose asChild>
            <Button>Close</Button>
          </DialogClose>
          <a className={buttonClass("primary")} href={attachmentUrl(attachment.id)} download={attachment.name}>
            Download
          </a>
        </DialogActions>
      </Dialog>
      <ConfirmDialog
        open={removing}
        onOpenChange={(next) => (next ? setRemoving(true) : onClose())}
        title={`Remove ${attachment.name}?`}
        confirm="Remove"
        onConfirm={async () => {
          await api.removeAttachment(attachment.id);
          onRemoved();
        }}
      >
        Markdown that refers to it shows a broken link afterwards.
      </ConfirmDialog>
    </>
  );
}
