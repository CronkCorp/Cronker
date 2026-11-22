import { useState } from "react";
import { api, type User, type WorkspaceSummary } from "./api.js";
import { field, useSubmit } from "./forms.js";
import { usePlace } from "./frame.js";
import { GitHubAccountPanel } from "./github.js";
import { chooseEditorMode, chooseTheme, storedEditorMode, storedTheme, type EditorMode, type Theme } from "./storage.js";
import { Actions, Button, Field, FormError, PageHead, Panel, Saved } from "./ui/controls.js";
import { SettingsLayout } from "./ui/settings.js";
import { WebhooksPanel } from "./webhooks.js";

/**
 * The signed-in User's own settings: their display name, how Cronk looks on this browser, their password, GitHub account
 * and webhooks, these in the Workspace on screen unless they pick another.
 */
export function AccountSettingsPage({
  user,
  onChanged,
  workspaces,
  current,
}: {
  user: User;
  onChanged: () => void;
  workspaces: WorkspaceSummary[];
  current: WorkspaceSummary | undefined;
}) {
  usePlace(null);
  return (
    <div className="page page-settings">
      <PageHead crumbs={[{ label: "Account" }]} title="Settings" />
      <SettingsLayout
        sections={[
          { id: "profile", label: "Profile", children: <Profile user={user} onChanged={onChanged} /> },
          { id: "appearance", label: "Appearance", children: <Appearance /> },
          { id: "password", label: "Password", children: <Password /> },
          { id: "github-account", label: "GitHub account", children: <GitHubAccountPanel user={user} /> },
          { id: "webhooks", label: "Webhooks", children: <WebhooksPanel workspaces={workspaces} current={current} /> },
        ]}
      />
    </div>
  );
}

function Profile({ user, onChanged }: { user: User; onChanged: () => void }) {
  const [saved, setSaved] = useState(false);
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    setSaved(false);
    await api.changeDisplayName(field(form, "displayName") || null);
    setSaved(true);
    onChanged();
  });
  const account = user.email ?? `@${user.githubLogin}`;
  return (
    <Panel title="Profile" id="profile" description={`You sign in as ${account}.`}>
      <form onSubmit={onSubmit}>
        <Field label="Display name" hint={`Shown where Cronk names you. Leave it empty to be shown as ${account}.`}>
          <input name="displayName" maxLength={80} defaultValue={user.displayName ?? ""} autoComplete="name" />
        </Field>
        <FormError error={error} />
        <Actions>
          <Button type="submit" variant="primary" disabled={busy}>
            Save display name
          </Button>
          <Saved shown={saved} />
        </Actions>
      </form>
    </Panel>
  );
}

/** Choices kept on this browser rather than on the User, so each device can differ; each applies at once. */
function Appearance() {
  const [theme, setTheme] = useState(storedTheme);
  const [editorMode, setEditorMode] = useState(storedEditorMode);
  const [saved, setSaved] = useState(false);
  return (
    <Panel title="Appearance" id="appearance" description="Kept on this browser, so each device can differ.">
      <fieldset>
        <legend>Theme</legend>
        {(
          [
            ["system", "System"],
            ["light", "Light"],
            ["dark", "Dark"],
          ] as [Theme, string][]
        ).map(([value, label]) => (
          <label key={value} className="check">
            <input
              type="radio"
              name="theme"
              value={value}
              checked={theme === value}
              onChange={() => {
                chooseTheme(value);
                setTheme(value);
                setSaved(true);
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Editor</legend>
        {(
          [
            ["rich", "Formatted text"],
            ["source", "Markdown source"],
          ] as [EditorMode, string][]
        ).map(([value, label]) => (
          <label key={value} className="check">
            <input
              type="radio"
              name="editorMode"
              value={value}
              checked={editorMode === value}
              onChange={() => {
                chooseEditorMode(value);
                setEditorMode(value);
                setSaved(true);
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <Saved shown={saved} />
    </Panel>
  );
}

function Password() {
  const [done, setDone] = useState(false);
  const { error, busy, onSubmit } = useSubmit(async (form, element) => {
    setDone(false);
    await api.changePassword(field(form, "currentPassword"), field(form, "newPassword"));
    element.reset();
    setDone(true);
  });
  return (
    <Panel title="Password" id="password">
      <form onSubmit={onSubmit}>
        <Field label="Current password">
          <input name="currentPassword" type="password" required autoComplete="current-password" />
        </Field>
        <Field label="New password" hint="At least 8 characters. Changing it ends your other sign-ins.">
          <input name="newPassword" type="password" required minLength={8} autoComplete="new-password" />
        </Field>
        <FormError error={error} />
        <Actions>
          <Button type="submit" variant="primary" disabled={busy}>
            Change password
          </Button>
          <Saved shown={done}>Password changed. Your other sign-ins have ended.</Saved>
        </Actions>
      </form>
    </Panel>
  );
}
