import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input, Textarea } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { rpc } from "../lib/rpc";

export function OnboardingPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const fieldId = useId();
  const [canLeave, setCanLeave] = useState(false);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void rpc
      .me()
      .then((me) => {
        if (!cancelled) setCanLeave(me.hasOnboarded === true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  async function createBot() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const bot = await rpc.bots.create({
        name: name.trim(),
        title,
        description,
        instructions: description,
        notifyOnFinish: true,
      });
      const started = await rpc.onboarding
        .start({ botId: bot.id })
        .then(() => true)
        .catch(() => false);
      if (started) await rpc.onboarding.promptFocus({ botId: bot.id }).catch(() => undefined);
      navigate(`/app/${bot.id}`);
    } catch {
      setError(t`Could not create your bot`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="min-h-full bg-background px-6 py-12">
      <div className="mx-auto w-full max-w-[560px]">
        {canLeave && (
          <Button
            variant="ghost"
            className="mb-4"
            onClick={() => navigate("/app", { replace: true })}
          >
            <Trans>Back</Trans>
          </Button>
        )}
        <h1 className="text-[32px] font-medium text-foreground">
          <Trans>Create your first bot</Trans>
        </h1>
        <label htmlFor={`${fieldId}-name`} className="mt-8 block text-sm text-muted-foreground">
          <Trans>Name</Trans>
          <Input
            id={`${fieldId}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t`Name this bot`}
            className="mt-2"
          />
        </label>
        <label htmlFor={`${fieldId}-title`} className="mt-4 block text-sm text-muted-foreground">
          <Trans>Title</Trans>
          <Input
            id={`${fieldId}-title`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t`Describe what this bot does`}
            className="mt-2"
          />
        </label>
        <label
          htmlFor={`${fieldId}-description`}
          className="mt-4 block text-sm text-muted-foreground"
        >
          <Trans>Description</Trans>
          <Textarea
            id={`${fieldId}-description`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t`What this bot is for`}
            rows={4}
            className="mt-2"
          />
        </label>
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        <Button className="mt-6" disabled={busy || !name.trim()} onClick={() => void createBot()}>
          <Trans>Continue</Trans>
        </Button>
      </div>
    </div>
  );
}
