import { repositoryBranding, type RepositoryLogoUpdate } from "@ephyra/core";
import { useRef, useState } from "react";
import { Button, Field } from "../kit.ts";
import { AccountSaveFeedback, type AccountPageProps } from "./AccountForms.tsx";
import { RepositoryMark } from "./RepositoryMark.tsx";
import { useAccountWrite } from "./useAccountWrite.ts";

async function resizeLogo(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 2_000_000)
    throw new Error("Choose a PNG, JPEG or WebP image under 2 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 48;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable in this browser.");
    const scale = 48 / Math.max(bitmap.width, bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(bitmap, (48 - width) / 2, (48 - height) / 2, width, height);
    return canvas.toDataURL("image/png");
  } finally {
    bitmap.close();
  }
}

export function RepositoryLogoForm({ api, settings, onChange }: AccountPageProps) {
  const connected = settings.repository;
  const [address, setAddress] = useState(connected?.forge?.source ?? connected?.url ?? "");
  const [scope, setScope] = useState<RepositoryLogoUpdate["scope"]>("repository");
  const [error, setError] = useState<string>();
  const [reading, setReading] = useState(false);
  const [file, setFile] = useState<File>();
  const fileInput = useRef<HTMLInputElement>(null);
  const write = useAccountWrite(api, onChange);
  const target = repositoryBranding(address)[scope];
  const saved = target ? settings.repositoryLogos?.[target] : undefined;
  const locked = reading || write.locked;

  async function save(remove = false) {
    if (!target || locked || (!remove && !file)) return;
    setError(undefined);
    setReading(true);
    try {
      const image = remove ? null : await resizeLogo(file!);
      const next = await write.save({ expectedVersion: settings.version, address: address.trim(), scope, image },
        (input, key) => api.saveRepositoryLogo(input, key), remove ? "Logo removed." : "Logo saved.");
      if (next) {
        setFile(undefined);
        if (fileInput.current) fileInput.current.value = "";
      }
    } catch {
      setError("Choose a readable PNG, JPEG or WebP image under 2 MB.");
    } finally {
      setReading(false);
    }
  }

  return <details className="account-current">
    <summary>Repository and organization logos</summary>
    <form className="account-form" aria-label="Picker logos" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset className="account-fields" disabled={locked}>
        <Field label="Repository address" hint="For an organization logo, enter the address of any repository in that organization.">
          <input value={address} maxLength={2048} spellCheck={false} autoCapitalize="none"
            placeholder="https://github.com/team/project" onChange={event => setAddress(event.target.value)} />
        </Field>
        <Field label="Apply logo to">
          <select value={scope} onChange={event => setScope(event.target.value === "organization" ? "organization" : "repository")}>
            <option value="repository">This repository</option>
            <option value="organization">Its organization</option>
          </select>
        </Field>
        {address.trim() && !target && <p className="account-hint" role="status">Enter a repository address for the selected logo target.</p>}
        {saved && <div className="account-saved"><RepositoryMark name="Logo" sources={[saved]} /> <span>Saved logo</span></div>}
        <Field label="Logo image" hint="PNG, JPEG or WebP, up to 2 MB." error={error}>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={event => {
            setError(undefined);
            setFile(event.target.files?.[0]);
          }} />
        </Field>
      </fieldset>
      <AccountSaveFeedback state={write.state} onRefresh={() => void write.refresh()} />
      <div className="account-actions">
        <Button type="submit" disabled={!target || !file || locked} loading={reading || write.busy}>Save logo</Button>
        {saved && <Button type="button" variant="ghost" disabled={locked} onClick={() => void save(true)}>Remove logo</Button>}
      </div>
    </form>
  </details>;
}
