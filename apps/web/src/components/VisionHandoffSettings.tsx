import { Trans, useLingui } from "@lingui/react/macro";
import {
  formatVisionModelRef,
  type ModelCatalogEntry,
  parseVisionModelRef,
  type VisionHandoff,
} from "@rakazo/contracts";
import { NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

export function VisionHandoffSettings({ catalog }: { catalog: ModelCatalogEntry[] }) {
  const { t } = useLingui();
  const vision = catalog.filter((entry) => entry.acceptsImages && !entry.placeholder);
  const [value, setValue] = useState<VisionHandoff>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void rpc.models
      .getVisionHandoff()
      .then((next) => {
        if (!cancelled) setValue(next);
      })
      .catch(() => {
        if (!cancelled) setValue(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!value || vision.length === 0) return null;
  const selected = parseVisionModelRef(value.enabled ? value.visionModel : null);
  async function save(next: string) {
    if (busy) return;
    setBusy(true);
    try {
      const parsed = next ? parseVisionModelRef(next) : null;
      setValue(
        await rpc.models.setVisionHandoff(
          parsed
            ? { enabled: true, visionModel: formatVisionModelRef(parsed.provider, parsed.id) }
            : { enabled: false, visionModel: null },
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="mt-5 space-y-3 rounded-xl border border-border p-4"
      data-testid="vision-handoff"
    >
      <h3 className="text-[15px] font-medium text-foreground">
        <Trans>Vision</Trans>
      </h3>
      <NativeSelect
        aria-label={t`Vision`}
        disabled={busy}
        value={selected ? formatVisionModelRef(selected.provider, selected.id) : ""}
        onChange={(event) => void save(event.currentTarget.value)}
      >
        <NativeSelectOption value="">{t`Off`}</NativeSelectOption>
        {vision.map((entry) => {
          const ref = formatVisionModelRef(entry.provider, entry.id);
          return (
            <NativeSelectOption key={ref} value={ref}>
              {entry.label}
            </NativeSelectOption>
          );
        })}
      </NativeSelect>
    </section>
  );
}
