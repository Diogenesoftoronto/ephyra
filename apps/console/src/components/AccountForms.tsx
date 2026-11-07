import { useEffect, useId, useState } from "react";
import type { AccountSettings, ModelProvider, ModelUpdate, RepositoryUpdate } from "@ephyra/core";
import type { AccountApi } from "../account-api.ts";
import { Button, Field, Tag } from "../kit.ts";
import { useAccountWrite, type AccountWriteState } from "./useAccountWrite.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { normalizeCatalogBaseUrl, type ModelCatalog } from "../model-catalog.ts";
import "./AccountForms.css";

export interface AccountPageProps {
  api: AccountApi;
  settings: AccountSettings;
  onChange: (settings: AccountSettings) => void;
  onDone?: () => void;
  loadCatalog?: () => Promise<ModelCatalog>;
}
export interface AccountFormProps extends AccountPageProps {
  onBusyChange?: (busy: boolean) => void;
}

const providers: Record<ModelProvider, string> = {
  none: "Configure later",
  notorganic: "Not Organic account",
  openai: "OpenAI",
  anthropic: "Anthropic-compatible",
  compatible: "OpenAI-compatible",
};
const providerDescriptions: Record<ModelProvider, string> = {
  none: "Start with documents. Add model access when you need it.",
  notorganic: "Use hosted models through your signed-in account.",
  openai: "Bring your own OpenAI API key.",
  anthropic: "Use Anthropic or a compatible Messages endpoint.",
  compatible: "Bring a key for a compatible Chat Completions endpoint.",
};
export const modelProviderName = (provider: ModelProvider) => providers[provider];
const statusNames: Record<AccountSettings["model"]["status"], string> = {
  not_configured: "Not configured",
  saved: "Saved, not verified",
  verified: "Access verified",
  needs_sign_in: "Sign-in needed",
  unavailable: "Unavailable",
};

export function AccountSaveFeedback({ state, onRefresh }: { state: AccountWriteState; onRefresh: () => void }) {
  if (state.kind === "idle") return null;
  const failed = state.kind === "error" || state.kind === "stale" || state.kind === "uncertain";
  return (
    <div className="account-feedback" data-tone={failed ? "warning" : "quiet"} role={failed ? "alert" : "status"}>
      <p>
        {state.kind === "saving"
          ? "Saving settings…"
          : state.kind === "refreshing"
            ? "Reading saved settings…"
            : state.message}
      </p>
      {failed && (
        <Button size="sm" onClick={onRefresh}>
          Refresh saved settings
        </Button>
      )}
    </div>
  );
}

export function RepositoryForm({ api, settings, onChange, onDone, onBusyChange }: AccountFormProps) {
  const repository = settings.repository;
  const [url, setUrl] = useState(repository?.url ?? "");
  const [branch, setBranch] = useState(repository?.branch ?? "main");
  const [username, setUsername] = useState(repository?.username ?? "");
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [urlError, setUrlError] = useState<string>();
  const write = useAccountWrite(api, onChange);
  useEffect(() => {
    onBusyChange?.(write.locked);
    return () => onBusyChange?.(false);
  }, [write.locked, onBusyChange]);
  useEffect(() => {
    setUrl(settings.repository?.url ?? "");
    setBranch(settings.repository?.branch ?? "main");
    setUsername(settings.repository?.username ?? "");
    setToken("");
    setClearToken(false);
    setUrlError(undefined);
  }, [settings.version, settings.workspaceId]);
  const sameRepository = url.trim() === repository?.url;

  return (
    <form
      className="account-form"
      aria-label="Repository settings"
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          const parsed = new URL(url.trim());
          if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash)
            throw new Error();
        } catch {
          setUrlError("Use an HTTPS clone URL without credentials, query parameters or fragments.");
          return;
        }
        setUrlError(undefined);
        const input: RepositoryUpdate = {
          expectedVersion: settings.version,
          url: url.trim(),
          branch: branch.trim(),
          username: username.trim(),
          ...(token.trim() ? { token: token.trim() } : {}),
          ...(clearToken ? { clearToken: true } : {}),
        };
        const next = await write.save(
          input,
          (value, key) => api.saveRepository(value, key),
          "Repository verified and saved.",
        );
        if (next) {
          setToken("");
          setClearToken(false);
          onDone?.();
        }
      }}
    >
      {repository && (
        <div className="account-saved">
          <Tag>Branch verified</Tag>
          <span>
            {repository.branch} · <code>{repository.head.slice(0, 12)}</code>
          </span>
        </div>
      )}
      <fieldset className="account-fields" disabled={write.locked}>
        <Field label="Repository clone URL" hint="Use the HTTPS clone URL from your git host." error={urlError}>
          <input
            type="url"
            required
            maxLength={2048}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={url}
            placeholder="https://git.example.org/team/project.git"
            onChange={(e) => {
              setUrl(e.target.value);
              setUrlError(undefined);
            }}
          />
        </Field>
        <Field label="Branch" hint="Ephyra checks that this branch can be fetched before saving.">
          <input
            required
            maxLength={200}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
        </Field>
        <details className="account-advanced">
          <summary>Private repository access</summary>
          <div className="account-advanced-fields">
            <Field label="Git username" hint="Only needed if your git host requires a username with its access token.">
              <input
                autoComplete="username"
                maxLength={200}
                spellCheck={false}
                autoCapitalize="none"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </Field>
            <Field
              label={sameRepository && repository?.credentialConfigured ? "Replace access token" : "Access token"}
              hint={
                sameRepository && repository?.credentialConfigured
                  ? "A token is saved. Leave this blank to keep it."
                  : "The token is sent to the server for this connection. It is never shown again."
              }
            >
              <input
                type="password"
                autoComplete="new-password"
                maxLength={8192}
                value={token}
                disabled={clearToken}
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>
            {sameRepository && repository?.credentialConfigured && (
              <label className="account-checkbox">
                <input
                  type="checkbox"
                  checked={clearToken}
                  onChange={(e) => {
                    setClearToken(e.target.checked);
                    setToken("");
                  }}
                />
                Remove saved token
              </label>
            )}
          </div>
        </details>
      </fieldset>
      <p className="account-hint">
        Saving fetches this branch. Changing the repository or branch opens a separate document workspace.
      </p>
      <AccountSaveFeedback state={write.state} onRefresh={() => void write.refresh()} />
      <div className="account-actions">
        <Button
          type="submit"
          variant="primary"
          loading={write.busy}
          disabled={write.locked}
          data-account-action="save-repository"
        >
          {onDone ? "Verify repository and continue" : "Verify and save repository"}
        </Button>
      </div>
    </form>
  );
}

export function ModelAccessForm({ api, settings, onChange, onDone, onBusyChange, loadCatalog }: AccountFormProps) {
  const providerGroup = useId();
  const [provider, setProvider] = useState<ModelProvider>(settings.model.provider);
  const [model, setModel] = useState(settings.model.model);
  const [baseUrl, setBaseUrl] = useState(settings.model.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const write = useAccountWrite(api, onChange);
  useEffect(() => {
    onBusyChange?.(write.locked);
    return () => onBusyChange?.(false);
  }, [write.locked, onBusyChange]);
  useEffect(() => {
    setProvider(settings.model.provider);
    setModel(settings.model.model);
    setBaseUrl(settings.model.baseUrl ?? "");
    setApiKey("");
    setClearKey(false);
  }, [settings.version, settings.workspaceId]);
  const needsKey = provider !== "none" && provider !== "notorganic";
  const defaultBase = (value: ModelProvider) =>
    value === "openai" ? "https://api.openai.com/v1" : value === "anthropic" ? "https://api.anthropic.com/v1" : "";
  const destination = normalizeCatalogBaseUrl(
    provider === "openai" ? defaultBase(provider) : baseUrl || defaultBase(provider),
  );
  const savedDestination = normalizeCatalogBaseUrl(settings.model.baseUrl || defaultBase(settings.model.provider));
  const savedKey =
    provider === settings.model.provider && destination === savedDestination && settings.model.keyConfigured;
  function chooseProvider(next: ModelProvider) {
    setProvider(next);
    setApiKey("");
    setClearKey(false);
    setModel(next === settings.model.provider ? settings.model.model : "");
    setBaseUrl(next === settings.model.provider ? (settings.model.baseUrl ?? "") : "");
  }
  return (
    <form
      className="account-form"
      aria-label="Model access settings"
      onSubmit={async (event) => {
        event.preventDefault();
        const input: ModelUpdate = {
          expectedVersion: settings.version,
          provider,
          model: provider === "none" ? "" : model.trim(),
          ...(provider === "compatible" || provider === "anthropic" ? { baseUrl: baseUrl.trim() } : {}),
          ...(needsKey && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(clearKey ? { clearKey: true } : {}),
        };
        const next = await write.save(
          input,
          (value, key) => api.saveModel(value, key),
          provider === "none"
            ? "Model access can be configured later."
            : "Model settings saved. See the saved access status below.",
        );
        if (next) {
          setApiKey("");
          setClearKey(false);
          onDone?.();
        }
      }}
    >
      <fieldset className="account-fields" disabled={write.locked}>
        <Field label="Model provider" hint="Choose an option with the arrow keys. Bringing your own key is optional.">
          <div className="account-provider-choices">
            {(["notorganic", "openai", "anthropic", "compatible", "none"] as const).map((value) => (
              <label
                key={value}
                className="account-provider-choice"
                data-selected={provider === value ? "" : undefined}
                data-provider={value}
              >
                <input
                  type="radio"
                  name={providerGroup}
                  value={value}
                  checked={provider === value}
                  onChange={() => chooseProvider(value)}
                />
                <span>
                  <strong>{providers[value]}</strong>
                  <span>{providerDescriptions[value]}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>
        {provider !== "none" && (
          <ModelPicker
            provider={provider}
            value={model}
            onChange={setModel}
            baseUrl={baseUrl}
            disabled={write.locked}
            loadCatalog={loadCatalog}
          />
        )}
        {needsKey && (
          <Field
            label={savedKey ? "Replace API key" : "API key"}
            hint={
              savedKey
                ? "A key is saved for this endpoint. Leave this blank to keep it. The saved key cannot be displayed."
                : "Your key is sent to the server and is never displayed or saved in browser storage. Changing endpoints requires a new key."
            }
          >
            <input
              type="password"
              autoComplete="new-password"
              maxLength={8192}
              value={apiKey}
              disabled={clearKey && savedKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
        )}
        {needsKey && savedKey && (
          <label className="account-checkbox">
            <input
              type="checkbox"
              checked={clearKey}
              onChange={(e) => {
                setClearKey(e.target.checked);
                setApiKey("");
              }}
            />
            Remove saved API key
          </label>
        )}
        {needsKey && (
          <details
            className="account-advanced"
            open={provider === "compatible" ? true : undefined}
            onInvalidCapture={(event) => {
              event.currentTarget.open = true;
            }}
          >
            <summary>Advanced connection settings</summary>
            <div className="account-advanced-fields">
              {provider === "openai" ? (
                <>
                  <p className="account-hint">
                    OpenAI uses its standard API endpoint. Choose OpenAI-compatible to use a different server.
                  </p>
                  <Button size="sm" onClick={() => chooseProvider("compatible")}>
                    Use a custom endpoint
                  </Button>
                </>
              ) : (
                <Field
                  label={provider === "anthropic" ? "API base URL (optional)" : "API base URL"}
                  hint={
                    provider === "anthropic"
                      ? "Leave blank to use Anthropic. For another server, enter its HTTPS Messages API base URL."
                      : "Use your provider's HTTPS API URL, including its version path if required."
                  }
                >
                  <input
                    type="url"
                    required={provider === "compatible"}
                    maxLength={2048}
                    value={baseUrl}
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="https://models.example.org/v1"
                    onChange={(e) => {
                      setBaseUrl(e.target.value);
                      setClearKey(false);
                    }}
                  />
                </Field>
              )}
            </div>
          </details>
        )}
      </fieldset>
      {provider === "none" ? (
        <p className="account-hint">
          You can write and edit policy documents now. Agent assistance will wait until model access is configured.
        </p>
      ) : provider === "notorganic" ? (
        <p className="account-hint">
          Uses your signed-in Not Organic account. Save your choice first. If access needs permission, sign in again
          using the link below.
        </p>
      ) : (
        <p className="account-hint">
          Saving does not run a paid model request. A saved key is not proof that model requests will succeed.
        </p>
      )}
      <AccountSaveFeedback state={write.state} onRefresh={() => void write.refresh()} />
      <div className="account-actions">
        <Button
          type="submit"
          variant="primary"
          loading={write.busy}
          disabled={write.locked}
          data-account-action="save-model"
        >
          {onDone
            ? provider === "none"
              ? "Continue without a model"
              : "Save model access and continue"
            : "Save model access"}
        </Button>
      </div>
      <div className="account-current">
        <span className="account-label">Saved model access</span>
        <div className="account-saved">
          <strong>{providers[settings.model.provider]}</strong>
          <Tag>{statusNames[settings.model.status]}</Tag>
          {settings.model.keyConfigured && <span>Key saved</span>}
        </div>
        {settings.model.model && <code>{settings.model.model}</code>}
        {settings.model.detail && <p className="account-hint">{settings.model.detail}</p>}
        {settings.model.provider === "notorganic" && settings.model.status === "needs_sign_in" && (
          <a href="/auth/login?setup=1">Sign in to allow model access</a>
        )}
      </div>
    </form>
  );
}

export function SetupReview({ settings }: { settings: AccountSettings }) {
  return (
    <div className="account-review">
      <dl>
        <div>
          <dt>Repository</dt>
          <dd>
            {settings.repository ? (
              <>
                <span>{settings.repository.url}</span>
                <span>
                  {settings.repository.branch} · <code>{settings.repository.head.slice(0, 12)}</code>
                </span>
                <Tag>Branch verified</Tag>
              </>
            ) : (
              "Not connected. You can add one in Settings."
            )}
          </dd>
        </div>
        <div>
          <dt>Model access</dt>
          <dd>
            <span>{providers[settings.model.provider]}</span>
            {settings.model.model && <code>{settings.model.model}</code>}
            <Tag>{statusNames[settings.model.status]}</Tag>
            {settings.model.provider === "notorganic" && settings.model.status === "needs_sign_in" && (
              <a href="/auth/login?setup=1">Sign in to allow model access</a>
            )}
          </dd>
        </div>
        <div>
          <dt>Code execution</dt>
          <dd>Not configured. Connecting a repository does not start autonomous code changes or deployments.</dd>
        </div>
      </dl>
      <p className="account-hint">
        Your workspace is ready for writing intent and autonomy policies. Agent assistance uses your saved model access
        when available.
      </p>
    </div>
  );
}
