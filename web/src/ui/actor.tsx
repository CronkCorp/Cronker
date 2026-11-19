/**
 * Who did something: a User (round, neutral avatar), an Agent (square, violet avatar and name, "for <Owner>"
 * where the Owner isn't obvious) or Cronk itself (muted text with a round "C").
 */

export type ActorRef =
  | { kind: "user"; name: string }
  | { kind: "agent"; name: string; owner?: string | null }
  | { kind: "cronk"; name?: string };

/** Two letters for an avatar: the first of two words, else the first two letters, of a name or an email's local part. */
export function initials(name: string): string {
  const base = name.replace(/^@/, "").split("@")[0]!;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

export function Avatar({ actor, size = "small", title }: { actor: ActorRef; size?: "small" | "medium"; title?: string }) {
  const text = actor.kind === "cronk" ? "C" : initials(actor.name);
  // The letters are drawn by CSS, so they stay out of the text around them. Named by its tooltip when shown
  // alone; otherwise the name beside it says who.
  return (
    <span
      className={`avatar avatar-${actor.kind} avatar-${size}`}
      data-initials={text}
      title={title}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    />
  );
}

/** An avatar and a name. */
export function Actor({ actor, avatar = true }: { actor: ActorRef; avatar?: boolean }) {
  const name = actor.kind === "cronk" ? "Cronk" : actor.name;
  return (
    <span className={`actor actor-${actor.kind}`}>
      {avatar && <Avatar actor={actor} />}
      <span className="actor-name">{name}</span>
      {actor.kind === "agent" && actor.owner && <span className="actor-owner"> for {actor.owner}</span>}
    </span>
  );
}
