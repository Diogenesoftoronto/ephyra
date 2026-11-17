import { useRef, useState, type AriaAttributes, type ReactNode } from "react";
import { Icon } from "./icons.tsx";
import { Button } from "./primitives.tsx";

export function FilePicker({ id, accept, file, disabled, onFile, preview, "aria-describedby": description, "aria-invalid": invalid }: {
  id?: string;
  accept?: string;
  file?: File;
  disabled?: boolean;
  onFile: (file: File | undefined) => void;
  preview?: ReactNode;
} & Pick<AriaAttributes, "aria-describedby" | "aria-invalid">) {
  const input = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState(false);
  const action = file ? "Change file" : "Choose file";

  return <div className="ui-file-picker" data-dragging={!disabled && dragging ? "" : undefined}
    onDragOver={event => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = disabled ? "none" : "copy";
      if (!disabled) setDragging(true);
    }}
    onDragLeave={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
    }}
    onDrop={event => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setDragging(false);
      const first = event.dataTransfer.files[0];
      if (!disabled && first) onFile(first);
    }}>
    <input ref={input} type="file" accept={accept} disabled={disabled} hidden onChange={event => {
      const selected = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (selected) onFile(selected);
    }} />
    <div className="ui-file-picker__mark" aria-hidden="true">
      {preview ?? <Icon name="upload" width={20} height={20} />}
    </div>
    <span className="ui-file-picker__name" role="status" title={file?.name}>{file?.name ?? "Drop a file here"}</span>
    <div className="ui-file-picker__actions">
      <Button ref={picker} id={id} disabled={disabled} aria-describedby={description} aria-invalid={invalid}
        aria-label={action} onClick={() => input.current?.click()}>{action}</Button>
      {file && <Button variant="ghost" disabled={disabled} onClick={() => {
        picker.current?.focus();
        onFile(undefined);
      }}>Clear file</Button>}
    </div>
  </div>;
}
