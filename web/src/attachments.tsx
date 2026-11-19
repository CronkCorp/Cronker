import { useState, type ChangeEvent } from "react";
import { api, attachmentUrl, type Attachment, type AttachmentOwner } from "./api.js";
import { Button } from "./button.js";

/** A size as people read it. */
function sized(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How Markdown refers to the Attachment: shown as a picture when it is one, otherwise as a link. */
export function markdownReference(attachment: Attachment): string {
  const name = attachment.name.replace(/[[\]\\]/g, "\\$&");
  return `${attachment.mediaType.startsWith("image/") ? "!" : ""}[${name}](attachment:${attachment.id})`;
}

/**
 * The files attached to a Ticket, Document or Comment: each to download, with the Markdown that shows it, and
 * removable; and a picker to attach another, where the User may. Cronk decides who may; this only asks.
 */
export function Attachments({
  owner,
  attachments,
  label,
  canAttach = true,
  onChanged,
}: {
  owner: AttachmentOwner;
  attachments: Attachment[];
  label: string;
  canAttach?: boolean;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await work();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const attach = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    input.value = "";
    void run(async () => {
      for (const file of files) await api.attach(owner, file);
    });
  };

  if (attachments.length === 0 && !canAttach) return null;
  return (
    <section aria-label={label} className="attachments">
      {attachments.length > 0 && (
        <ul>
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <a href={attachmentUrl(attachment.id)} download={attachment.name}>
                {attachment.name}
              </a>{" "}
              <span className="muted">
                {sized(attachment.size)} · {attachment.actor.name}
              </span>{" "}
              <code title="Markdown that refers to it">{markdownReference(attachment)}</code>{" "}
              {canAttach && (
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => run(() => api.removeAttachment(attachment.id))}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canAttach && (
        <label className="attach">
          Attach a file
          <input type="file" multiple disabled={busy} onChange={attach} />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
