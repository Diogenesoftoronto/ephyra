import type { ReactNode } from "react";
import { JellySpecimen } from "./JellySpecimen.tsx";
import "./MaterialScene.css";

/** An illustrated introduction, never a source of health or activity status. */
export function MaterialScene({ title, description, compact = false, illustration, children }: {
  title: string; description: string; compact?: boolean; illustration?: string; children?: ReactNode;
}) {
  return (
    <aside className={`material-scene${compact ? " material-scene--compact" : ""}`} aria-label="About Ephyra">
      <div className="material-scene__top">
        <p className="material-scene__label">EPHYRA <span aria-hidden="true">/</span> SELF-DRIVING SOFTWARE</p>
      </div>
      {illustration ? <img className="material-scene__illustration" src={illustration} alt="" width={1440} height={960} decoding="async" />
        : <div className="material-scene__specimen"><JellySpecimen size={compact ? 180 : 320} /></div>}
      <div className="material-scene__copy">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {children}
    </aside>
  );
}
