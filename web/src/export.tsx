import { exportUrl, type Place } from "./api.js";
import { buttonClass } from "./button.js";

/** Downloads a Project's or the Workspace's Terms and Decisions as a zip of `GLOSSARY.md` and `docs/adr/`. */
export function ExportLink({ place }: { place: Place }) {
  return (
    <p className="export">
      <a className={buttonClass("secondary")} href={exportUrl(place)} download title="GLOSSARY.md and docs/adr/, as a zip to commit into a Repository">
        Export
      </a>
    </p>
  );
}
