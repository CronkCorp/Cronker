import { type ReactNode, useId } from "react";
import type { ProjectSummary } from "./api.js";

/**
 * One section of a knowledge page: a Project's knowledge or the Workspace's, under its own heading (the Project's key
 * in mono and its name, or "Workspace") with its own actions beside it.
 */
export function KnowledgeSection({
  project,
  actions,
  children,
}: {
  /** The Project whose section it is, or null for the Workspace's. */
  project: Pick<ProjectSummary, "key" | "name"> | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="knowledge-section">
      <div className="knowledge-section-head">
        <h2 id={id}>
          {project ? (
            <>
              <span className="mono">{project.key}</span> {project.name}
            </>
          ) : (
            "Workspace"
          )}
        </h2>
        {actions && <div className="knowledge-section-tools">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
