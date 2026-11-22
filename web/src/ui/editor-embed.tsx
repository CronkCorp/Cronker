import type { Node } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";
import { useContext, useEffect, useState } from "react";
import { api, type ArtifactMention } from "../api.js";
import { AddressContext } from "../addresses.js";
import { embedAddress } from "../editor/embed-address.js";
import { Embed } from "../embed.js";

/** An Embed's place in the editor's text, which the editor fills with `<EditorEmbed>` through a portal. */
export interface EmbedSlot {
  id: number;
  dom: HTMLElement;
  address: string;
}

let nextSlot = 0;

/**
 * An Embed's node view: one block the User can select, move or remove whole, but never type into. React draws the
 * Embed into it (`onShow`), so its frame, title and handle are the reading view's own; the handle, Open and the frame
 * keep their events from the editor, and the editor ignores what React does to the DOM.
 */
export function embedView(onShow: (slot: EmbedSlot) => void, onGone: (id: number) => void) {
  return (node: Node): NodeView => {
    const dom = document.createElement("div");
    dom.className = "rich-editor-embed";
    dom.contentEditable = "false";
    const id = nextSlot++;
    let address = String(node.attrs.address);
    onShow({ id, dom, address });
    return {
      dom,
      update(next) {
        if (next.type !== node.type) return false;
        if (next.attrs.address !== address) {
          address = String(next.attrs.address);
          onShow({ id, dom, address });
        }
        return true;
      },
      stopEvent: (event) => {
        const target = event.target as HTMLElement | null;
        return !!target?.closest?.(".embed-handle, .embed-open, iframe");
      },
      ignoreMutation: () => true,
      destroy: () => onGone(id),
    };
  };
}

type Shown = { address: string; mention: ArtifactMention | null };

/**
 * The Embed of an address in the editor, as it reads: the Artifact at the Version it names, fetched as the User may
 * read it. An address of an Artifact they can't read, of another Workspace, or of a Version it never had stays as
 * written, as on the reading side; so does one while it loads, or when it can't be fetched.
 */
export function EditorEmbed({ address }: { address: string }) {
  const { workspace } = useContext(AddressContext);
  const [shown, setShown] = useState<Shown>({ address, mention: null });
  useEffect(() => {
    const parsed = embedAddress(address);
    let current = true;
    if (!parsed || (parsed.workspace !== null && workspace && parsed.workspace !== workspace.slug.toLowerCase())) {
      setShown({ address, mention: null });
      return;
    }
    api.artifact(parsed.slug, parsed.version).then(
      (artifact) => {
        if (!current) return;
        const pinned = parsed.version;
        const found = pinned === null || artifact.version.number === pinned;
        setShown({
          address,
          mention: found
            ? { kind: "artifact", text: address, artifactId: artifact.id, slug: artifact.slug, title: artifact.title, version: pinned, url: artifact.url }
            : null,
        });
      },
      () => current && setShown({ address, mention: null }),
    );
    return () => {
      current = false;
    };
  }, [address, workspace?.slug]);
  const mention = shown.address === address ? shown.mention : null;
  return mention ? (
    <Embed mention={mention} />
  ) : (
    <p className="rich-editor-embed-address" title="An Artifact's address, edited in the Markdown source">
      {address}
    </p>
  );
}
