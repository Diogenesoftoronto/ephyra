import type { ReactNode } from "react";

/** The table convention from the visual system: `<table className="ui-table">` in a wrapper that scrolls sideways on a phone. */
export function DataTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ui-table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table className="ui-table">
        <caption className="sr-only">{label}</caption>
        {children}
      </table>
    </div>
  );
}
