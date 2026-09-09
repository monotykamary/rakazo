# Pi-owned models

Pi owns provider configuration, authentication, aliases, routing and model availability. Rakazo projects Pi RPC metadata and records only scoped selection intent and acknowledged execution state. It does not configure a second set of model connections or transfer model credentials between offices.

## Selection

The Models screen is a searchable inventory. Its **Pi profile default** is the startup choice reported by Pi, not a claim about an existing session. Choose a model in bot settings or a worker's Model control. Provider and model IDs stay visible even when a friendly name exists.

A requested selection is pending until the execution process acknowledges it through Pi RPC. An unavailable model is not silently replaced. Clearing a bot's override returns selection authority to its Pi session; clearing a worker override inherits the bot's selection. Neither operation writes Pi's global defaults.

Catalog and reasoning discovery use the same Pi executable, profile and trusted resource policy as execution. An unavailable runtime is an error, not a reason to show a static provider list. Configure models and credentials through Pi's own setup on that office. Refresh the inventory after changing Pi configuration. Source development preserves the caller’s executable search path for Pi subprocesses, so package-runner binaries cannot shadow a configured forwarding launcher. Restart the dev launcher after updating this behavior; an existing worker must drain before adopting the new launch configuration.

## Deployment support

The supported Pi-owned backend is `AGENT_RUNTIME=pi-local` with a validated absolute workspace and a loopback API listener. The API and worker launch stock Pi RPC with the bundled Rakazo extension and skills; Pi loads the user and project extensions/settings for the authorized cwd. A scoped catalog is unavailable unless its persisted checkpoint proves the same cwd, so Rakazo never substitutes the configured root catalog for a different project.

The legacy `AGENT_RUNTIME=pi` broker-backed path is retired because it lets Rakazo credentials, static catalogs and routing become model authority. API and worker startup reject that mode with migration guidance instead of promoting it to host-native Pi or silently falling back to the broker. Existing managed/container deployments must configure a provider-neutral remote Pi RPC authority before they can support model-dependent execution; remote native execution is not currently implemented. `AGENT_RUNTIME=scripted` remains available only for deterministic development and tests. Ambient team-chat model classification is disabled on native Pi: it has no authorized execution lease and must not launch a host-tool-capable session or use legacy model credentials.

## Office transfers

Planning can target a paired machine without moving anything. Before relocation, the backend verifies acknowledged session and retained-worker requirements, pending selections and startup defaults against the destination's own Pi authority. Missing authority, disconnected machines, unsupported reasoning, unknown identity or default drift blocks the move before stopping or copying the source.

A source catalog cannot prove remote availability. Native remote placement remains unsupported until a destination Pi process/profile authority and session-continuity mechanism exist. Independent server deployment remains a separately reviewed, explicitly authorized workflow; pairing alone does not move the control plane.

Do not copy Pi profiles, authentication files, provider tokens or model configuration as part of an office move. Configure Pi securely on the destination, inspect again, and keep the source usable until cutover is verified.
