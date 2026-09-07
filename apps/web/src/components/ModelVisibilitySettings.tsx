import { t } from "@lingui/core/macro";
import type { ModelCatalogEntry, ModelHideRule, ModelVisibility } from "@rakazo/contracts";
import { connectedModelOptions } from "@rakazo/core";
import { Button, Input } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

export function ModelVisibilitySettings({ onChanged }: { onChanged: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<
    Pick<ModelCatalogEntry, "provider" | "id" | "label" | "placeholder">[]
  >([]);
  const [visibility, setVisibility] = useState<ModelVisibility>();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setVisibility(undefined);
    setError(undefined);
    void Promise.all([
      rpc.models.getVisibility(),
      rpc.models.listForVisibility(),
      rpc.models.credentials(),
    ])
      .then(([state, models, credentials]) => {
        if (!cancelled) {
          setVisibility(state);
          const custom = connectedModelOptions(credentials, models).filter(
            (option) =>
              !models.some(
                (model) =>
                  !model.placeholder &&
                  model.provider === option.provider &&
                  model.id === option.modelId,
              ),
          );
          setCatalog([
            ...models,
            ...custom.map((option) => ({
              id: option.modelId,
              provider: option.provider,
              label: option.label,
              thinkingLevels: option.thinkingLevels,
            })),
          ]);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  async function change(rule: ModelHideRule, hide: boolean) {
    if (!visibility || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const rules = visibility.hide.filter(
        (item) => item.provider !== rule.provider || item.model !== rule.model,
      );
      setVisibility(await rpc.models.setVisibility({ hide: hide ? [...rules, rule] : rules }));
      await onChanged();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  const matches = (name: string) => name.toLowerCase().includes(query.toLowerCase());
  const providers = [...new Set(catalog.map((entry) => entry.provider))];
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer py-3 text-sm text-muted-foreground">{t`Visibility`}</summary>
      {open && (
        <div className="space-y-3">
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <Input
            aria-label={t`Search models`}
            placeholder={t`Search models`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="max-h-80 space-y-2 overflow-auto">
            {visibility?.hide.map((rule) => (
              <div
                key={`${rule.provider}:${rule.model ?? ""}`}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="truncate">
                  {rule.provider}
                  {rule.model ? ` · ${rule.model}` : ""}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={t`Unhide ${rule.model ?? rule.provider}`}
                  onClick={() => void change(rule, false)}
                >{t`Unhide`}</Button>
              </div>
            ))}
            {providers
              .filter(
                (provider) =>
                  !visibility?.hide.some((rule) => rule.provider === provider && !rule.model),
              )
              .map((provider) => {
                const models = catalog.filter(
                  (entry) =>
                    !entry.placeholder &&
                    entry.provider === provider &&
                    matches(`${provider} ${entry.label} ${entry.id}`) &&
                    !visibility?.hide.some(
                      (rule) => rule.provider === provider && rule.model === entry.id,
                    ),
                );
                if (!models.length && !matches(provider)) return null;
                return (
                  <div key={provider}>
                    <div className="flex items-center justify-between gap-2 text-sm font-medium">
                      <span>{provider}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || !visibility}
                        aria-label={t`Hide ${provider}`}
                        onClick={() => void change({ provider }, true)}
                      >{t`Hide`}</Button>
                    </div>
                    {models.map((model) => (
                      <div
                        key={model.id}
                        className="flex items-center justify-between gap-2 pl-3 text-sm"
                      >
                        <span className="truncate">{model.label}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || !visibility}
                          aria-label={t`Hide ${model.label}`}
                          onClick={() => void change({ provider, model: model.id }, true)}
                        >{t`Hide`}</Button>
                      </div>
                    ))}
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </details>
  );
}
