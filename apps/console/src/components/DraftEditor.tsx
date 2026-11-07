import { useEffect, useState } from "react";
import { Badge, Button, Field } from "../kit.ts";
import { describeError } from "../lib/errors.ts";
import { WarningList } from "./WarningList.tsx";
import "./DraftEditor.css";

/**
 * The generated document as plain text. Saving sends it to the server, which parses it again; the warnings shown are
 * those of the last saved text, and the editor says so while there are unsaved edits.
 */
export function DraftEditor({ path, content, warnings, readOnly, onSave }: {
  path: string; content: string; warnings: readonly string[]; readOnly?: boolean; onSave: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState(content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setText(content), [content]);
  const dirty = text !== content;
  const save = async () => {
    setBusy(true);
    setError(null);
    try { await onSave(text); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const failure = error ? describeError(error) : null;
  return (
    <div className="editor">
      <Field label={<span className="mono">{path}</span>} hint="Plain text. Velum's proposals and the map both write to this.">
        <textarea className="mono editor-text" rows={18} value={text} spellCheck={false} readOnly={readOnly} onChange={(e) => setText(e.target.value)} aria-describedby="editor-state" />
      </Field>
      <div className="editor-row" id="editor-state">
        {dirty ? <Badge tone="warn">Unsaved edits: the warnings below are for the saved text</Badge> : <Badge tone="ok">Saved</Badge>}
        {!readOnly && <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>Save</Button>}
        {dirty && <Button variant="ghost" disabled={busy} onClick={() => setText(content)}>Revert</Button>}
      </div>
      {failure && <p role="alert"><strong>{failure.title}.</strong> {failure.body}</p>}
      <WarningList warnings={warnings} />
    </div>
  );
}
