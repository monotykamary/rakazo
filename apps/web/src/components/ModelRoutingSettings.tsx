import { t } from "@lingui/core/macro";
import {
  type ModelCatalogEntry,
  type ModelCredential,
  type ModelRouting,
  ModelRoutingSchema,
} from "@rakazo/contracts";
import { Button, Checkbox, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

export function ModelRoutingSettings(props: {
  credential: ModelCredential;
  credentials: ModelCredential[];
  modelId: string;
  catalog: ModelCatalogEntry[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-3">
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >{t`Rotation and fallback`}</Button>
      {open && <RoutingForm key={props.credential.id} {...props} />}
    </section>
  );
}
function RoutingForm({
  credential,
  credentials,
  modelId,
  catalog,
}: {
  credential: ModelCredential;
  credentials: ModelCredential[];
  modelId: string;
  catalog: ModelCatalogEntry[];
}) {
  const initial = (): ModelRouting => ({
    version: 1,
    strategy: "ordered",
    credentialIds: [credential.id],
    modelId,
    fallbacks: [],
  });
  const [routing, setRouting] = useState<ModelRouting>(initial);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [fallbackCredential, setFallbackCredential] = useState(credential.id);
  const [fallbackModel, setFallbackModel] = useState("");
  const [dirty, setDirty] = useState(false);
  const fallbackProvider = credentials.find((item) => item.id === fallbackCredential)?.provider;
  useEffect(() => {
    let alive = true;
    rpc.models
      .getRouting({ credentialId: credential.id })
      .then((value) => {
        if (alive) {
          setRouting(value ?? initial());
          setLoaded(true);
        }
      })
      .catch((cause) => {
        if (alive) setError(String(cause));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [credential.id]);
  function change(next: ModelRouting) {
    setRouting(next);
    setDirty(true);
  }
  async function save(value: ModelRouting | null) {
    if (busy || !loaded) return;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await rpc.models.setRouting({
        credentialId: credential.id,
        routing: value === null ? null : ModelRoutingSchema.parse(value),
      });
      setRouting(saved ?? initial());
      setDirty(false);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset
      disabled={busy || !loaded}
      className="min-w-0 space-y-3 rounded border border-border p-3"
    >
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
      <Input
        aria-label={t`Pool model`}
        value={routing.modelId}
        onChange={(event) => change({ ...routing, modelId: event.target.value })}
      />
      <NativeSelect
        aria-label={t`Rotation`}
        value={routing.strategy}
        onChange={(event) =>
          change({ ...routing, strategy: event.target.value as ModelRouting["strategy"] })
        }
      >
        <NativeSelectOption value="ordered">{t`In order`}</NativeSelectOption>
        <NativeSelectOption value="round-robin">{t`Round robin`}</NativeSelectOption>
      </NativeSelect>
      <fieldset aria-label={t`Connection pool`} className="space-y-2">
        {credentials
          .filter((item) => item.provider === credential.provider)
          .map((item) => (
            <label
              htmlFor={`pool-${item.id}`}
              className="flex items-center gap-2 text-sm"
              key={item.id}
            >
              <Checkbox
                id={`pool-${item.id}`}
                checked={routing.credentialIds.includes(item.id)}
                disabled={item.id === credential.id}
                onCheckedChange={(checked) =>
                  change({
                    ...routing,
                    credentialIds: checked
                      ? [...routing.credentialIds, item.id]
                      : routing.credentialIds.filter((id) => id !== item.id),
                  })
                }
              />
              {item.label}
            </label>
          ))}
      </fieldset>
      <ol aria-label={t`Fallback order`} className="space-y-2">
        {routing.fallbacks.map((target, index) => (
          <li
            key={`${target.credentialId}:${target.modelId}`}
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <span className="min-w-0 break-words">
              {credentials.find((item) => item.id === target.credentialId)?.label ??
                target.credentialId}{" "}
              · {target.modelId}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={index === 0}
              aria-label={t`Move up`}
              onClick={() => {
                const next = [...routing.fallbacks];
                [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                change({ ...routing, fallbacks: next });
              }}
            >
              ↑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                change({ ...routing, fallbacks: routing.fallbacks.filter((_, i) => i !== index) })
              }
            >{t`Remove`}</Button>
          </li>
        ))}
      </ol>
      <NativeSelect
        aria-label={t`Fallback connection`}
        value={fallbackCredential}
        onChange={(event) => {
          setFallbackCredential(event.target.value);
          setFallbackModel("");
        }}
      >
        {credentials.map((item) => (
          <NativeSelectOption key={item.id} value={item.id}>
            {item.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Input
        aria-label={t`Fallback model`}
        value={fallbackModel}
        list={`fallback-models-${credential.id}`}
        onChange={(event) => setFallbackModel(event.target.value)}
      />
      <datalist id={`fallback-models-${credential.id}`}>
        {catalog
          .filter((item) => item.provider === fallbackProvider)
          .map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
      </datalist>
      <Button
        size="sm"
        variant="outline"
        disabled={!fallbackModel.trim()}
        onClick={() => {
          change({
            ...routing,
            fallbacks: [
              ...routing.fallbacks,
              { credentialId: fallbackCredential, modelId: fallbackModel.trim() },
            ],
          });
          setFallbackModel("");
        }}
      >{t`Add fallback`}</Button>
      <div className="flex gap-2">
        <Button size="sm" disabled={!dirty} onClick={() => void save(routing)}>{t`Save`}</Button>
        <Button size="sm" variant="ghost" onClick={() => void save(null)}>{t`Reset`}</Button>
      </div>
    </fieldset>
  );
}
