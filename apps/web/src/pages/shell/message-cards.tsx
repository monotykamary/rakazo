import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import {
  ARTIFACT_IMAGE_FAN_CARD,
  abortableDelay,
  artifactImageFanSlots,
  type ImageMessageBlock,
  visibleArtifactImageFanItems,
} from "@rakazo/core";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BuiCard, SuccessPop } from "../../components/ai/primitives";
import { type ArtifactTarget, decodeArtifactBase64 } from "../../lib/artifact-open";
import { chartViewport } from "../../lib/chart-viewport";
import { connectMcpOauth } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";

export function ChoiceCard({
  botId,
  block,
  onBotChanged,
}: {
  botId: string;
  block: Extract<MessageBlock, { kind: "choice" }>;
  onBotChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locallyDismissed, setLocallyDismissed] = useState(false);
  const dismissed = locallyDismissed || block.answerId === "_dismissed";

  async function choose(optionId: string) {
    setPending(true);
    setError(null);
    try {
      await rpc.onboarding.choose({ botId, optionId });
      await onBotChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save this choice`);
      setPending(false);
    }
  }

  async function dismiss() {
    setPending(true);
    setError(null);
    try {
      await rpc.onboarding.dismissFocus({ botId });
      setLocallyDismissed(true);
      void onBotChanged().catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not dismiss`);
      setPending(false);
    }
  }

  if (dismissed) return null;

  return (
    <div className="flex justify-start">
      <div className="relative w-[420px] max-w-full rounded-[20px] border border-border bg-card px-[18px] py-[14px]">
        {!block.answerId ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Dismiss`}
            disabled={pending}
            onClick={() => void dismiss()}
            className="absolute end-2 top-2 text-muted-foreground"
          >
            <X size={16} strokeWidth={1.8} />
          </Button>
        ) : null}
        <div className="pe-8 text-[15.5px] text-foreground/90">{block.question}</div>
        {block.subtitle ? (
          <div className="mt-0.5 text-[13px] text-foreground/75">{block.subtitle}</div>
        ) : null}
        <div className="mt-3 space-y-2.5">
          {block.options
            .filter((option) => !block.answerId || option.id === block.answerId)
            .map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={Boolean(block.answerId) || pending}
                onClick={() => void choose(option.id)}
                className={`flex w-full items-start gap-3 rounded-xl px-3.5 py-3.5 text-start text-foreground disabled:opacity-60 ${block.answerId ? "bg-accent" : "bg-muted hover:bg-accent"}`}
              >
                <span className="mt-0.5 grid h-[24px] w-[24px] shrink-0 place-items-center rounded-[7px] bg-background text-[12.5px] font-medium text-foreground/75">
                  {option.letter}
                </span>
                <span
                  className={`flex-1 text-[15px] leading-[1.35] ${block.answerId ? "text-foreground/75" : "text-foreground"}`}
                >
                  {option.label}
                </span>
                {block.answerId === option.id ? (
                  <span className="mt-0.5 text-foreground/75">✓</span>
                ) : null}
              </button>
            ))}
        </div>
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}

export function AppConnectCard({
  botId,
  block,
}: {
  botId: string;
  block: Extract<MessageBlock, { kind: "app_connect" }>;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [localStatus, setLocalStatus] = useState<"pending" | "connected">(block.status);
  const [error, setError] = useState<string | null>(null);
  const connectionAttempt = useRef<AbortController | null>(null);
  const status = block.status === "connected" ? "connected" : localStatus;
  useEffect(() => () => connectionAttempt.current?.abort(), []);

  async function authorize() {
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    setBusy(true);
    setError(null);
    try {
      const started = await rpc.connections.begin({
        provider: block.provider,
        displayName: block.name,
      });
      if (started.authorizationUrl) {
        window.open(started.authorizationUrl, "rakazo-app-connect", "popup,width=560,height=720");
      }
      for (let i = 0; i < 60; i += 1) {
        if (controller.signal.aborted) return;
        const row = await rpc.connections
          .complete({ connectionId: started.connectionId })
          .catch(() => undefined);
        if (row?.status === "connected") {
          if (controller.signal.aborted) return;
          setLocalStatus("connected");
          await rpc.onboarding
            .appConnected({ botId, provider: block.provider })
            .catch(() => undefined);
          return;
        }
        await abortableDelay(2_000, controller.signal);
      }
      if (!controller.signal.aborted) setError(t`Authorization timed out. Please try again.`);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : t`Could not authorize this app`);
      }
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <BuiCard
      role="group"
      aria-label={t`${block.name} connection`}
      className="w-[min(420px,80%)] px-4 py-3.5"
    >
      <div className="flex items-center gap-3.5">
        {block.logo ? (
          <img
            src={block.logo}
            alt=""
            className="h-10 w-10 rounded-[10px] bg-white object-contain p-1"
          />
        ) : (
          <span className="grid h-10 w-10 place-items-center rounded-[10px] bg-muted text-[15px] text-foreground">
            {block.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium text-foreground">{block.name}</span>
          <span className="block truncate text-[13px] text-muted-foreground">
            {block.description}
          </span>
        </span>
        {status === "connected" ? (
          <SuccessPop label={t`Connected`} />
        ) : (
          <Button
            variant="secondary"
            className="rounded-full hover:border-border hover:bg-accent hover:text-foreground"
            disabled={busy}
            onClick={() => void authorize()}
          >
            {busy ? t`Waiting…` : t`Authorize`}
          </Button>
        )}
      </div>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </BuiCard>
  );
}

function ChartCanvas({
  spec,
  data,
  width,
  height,
}: {
  spec: Record<string, unknown>;
  data: unknown[];
  width: number;
  height?: number;
}) {
  const { t } = useLingui();
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    title?: string;
    swatches: { label: string; color: string }[];
  }>({ swatches: [] });
  useEffect(() => {
    let cancelled = false;
    // Plot loads lazily so threads without charts never pay for the library.
    void (async () => {
      try {
        const { buildPlotParts } = await import("@rakazo/core/plot");
        if (cancelled || !ref.current) return;
        // Hover inspection by default: give the first mark a tooltip unless
        // the spec already asks for one somewhere.
        const marks = Array.isArray((spec as { marks?: unknown[] }).marks)
          ? ((spec as { marks: { options?: Record<string, unknown> }[] }).marks ?? [])
          : [];
        const hasTip = marks.some((mark) => mark.options && "tip" in mark.options);
        const liveSpec = hasTip
          ? spec
          : {
              ...spec,
              marks: marks.map((mark, index) =>
                index === 0 ? { ...mark, options: { ...(mark.options ?? {}), tip: true } } : mark,
              ),
            };
        const parts = buildPlotParts(liveSpec as never, data, document, { width, height });
        setMeta({ title: parts.title, swatches: parts.swatches });
        setError(null);
        ref.current.replaceChildren(parts.plotted);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t`Could not render chart`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spec, data, width, height, t]);
  if (error)
    return (
      <div className="text-[13px] text-destructive">
        <Trans>Chart failed to render: {error}</Trans>
      </div>
    );
  return (
    <div className="text-foreground/75">
      {meta.title ? (
        <div className="mb-1 text-[14.5px] font-semibold text-foreground">{meta.title}</div>
      ) : null}
      {meta.swatches.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1">
          {meta.swatches.map((swatch) => (
            <span
              key={swatch.label}
              className="flex items-center gap-1.5 text-[12px] text-muted-foreground"
            >
              {/* Series colours are data-driven and intentionally distinct. */}
              <span
                className="h-[10px] w-[10px] rounded-[3px]"
                style={{ background: swatch.color }}
              />
              {swatch.label}
            </span>
          ))}
        </div>
      ) : null}
      <div ref={ref} className="[&_svg]:max-w-full" />
    </div>
  );
}

type McpApprovalState = "pending" | "connecting" | "connected" | "dismissed";

/** Approval card for an agent-created MCP server: the user completes browser
 * OAuth (or confirms no authorization is needed) without leaving the chat. */
export function McpApprovalCard({
  botId,
  name,
  serverId,
  transport,
  endpoint,
  needsOAuth,
}: {
  botId: string | undefined;
  name: string;
  serverId: string;
  transport: string;
  endpoint: string | null;
  needsOAuth: boolean;
}) {
  const { t } = useLingui();
  const [state, setState] = useState<McpApprovalState>("pending");
  const [error, setError] = useState<string | null>(null);

  async function authorize() {
    if (!botId) {
      setError(t`This server cannot be assigned without a bot.`);
      return;
    }
    setState("connecting");
    setError(null);
    try {
      if (needsOAuth) {
        const result = await connectMcpOauth(serverId);
        if (result === "cancelled") {
          setState("pending");
          return;
        }
      }
      await rpc.mcp.assignments.approve({ botId, serverId });
      setState("connected");
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not approve this server`);
      setState("pending");
    }
  }

  const summary = endpoint ?? `stdio · ${transport}`;
  return (
    <BuiCard className="max-w-[74%] p-4">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-muted text-xs text-foreground">
          M
        </span>
        <span className="text-[14.5px] font-medium text-foreground">
          <Trans>Connect MCP server “{name}”</Trans>
        </span>
      </div>
      <p className="mt-1.5 truncate text-[12px] text-muted-foreground">{summary}</p>
      {state === "pending" || state === "connecting" ? (
        <>
          <p className="mt-2 text-[13px] leading-[1.5] text-foreground/75">
            {needsOAuth
              ? t`This server uses browser sign-in. Authorize it to let your agents use its tools. A popup will open.`
              : t`Approve this server to let your agent use its tools.`}
          </p>
          {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
          <div className="mt-3 flex gap-2">
            <Button
              className="rounded-full"
              disabled={state === "connecting"}
              onClick={() => void authorize()}
            >
              {state === "connecting" ? t`Connecting…` : needsOAuth ? t`Authorize` : t`Approve`}
            </Button>
            <Button
              variant="secondary"
              className="rounded-full"
              onClick={() => setState("dismissed")}
            >
              <Trans>Not now</Trans>
            </Button>
          </div>
        </>
      ) : null}
      {state === "connected" ? (
        <div className="mt-3">
          <SuccessPop label={t`Connected. Its tools are available from your next message.`} />
        </div>
      ) : null}
      {state === "dismissed" ? (
        <p className="mt-2 text-[13px] text-muted-foreground">
          <Trans>Dismissed. Reconnect anytime from MCP settings.</Trans>
        </p>
      ) : null}
    </BuiCard>
  );
}

export function ChartBlockView({
  name,
  spec,
  data,
}: {
  name: string;
  spec: Record<string, unknown>;
  data: unknown[];
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    if (!expanded) return;
    setViewport({ width: window.innerWidth, height: window.innerHeight });
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [expanded]);
  const expandedViewport = chartViewport(viewport.width, viewport.height);
  return (
    <>
      <div className="group relative max-w-[74%] rounded-[20px] bg-muted p-4">
        <ChartCanvas spec={spec} data={data} width={520} />
        <Button
          variant="outline"
          size="xs"
          onClick={() => setExpanded(true)}
          className="absolute end-3 top-3 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Trans>Expand</Trans>
        </Button>
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          showCloseButton={false}
          className="max-h-[92vh] w-[min(1320px,94vw)] max-w-none overflow-auto p-8 sm:max-w-none"
        >
          <div className="flex items-center justify-between">
            <DialogTitle className="text-[13px] font-normal text-muted-foreground">
              {name}
            </DialogTitle>
            <DialogClose
              aria-label={t`Close chart`}
              render={<Button variant="ghost" size="icon-sm" />}
            >
              <X />
            </DialogClose>
          </div>
          <ChartCanvas
            spec={spec}
            data={data}
            width={expandedViewport.width}
            height={expandedViewport.height}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function useArtifactImageSrc(target: ArtifactTarget, artifactId: string, enabled: boolean) {
  const [src, setSrc] = useState<string | null>(null);
  const targetBotId = "botId" in target ? target.botId : undefined;
  const targetGroupId = "groupId" in target ? target.groupId : undefined;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setSrc(null);
    void rpc.artifacts
      .get(
        targetBotId
          ? { botId: targetBotId, artifactId }
          : { groupId: targetGroupId ?? "", artifactId },
      )
      .then((artifact) => {
        const bytes = decodeArtifactBase64(artifact.contentBase64);
        objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: artifact.mimeType }),
        );
        if (cancelled) URL.revokeObjectURL(objectUrl);
        else setSrc(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifactId, enabled, targetBotId, targetGroupId]);

  return src;
}

function useInView() {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { container, visible };
}

function ArtifactImagePreview({
  name,
  src,
  open,
  onOpenChange,
  onPrevious,
  onNext,
}: {
  name: string;
  src: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const { t } = useLingui();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-auto max-w-none bg-transparent p-0 ring-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{name}</DialogTitle>
        <DialogClose
          aria-label={t`Close image preview`}
          render={<Button variant="ghost" size="icon-sm" className="absolute end-2 top-2" />}
        >
          <X />
        </DialogClose>
        {onPrevious ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t`Previous image`}
            onClick={onPrevious}
            className="absolute start-2 top-1/2 -translate-y-1/2"
          >
            <ChevronLeft />
          </Button>
        ) : null}
        {onNext ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t`Next image`}
            onClick={onNext}
            className="absolute end-2 top-1/2 -translate-y-1/2"
          >
            <ChevronRight />
          </Button>
        ) : null}
        <img src={src} alt={name} className="max-h-[85vh] max-w-[90vw] rounded-xl object-contain" />
      </DialogContent>
    </Dialog>
  );
}

export function ArtifactImage({
  target,
  artifactId,
  name,
}: {
  target: ArtifactTarget;
  artifactId: string;
  name: string;
}) {
  const { container, visible } = useInView();
  const src = useArtifactImageSrc(target, artifactId, visible);
  const [open, setOpen] = useState(false);

  return (
    <div ref={container}>
      {src ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="max-w-[240px] overflow-hidden rounded-[20px]"
        >
          <img src={src} alt={name} className="max-h-48 w-full object-cover" />
        </button>
      ) : (
        <div className="rounded-[20px] border border-border bg-muted px-4 py-3 text-[14px] text-muted-foreground">
          {name}
        </div>
      )}
      {src ? (
        <ArtifactImagePreview name={name} src={src} open={open} onOpenChange={setOpen} />
      ) : null}
    </div>
  );
}

function ArtifactImageFanCard({
  target,
  artifactId,
  name,
  enabled,
  slot,
}: {
  target: ArtifactTarget;
  artifactId: string;
  name: string;
  enabled: boolean;
  slot: { rotateDeg: number; offsetX: number; offsetY: number; zIndex: number };
}) {
  const src = useArtifactImageSrc(target, artifactId, enabled);
  return (
    <div
      aria-hidden="true"
      className="absolute overflow-hidden rounded-2xl border border-border bg-card shadow-md"
      style={{
        width: ARTIFACT_IMAGE_FAN_CARD.width,
        height: ARTIFACT_IMAGE_FAN_CARD.height,
        right: 0,
        top: 10,
        zIndex: slot.zIndex,
        transform: `translate(${slot.offsetX}px, ${slot.offsetY}px) rotate(${slot.rotateDeg}deg)`,
      }}
    >
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-end bg-muted px-3 py-2 text-[12px] text-muted-foreground">
          {name}
        </div>
      )}
    </div>
  );
}

export function ArtifactImageFan({
  target,
  images,
}: {
  target: ArtifactTarget;
  images: readonly ImageMessageBlock[];
}) {
  const { t } = useLingui();
  const { container, visible } = useInView();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const front = images.at(-1);
  const openImage = openIndex !== null ? images[openIndex] : undefined;
  const openSrc = useArtifactImageSrc(
    target,
    openImage?.artifactId ?? front?.artifactId ?? "",
    openIndex !== null && Boolean(openImage),
  );

  if (images.length === 1 && front) {
    return <ArtifactImage target={target} artifactId={front.artifactId} name={front.name} />;
  }
  if (!front) return null;

  const visibleCards = visibleArtifactImageFanItems(images);
  const slots = artifactImageFanSlots(visibleCards.length);

  return (
    <div
      ref={container}
      className="relative"
      style={{
        width: ARTIFACT_IMAGE_FAN_CARD.width + 36,
        height: ARTIFACT_IMAGE_FAN_CARD.height + 28,
      }}
    >
      {visibleCards.map((image, index) => {
        const slot = slots[index];
        if (!slot) return null;
        return (
          <ArtifactImageFanCard
            key={image.artifactId}
            target={target}
            artifactId={image.artifactId}
            name={image.name}
            enabled={visible}
            slot={slot}
          />
        );
      })}
      <button
        type="button"
        data-testid="artifact-image-fan"
        aria-label={t`${images.length} images`}
        onClick={() => setOpenIndex(images.length - 1)}
        className="absolute inset-0 z-20"
      />
      {openImage && openSrc ? (
        <ArtifactImagePreview
          name={openImage.name}
          src={openSrc}
          open
          onOpenChange={(open) => {
            if (!open) setOpenIndex(null);
          }}
          onPrevious={
            openIndex !== null && openIndex > 0 ? () => setOpenIndex(openIndex - 1) : undefined
          }
          onNext={
            openIndex !== null && openIndex < images.length - 1
              ? () => setOpenIndex(openIndex + 1)
              : undefined
          }
        />
      ) : null}
    </div>
  );
}
