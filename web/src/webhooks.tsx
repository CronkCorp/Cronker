import { useCallback, useEffect, useState } from "react";
import { api, type Webhook, type WebhookDelivery, type WebhookKind, type WorkspaceSummary } from "./api.js";
import { field, useSubmit } from "./forms.js";
import { Actions, Button, Check, EmptyState, Field, FormError, Panel, RelativeTime, Saved, ShownOnce } from "./ui/controls.js";
import { Chip } from "./ui/labels.js";
import { ConfirmDialog } from "./ui/overlays.js";

/** The Inbox kinds a webhook may get, as the settings page names them; the first three are a new webhook's default. */
const kinds: { kind: WebhookKind; label: string; hint?: string }[] = [
  { kind: "question", label: "Questions" },
  { kind: "needsYou", label: "Needs you" },
  { kind: "run", label: "Runs gone wrong", hint: "Failed, lost and unstarted Runs." },
  { kind: "review", label: "To review" },
  { kind: "unverified", label: "Unverified" },
  { kind: "discovered", label: "Discovered" },
  { kind: "reassign", label: "To reassign", hint: "For Admins: Tickets whose Assignee left or lost Write." },
  { kind: "undelegated", label: "Undelegated", hint: "Your Tickets undelegated when Agents lost Write in their Project." },
  { kind: "knowledge", label: "New knowledge", hint: "Decisions, Terms, Documents and Artifacts an Agent created." },
];
const defaultKinds: WebhookKind[] = ["question", "needsYou", "run"];

const kindsOf = (form: FormData) => form.getAll("kinds").map(String) as WebhookKind[];
const kindLabels = (chosen: WebhookKind[]) =>
  kinds
    .filter((k) => chosen.includes(k.kind))
    .map((k) => k.label)
    .join(", ");

/**
 * The signed-in User's webhooks in one of their Workspaces: add one (its secret shown once), check it with Send test
 * and its last deliveries, edit it, turn it off or remove it.
 */
export function WebhooksPanel({ workspaces, current }: { workspaces: WorkspaceSummary[]; current: WorkspaceSummary | undefined }) {
  const [workspaceId, setWorkspaceId] = useState(current?.id ?? workspaces[0]?.id ?? "");
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);

  const load = useCallback(() => {
    if (!workspaceId) return;
    api.webhooks(workspaceId).then(setWebhooks, (e: Error) => setError(e.message));
  }, [workspaceId]);
  useEffect(() => {
    setWebhooks(null);
    setCreated(null);
    setError(null);
    load();
  }, [load]);

  const add = useSubmit(async (form, element) => {
    const webhook = await api.createWebhook(workspaceId, { name: field(form, "name"), url: field(form, "url"), kinds: kindsOf(form) });
    setCreated({ name: webhook.name, secret: webhook.secret });
    element.reset();
    load();
  });

  return (
    <Panel
      title="Webhooks"
      id="webhooks"
      description="What waits in your Inbox, sent to ntfy, n8n, Discord, Home Assistant or your own receiver. Each delivery is signed with the webhook's secret."
    >
      {workspaces.length > 1 && (
        <Field label="Workspace">
          <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {workspaces.length === 0 && <p className="muted">Join a Workspace to add webhooks for it.</p>}
      <FormError error={error} />
      {created && (
        <ShownOnce banner="Webhook added" label={`Secret of ${created.name}`} secret={created.secret}>
          Your receiver checks each delivery's signature with it.
        </ShownOnce>
      )}
      {webhooks?.length === 0 && (
        <EmptyState title="No webhooks yet">Add one below to hear about what waits on you away from Cronk.</EmptyState>
      )}
      {webhooks?.map((webhook) => (
        <WebhookRow key={webhook.id} workspaceId={workspaceId} webhook={webhook} onChanged={load} />
      ))}
      {workspaceId && (
        <form onSubmit={add.onSubmit} aria-label="Add a webhook">
          <h3>Add a webhook</h3>
          <Field label="Name">
            <input name="name" required maxLength={200} autoComplete="off" placeholder="Phone" />
          </Field>
          <Field label="URL" hint="https, such as https://ntfy.sh/your-topic.">
            <input name="url" type="url" required autoComplete="off" className="mono" placeholder="https://ntfy.sh/your-topic" />
          </Field>
          <KindChecks chosen={defaultKinds} />
          <FormError error={add.error} />
          <Actions>
            <Button type="submit" variant="primary" disabled={add.busy}>
              Add webhook
            </Button>
          </Actions>
        </form>
      )}
    </Panel>
  );
}

function KindChecks({ chosen }: { chosen: WebhookKind[] }) {
  return (
    <fieldset>
      <legend>Inbox kinds it gets</legend>
      {kinds.map((k) => (
        <Check key={k.kind} name="kinds" value={k.kind} defaultChecked={chosen.includes(k.kind)} label={k.label} hint={k.hint} />
      ))}
    </fieldset>
  );
}

/** One webhook: what it gets, on or off, Send test, its last deliveries, Edit and Remove (which asks first). */
function WebhookRow({ workspaceId, webhook, onChanged }: { workspaceId: string; webhook: Webhook; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const loadDeliveries = useCallback(
    () => api.webhookDeliveries(workspaceId, webhook.id).then(setDeliveries, (e: Error) => setError(e.message)),
    [workspaceId, webhook.id],
  );
  useEffect(() => {
    void loadDeliveries();
  }, [loadDeliveries]);
  // While a delivery is pending, look again shortly after it is due: the server sends due deliveries every few
  // seconds, and one waiting for a retry is due at its next try. At most a minute apart, so a retry shows.
  const due = deliveries?.filter((d) => d.state === "pending").map((d) => (d.nextAt ? Date.parse(d.nextAt) : 0)) ?? [];
  const nextDue = due.length > 0 ? Math.min(...due) : null;
  useEffect(() => {
    if (nextDue === null) return;
    const wait = Math.min(Math.max(nextDue - Date.now() + 2_000, 2_000), 60_000);
    const timer = setTimeout(() => {
      void loadDeliveries();
      if (webhook.failing) onChanged();
    }, wait);
    return () => clearTimeout(timer);
  }, [nextDue, deliveries, loadDeliveries, webhook.failing, onChanged]);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    setSaved(false);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const edit = useSubmit(async (form) => {
    await api.editWebhook(workspaceId, webhook.id, { name: field(form, "name"), url: field(form, "url"), kinds: kindsOf(form) });
    setEditing(false);
    setSaved(true);
    onChanged();
  });

  return (
    <section className="webhook" aria-label={`Webhook ${webhook.name}`}>
      <div className="webhook-head">
        <div>
          <strong>{webhook.name}</strong>
          {!webhook.enabled && <span className="muted small"> · Off</span>}
          {webhook.failing && (
            <>
              {" "}
              <Chip tone="warn" title="Its last delivery was given up on after a day of retries. Its next successful delivery clears this.">
                Failing
              </Chip>
            </>
          )}
          <div className="mono small muted webhook-url">{webhook.url}</div>
          <div className="small muted">Gets: {kindLabels(webhook.kinds)}</div>
        </div>
      </div>
      {editing ? (
        <form onSubmit={edit.onSubmit} aria-label={`Edit ${webhook.name}`}>
          <Field label="Name">
            <input name="name" required maxLength={200} defaultValue={webhook.name} autoComplete="off" />
          </Field>
          <Field label="URL">
            <input name="url" type="url" required defaultValue={webhook.url} autoComplete="off" className="mono" />
          </Field>
          <KindChecks chosen={webhook.kinds} />
          <FormError error={edit.error} />
          <Actions>
            <Button type="submit" variant="primary" disabled={edit.busy}>
              Save webhook
            </Button>
            <Button onClick={() => setEditing(false)}>Cancel</Button>
          </Actions>
        </form>
      ) : (
        <Actions>
          <Button
            variant="primary"
            onClick={() =>
              run(async () => {
                await api.testWebhook(workspaceId, webhook.id);
                await loadDeliveries();
              })
            }
          >
            Send test
          </Button>
          <Check
            label="On"
            checked={webhook.enabled}
            onChange={(event) =>
              run(async () => {
                await api.editWebhook(workspaceId, webhook.id, { enabled: event.target.checked });
                setSaved(true);
                onChanged();
              })
            }
          />
          <Button onClick={() => setEditing(true)}>Edit</Button>
          <Button variant="ghost" onClick={() => setRemoving(true)}>
            Remove
          </Button>
          <Saved shown={saved} />
        </Actions>
      )}
      <FormError error={error} />
      <Deliveries deliveries={deliveries} />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${webhook.name}?`}
        confirm="Remove"
        onConfirm={async () => {
          await api.removeWebhook(workspaceId, webhook.id);
          onChanged();
        }}
      >
        Nothing more is sent to it, and its deliveries go with it.
      </ConfirmDialog>
    </section>
  );
}

function Deliveries({ deliveries }: { deliveries: WebhookDelivery[] | null }) {
  if (!deliveries) return null;
  if (deliveries.length === 0) return <p className="muted small">No deliveries yet. Send test to check it.</p>;
  return (
    <table aria-label="Last deliveries" className="webhook-deliveries">
      <thead>
        <tr>
          <th>Kind</th>
          <th>Answer</th>
          <th>Sent</th>
        </tr>
      </thead>
      <tbody>
        {deliveries.map((delivery) => (
          <tr key={delivery.id}>
            <td className="mono small">{delivery.kind}</td>
            <td className="small">
              {delivery.attempts.length === 0 ? (
                <span className="delivery-pending">Sending…</span>
              ) : (
                <ol className="delivery-attempts" aria-label="Tries">
                  {delivery.attempts.map((attempt, i) => (
                    <li key={i}>
                      <span className={delivered(attempt.statusCode) ? "delivery-delivered" : "delivery-failed"}>
                        {attempt.statusCode !== null ? String(attempt.statusCode) : (attempt.error ?? "No answer")}
                      </span>{" "}
                      <span className="muted">
                        <RelativeTime at={attempt.at} />
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {delivery.attempts.length > 0 && delivery.state === "pending" && delivery.nextAt && (
                <div className="delivery-pending">
                  Next try at <RelativeTime at={delivery.nextAt} clock />
                </div>
              )}
              {delivery.state === "failed" && <div className="delivery-failed">Gave up</div>}
            </td>
            <td className="muted small">{delivery.sentAt ? <RelativeTime at={delivery.sentAt} /> : <RelativeTime at={delivery.createdAt} />}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const delivered = (statusCode: number | null) => statusCode !== null && statusCode >= 200 && statusCode < 300;
