import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether the signed-in User may change what the page shows: false where they have Read, so the page leaves out what
 * would only be refused (`docs/ui.md`, the Read-only state). Cronk keeps the rules; this only hides the offer.
 */
const WriteAccess = createContext(true);

export const useCanWrite = (): boolean => useContext(WriteAccess);

/** Gives what is inside the Access of the Project it shows: Write, or Read for the Read-only state. */
export function ProjectAccessProvider({ access, children }: { access: "read" | "write"; children: ReactNode }) {
  return <WriteAccess.Provider value={access === "write"}>{children}</WriteAccess.Provider>;
}

/**
 * The line a page of a Project shows under its head when it offers no changes: the Project is archived, or the User
 * has Read in it.
 */
export function ProjectNote({ project }: { project: { access: "read" | "write"; archivedAt: string | null } }) {
  if (project.archivedAt !== null) {
    return (
      <p className="read-only-note muted small" role="note">
        This Project is archived: everyone reads it, but nothing in it changes until an Admin unarchives it.
      </p>
    );
  }
  return <ReadOnlyNote access={project.access} />;
}

/** The line a page shows under its head with Read in its Project, saying why it offers no changes. */
export function ReadOnlyNote({ access }: { access: "read" | "write" }) {
  if (access === "write") return null;
  return (
    <p className="read-only-note muted small" role="note">
      You have Read in this Project: you follow its work, but don't change it.
    </p>
  );
}
