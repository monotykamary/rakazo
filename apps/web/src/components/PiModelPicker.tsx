import { t } from "@lingui/core/macro";
import type {
  ModelCatalogEntry,
  ModelSelection,
  ModelSelectionStatus,
  ThinkingLevel,
} from "@rakazo/contracts";
import { modelOptionKey } from "@rakazo/core";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";

export function PiModelPicker({
  catalog,
  selection,
  onChange,
  disabled = false,
  readOnly = false,
}: {
  catalog: ModelCatalogEntry[];
  selection: ModelSelection | null;
  onChange?: (selection: ModelSelection) => void;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const selected = catalog.find(
    (entry) => entry.provider === selection?.provider && entry.id === selection?.modelId,
  );
  return (
    <div className="space-y-3">
      {!readOnly && selection && (
        <p className="text-sm" data-testid="selected-model">
          {t`Selected`}: {selection.provider}/{selection.modelId}
          {!selected ? ` · ${t`Unavailable`}` : ""}
        </p>
      )}
      <Command
        filter={(value: string, query: string, keywords?: string[]) =>
          [value, ...(keywords ?? [])].some((text) =>
            text.toLowerCase().includes(query.trim().toLowerCase()),
          )
            ? 1
            : 0
        }
      >
        <CommandInput
          aria-label={t`Search models`}
          placeholder={t`Search models`}
          disabled={disabled}
        />
        <CommandList aria-label={t`Models`} className="mt-3">
          <CommandEmpty>{t`No matching models`}</CommandEmpty>
          {catalog.map((entry) => (
            <CommandItem
              key={modelOptionKey(entry.provider, entry.id)}
              value={modelOptionKey(entry.provider, entry.id)}
              keywords={[entry.provider, entry.id, entry.label, entry.providerName ?? ""]}
              disabled={disabled}
              data-checked={entry === selected}
              title={readOnly ? `${entry.provider}/${entry.id}` : undefined}
              onSelect={
                readOnly
                  ? undefined
                  : () =>
                      onChange?.({
                        provider: entry.provider,
                        modelId: entry.id,
                        thinkingLevel: null,
                      })
              }
            >
              <span className="min-w-0">
                <span className="block">{entry.label}</span>
                <span className="block break-all text-xs text-muted-foreground">
                  {readOnly
                    ? (entry.providerName ?? entry.provider)
                    : `${entry.provider}/${entry.id}`}
                </span>
              </span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
      {!readOnly && selection?.thinkingLevel && !selected?.thinkingLevels?.length ? (
        <p className="text-sm text-muted-foreground">
          {t`Thinking`}: {selection.thinkingLevel} · {t`Unavailable`}
        </p>
      ) : null}
      {!readOnly && selected?.thinkingLevels?.length ? (
        <NativeSelect
          aria-label={t`Thinking`}
          value={selection?.thinkingLevel ?? ""}
          disabled={disabled}
          onChange={(event) =>
            selection &&
            onChange?.({
              ...selection,
              thinkingLevel: (event.target.value || null) as ThinkingLevel | null,
            })
          }
        >
          <NativeSelectOption value="">{t`Default`}</NativeSelectOption>
          {selection?.thinkingLevel &&
          !selected.thinkingLevels.includes(selection.thinkingLevel) ? (
            <NativeSelectOption value={selection.thinkingLevel} disabled>
              {selection.thinkingLevel} · {t`Unavailable`}
            </NativeSelectOption>
          ) : null}
          {selected.thinkingLevels.map((level) => (
            <NativeSelectOption key={level} value={level}>
              {level}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : null}
    </div>
  );
}

export function PiModelStatus({
  current,
  status,
}: {
  current: ModelSelection | null;
  status?: ModelSelectionStatus | null;
}) {
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p data-testid="current-model">
        {t`Current`}:{" "}
        {current
          ? `${current.provider}/${current.modelId}${current.thinkingLevel ? ` · ${current.thinkingLevel}` : ""}`
          : t`Unavailable`}
      </p>
      {status?.status === "pending" && (
        <p>
          {t`Pending`}
          {status.requested ? ` · ${status.requested.provider}/${status.requested.modelId}` : ""}
        </p>
      )}
      {status?.error && (
        <p role="alert" className="text-destructive">
          {status.error}
        </p>
      )}
    </div>
  );
}
