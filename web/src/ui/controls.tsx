import { useEffect, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { useLiveState } from "../live.js";
import { Link } from "../router.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** The classes that make a link or file picker look like a button of the variant. */
export const buttonClass = (variant: ButtonVariant = "secondary", size: "normal" | "small" = "normal") =>
  `button button-${variant}${size === "small" ? " button-small" : ""}`;

/** A button: one primary per form or bar, secondary and ghost otherwise, danger only inside a confirming dialog. */
export function Button({
  variant = "secondary",
  size = "normal",
  className,
  type = "button",
  ...props
}: { variant?: ButtonVariant; size?: "normal" | "small" } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} type={type} className={`${buttonClass(variant, size)}${className ? ` ${className}` : ""}`} />;
}

/** A field with its label above it, in 12px muted, and an optional hint under it. */
export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`field${className ? ` ${className}` : ""}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** A checkbox or radio with its label beside it. */
export function Check({ label, hint, ...input }: { label: ReactNode; hint?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="check">
      <input type="checkbox" {...input} />
      <span>
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </span>
    </label>
  );
}

/** Why Cronk refused, under the form it refused, as Cronk gave it. */
export function FormError({ error }: { error: string | null | undefined }) {
  return error ? (
    <p role="alert" className="form-error">
      {error}
    </p>
  ) : null;
}

/** "Saved." beside a settings page's buttons. */
export function Saved({ shown, children = "Saved." }: { shown: boolean; children?: ReactNode }) {
  return shown ? (
    <span role="status" className="saved">
      {children}
    </span>
  ) : null;
}

/** A row of buttons: in forms and action bars the primary comes first. */
export function Actions({ children, end = false }: { children: ReactNode; end?: boolean }) {
  return <div className={`actions${end ? " actions-end" : ""}`}>{children}</div>;
}

/** A full-width box above an editor or detail: info says what to settle, warn what to heed. */
export function Banner({ tone, children, label }: { tone: "info" | "warn"; children: ReactNode; label?: string }) {
  return (
    <div className={`banner banner-${tone}`} role="note" aria-label={label}>
      {children}
    </div>
  );
}

/** What will appear here, and how it gets there. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <p className="empty-line">{children}</p>}
    </div>
  );
}

export interface Crumb {
  label: ReactNode;
  to?: string;
}

/** The head of a page: breadcrumbs, then the title, its view switcher and its actions, the primary last. */
export function PageHead({
  crumbs,
  title,
  meta,
  switcher,
  actions,
  large = false,
}: {
  crumbs?: Crumb[];
  title: ReactNode;
  /** A line under the title. */
  meta?: ReactNode;
  switcher?: ReactNode;
  actions?: ReactNode;
  /** A Ticket's, Document's or Decision's title, at 24px. */
  large?: boolean;
}) {
  return (
    <header className="page-head">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumbs" className="crumbs">
          {crumbs.map((crumb, index) => (
            <span key={index} className="crumb">
              {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : <span>{crumb.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="page-head-row">
        <h1 className={large ? "title-large" : undefined}>{title}</h1>
        {(switcher || actions) && (
          <div className="page-head-tools">
            {switcher}
            {actions}
          </div>
        )}
      </div>
      {meta && <div className="page-head-meta">{meta}</div>}
    </header>
  );
}

/** A segmented control of links, such as List / Board or Workspace / Project. */
export function Segmented({ label, items }: { label: string; items: { label: ReactNode; to: string; current: boolean }[] }) {
  return (
    <nav aria-label={label} className="segmented">
      {items.map((item) => (
        <Link key={item.to} to={item.to} current={item.current}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

/** A panel: a bordered surface, optionally with a heading. */
export function Panel({
  title,
  description,
  children,
  className,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const generated = useId();
  const headingId = id ? `${id}-heading` : generated;
  return (
    <section className={`panel${className ? ` ${className}` : ""}`} aria-labelledby={title ? headingId : undefined}>
      {title && (
        <div className="panel-head">
          <h2 id={headingId}>{title}</h2>
          {description && <p className="muted">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

/** The current time, moving on each minute, for relative times. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const yesterdayOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);

/** "10:18", in the 24-hour clock. */
export const clockTime = (date: Date) =>
  `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

/** "14 Nov", with the year when it isn't the current one. */
export const dayShown = (date: Date, now: Date) =>
  `${date.getDate()} ${date.toLocaleString("en-GB", { month: "short" })}${date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`}`;

/** How a time reads: relative under an hour, then the clock today, "yesterday", then day and time. */
export function relativeTime(date: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes >= 0 && minutes < 1) return "just now";
  if (minutes >= 0 && minutes < 60) return `${minutes} min ago`;
  if (sameDay(date, now)) return clockTime(date);
  if (sameDay(date, yesterdayOf(now))) return "yesterday";
  return `${dayShown(date, now)} ${clockTime(date)}`;
}

/** A day separator on a timeline: "Today", "Yesterday" or "14 Nov". */
export function daySeparator(date: Date, now: Date): string {
  if (sameDay(date, now)) return "Today";
  if (sameDay(date, yesterdayOf(now))) return "Yesterday";
  return dayShown(date, now);
}

/** A time as it reads relative to now, with the exact time in its tooltip. */
export function RelativeTime({ at, clock = false }: { at: string; /** Clock time only, as on a timeline. */ clock?: boolean }) {
  const now = useNow();
  const date = new Date(at);
  return (
    <time dateTime={at} title={date.toLocaleString()} className="time">
      {clock ? clockTime(date) : relativeTime(date, now)}
    </time>
  );
}

/** Whether a streaming view is current: "Live", or "Reconnecting…" while its stream is away. */
export function LiveIndicator({ workspaceId }: { workspaceId: string }) {
  const state = useLiveState(workspaceId);
  return (
    <span className={`live live-${state}`}>
      <span className="live-dot" aria-hidden="true" />
      {state === "live" ? "Live" : "Reconnecting…"}
    </span>
  );
}
