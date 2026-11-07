import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  catalogProvidersFor,
  loadModelCatalog,
  searchCatalogModels,
  type CatalogChoice,
  type CatalogModel,
  type CatalogSelection,
  type ModelCatalog,
} from "../model-catalog.ts";
import "./ModelPicker.css";

export type ModelPickerProps = {
  provider: CatalogSelection;
  value: string;
  onChange: (exactId: string) => void;
  baseUrl?: string;
  disabled?: boolean;
  id?: string;
  label?: string;
  /** Public-metadata fixture/adapter, not an account model list. */
  loadCatalog?: () => Promise<ModelCatalog>;
};
type CatalogState = { kind: "loading" | "unavailable" | "manual" } | { kind: "ready"; catalog: ModelCatalog };

const price = (amount: number | null) =>
  amount === null
    ? "unknown"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(amount);
const tokens = (count: number | null) =>
  count === null
    ? "Context unknown"
    : `${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(count)} context`;
function Capabilities({ model }: { model: CatalogModel }) {
  return (
    <span className="model-picker-capabilities">
      <span
        title={
          model.contextTokens === null ? undefined : `${model.contextTokens.toLocaleString("en-US")} context tokens`
        }
      >
        {tokens(model.contextTokens)}
      </span>
      <span>{model.tools === null ? "Tools unknown" : model.tools ? "Tools" : "No tools"}</span>
      <span>{model.reasoning === null ? "Reasoning unknown" : model.reasoning ? "Reasoning" : "No reasoning"}</span>
    </span>
  );
}

/** Editable combobox. Only an explicit option selection replaces typed text; Enter never guesses the first result. */
export function ModelPicker({
  provider,
  value,
  onChange,
  baseUrl,
  disabled = false,
  id: suppliedId,
  label = "Model ID",
  loadCatalog = loadModelCatalog,
}: ModelPickerProps) {
  const generatedId = useId();
  const id = suppliedId ?? `model-${generatedId}`;
  const listId = `${id}-options`;
  const hintId = `${id}-hint`;
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<CatalogState>({ kind: provider === "notorganic" ? "manual" : "loading" });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [attempt, setAttempt] = useState(0);
  const [position, setPosition] = useState<CSSProperties>();
  const [theme, setTheme] = useState<string>();
  const canBrowse = provider !== "notorganic";

  useEffect(() => {
    let current = true;
    if (provider === "notorganic") {
      setState({ kind: "manual" });
      return;
    }
    setState({ kind: "loading" });
    void loadCatalog()
      .then((catalog) => {
        if (current) setState({ kind: "ready", catalog });
      })
      .catch(() => {
        if (current) setState({ kind: "unavailable" });
      });
    return () => {
      current = false;
    };
  }, [provider, loadCatalog, attempt]);
  useEffect(() => {
    setOpen(false);
    setActive(-1);
  }, [provider]);
  useEffect(() => {
    setActive(-1);
  }, [baseUrl]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const providers = useMemo(
    () => (state.kind === "ready" ? catalogProvidersFor(state.catalog, provider, baseUrl) : []),
    [state, provider, baseUrl],
  );
  const matches = useMemo(() => searchCatalogModels(providers, query), [providers, query]);
  const options = matches.slice(0, 40);
  const selected = useMemo(
    () => searchCatalogModels(providers, "").find((model) => model.id === value),
    [providers, value],
  );
  const activeOption = active >= 0 ? options[active] : undefined;
  const expanded = open && canBrowse && !disabled;

  useLayoutEffect(() => {
    if (!expanded) return;
    const place = () => {
      const rect = root.current?.querySelector(".model-picker-control")?.getBoundingClientRect();
      if (!rect) return;
      const height = window.visualViewport?.height ?? window.innerHeight;
      const offset = window.visualViewport?.offsetTop ?? 0;
      const width = Math.min(rect.width, window.innerWidth - 16);
      const below = height + offset - rect.bottom - 12;
      const above = rect.top - offset - 12;
      const flip = below < 230 && above > below;
      setPosition({
        width,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        maxHeight: Math.max(100, Math.min(420, flip ? above : below)),
        ...(flip ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      });
      setTheme(root.current?.closest<HTMLElement>("[data-theme]")?.dataset.theme);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    if (root.current) observer?.observe(root.current);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      observer?.disconnect();
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        !popup.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
    };
  }, [expanded]);
  useEffect(() => {
    if (expanded && activeOption)
      document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, expanded, activeOption, id]);

  const choose = (model: CatalogChoice) => {
    onChange(model.id);
    input.current?.focus();
    setQuery(model.id);
    setOpen(false);
    setActive(-1);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || disabled || !canBrowse) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (!options.length) return;
      setActive((current) =>
        event.key === "ArrowDown" ? (current + 1) % options.length : current <= 0 ? options.length - 1 : current - 1,
      );
    } else if (expanded && event.key === "Enter") {
      event.preventDefault();
      if (activeOption) choose(activeOption);
      else {
        onChange(value);
        setOpen(false);
      }
    } else if (expanded && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setActive(-1);
    } else if (event.key === "Tab") setOpen(false);
    else if (expanded && active >= 0 && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : options.length - 1);
    }
  };

  const message =
    state.kind === "unavailable"
      ? "Catalog unavailable. Enter an exact model ID to continue."
      : state.kind === "loading"
        ? "Loading the public model catalog. Manual entry is available."
        : provider === "notorganic"
          ? "Enter an exact model ID from your Not Organic account."
          : (provider === "compatible" || provider === "anthropic") && !providers.length
            ? "No catalog matches this base URL. Enter your provider’s exact model ID."
            : "Search the public catalog or enter an exact model ID. Your key’s access is checked when you save.";

  return (
    <div className="ui-field model-picker" ref={root}>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="model-picker-control">
        <input
          ref={input}
          id={id}
          value={value}
          disabled={disabled}
          required
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search models or enter an exact ID"
          role={canBrowse ? "combobox" : undefined}
          aria-autocomplete={canBrowse ? "list" : undefined}
          aria-expanded={canBrowse ? expanded : undefined}
          aria-controls={expanded ? listId : undefined}
          aria-activedescendant={expanded && activeOption ? `${id}-option-${active}` : undefined}
          aria-describedby={hintId}
          aria-haspopup={canBrowse ? "listbox" : undefined}
          onFocus={() => {
            if (canBrowse) {
              setQuery("");
              setActive(-1);
              setOpen(true);
            }
          }}
          onChange={(event) => {
            onChange(event.target.value);
            setQuery(event.target.value);
            setActive(-1);
            if (canBrowse) setOpen(true);
          }}
          onKeyDown={keyDown}
        />
        {canBrowse && (
          <button
            type="button"
            className="model-picker-toggle"
            disabled={disabled}
            aria-label={expanded ? "Close model catalog" : "Browse model catalog"}
            aria-expanded={expanded}
            onClick={() => {
              if (expanded) setOpen(false);
              else {
                input.current?.focus();
                setQuery("");
                setActive(-1);
                setOpen(true);
              }
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        )}
      </div>
      <p id={hintId} className="model-picker-hint">
        {message}
      </p>
      {selected && (
        <div className="model-picker-selected">
          <Capabilities model={selected} />
          <p>
            Catalog price: {price(selected.inputUsdPerMillion)} input / {price(selected.outputUsdPerMillion)} output per
            1M tokens.{selected.tieredPricing ? " Additional tiers apply." : ""}
          </p>
        </div>
      )}
      {expanded &&
        position &&
        typeof document !== "undefined" &&
        createPortal(
          <div ref={popup} className="model-picker-popup" data-theme={theme} style={position}>
            <div className="model-picker-popup-heading">
              <strong>Public model catalog</strong>
              <span>models.dev</span>
            </div>
            <div
              id={listId}
              role="listbox"
              aria-label="Model catalog matches"
              className="model-picker-options"
              aria-busy={state.kind === "loading"}
            >
              {options.map((model, index) => (
                <button
                  type="button"
                  role="option"
                  id={`${id}-option-${index}`}
                  key={`${model.providerId}:${model.id}`}
                  className="model-picker-option"
                  tabIndex={-1}
                  aria-selected={value === model.id}
                  data-active={active === index ? "" : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerMove={() => setActive(index)}
                  onClick={() => choose(model)}
                >
                  <span className="model-picker-option-name">
                    {model.name}
                    <span aria-hidden="true">{value === model.id ? "✓" : ""}</span>
                  </span>
                  <code>{model.id}</code>
                  <Capabilities model={model} />
                  <span className="model-picker-price">
                    Input {price(model.inputUsdPerMillion)} · Output {price(model.outputUsdPerMillion)} / 1M
                    {model.tieredPricing ? " · tiered" : ""}
                  </span>
                </button>
              ))}
              {state.kind === "loading" && (
                <div className="model-picker-loading" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              )}
            </div>
            {!options.length && (
              <p className="model-picker-empty" role="status">
                {state.kind === "ready" && providers.length
                  ? value
                    ? `No catalog matches. “${value}” remains your exact model ID.`
                    : "Enter your provider’s exact model ID."
                  : message}
              </p>
            )}
            <div className="model-picker-footer">
              {state.kind === "unavailable" ? (
                <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                  Retry catalog
                </button>
              ) : (
                <p>
                  {matches.length > 40
                    ? `Showing 40 of ${matches.length}. Refine your search.`
                    : "Published USD prices; account access and billing can differ."}
                </p>
              )}
              <a href="https://models.dev" target="_blank" rel="noreferrer noopener">
                Catalog source
              </a>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
