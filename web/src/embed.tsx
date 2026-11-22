import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type { ArtifactMention } from "./api.js";
import { useAddresses } from "./addresses.js";
import { Link } from "./router.js";

/**
 * An Artifact's page in an iframe sandboxed as its address serves it, scripts allowed and its origin opaque, so it
 * never acts as the signed-in User (ADR 0004). The Artifact's own page and every Embed show it through this one
 * frame, so they can't drift apart. Nothing the page inside does sizes or moves the page around it.
 */
export function ArtifactFrame({
  url,
  title,
  className,
  style,
  lazy,
}: {
  url: string;
  title: string;
  className: string;
  style?: CSSProperties;
  lazy?: boolean;
}) {
  return (
    // Each Version has its own address, so a save shows afresh.
    <iframe
      key={url}
      className={className}
      title={title}
      src={url}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={style}
      loading={lazy ? "lazy" : undefined}
    />
  );
}

const startHeight = 320;
const minHeight = 160;
const maxHeight = 2400;
const keyStep = 40;
const clamp = (height: number) => Math.min(maxHeight, Math.max(minHeight, Math.round(height)));

/**
 * An Embed: an Artifact shown in place in Markdown, at the Version its address names or the latest, in the same
 * sandboxed frame as on its page. It starts at a fixed height; its handle, dragged or moved with the arrow keys,
 * makes it taller or shorter, and *Open* leads to the Artifact's page at the Version shown.
 */
export function Embed({ mention }: { mention: ArtifactMention }) {
  const to = useAddresses();
  const [height, setHeight] = useState(startHeight);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const page = `${to.artifact(mention)}${mention.version ? `?version=${mention.version}` : ""}`;

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { y: event.clientY, height };
    setDragging(true);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setHeight(clamp(drag.current.height + event.clientY - drag.current.y));
  };
  const end = () => {
    drag.current = null;
    setDragging(false);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = { ArrowDown: keyStep, ArrowUp: -keyStep }[event.key];
    if (by === undefined) return;
    event.preventDefault();
    setHeight((h) => clamp(h + by));
  };

  return (
    <figure className={`embed${dragging ? " embed-dragging" : ""}`} aria-label={`Embedded Artifact ${mention.title}`}>
      <figcaption className="embed-head">
        <span className="embed-title">{mention.title}</span>
        {mention.version !== null && <span className="muted"> · Version {mention.version}</span>}
        <Link className="embed-open" to={page}>
          Open
        </Link>
      </figcaption>
      <ArtifactFrame url={mention.url} title={mention.title} className="artifact-frame embed-frame" style={{ height }} lazy />
      <div
        className="embed-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label={`Resize ${mention.title}`}
        aria-valuenow={height}
        aria-valuemin={minHeight}
        aria-valuemax={maxHeight}
        tabIndex={0}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={key}
      />
    </figure>
  );
}
