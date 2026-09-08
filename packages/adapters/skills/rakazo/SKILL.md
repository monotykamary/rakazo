---
name: rakazo
description: Operate Rakazo app workflows, bots and reusable bot templates, and plan, link or move offices and their repositories. Read before using Rakazo product tools.
---

# Rakazo

Use the authorized product tools already exposed by this session. Their schemas and results are the source of truth; this skill grants no additional permissions. Keep Pi's normal workflow and, when present, Fabric's execution guidance authoritative.

## Discover only what the task needs

With Fabric active, use `fabric_exec` for tool work. Read this whole file with `pi.read({ path: <the advertised skill path> })` inside it. Discover relevant app operations with `tools.search`, then inspect the returned ref with `tools.describe` before calling `tools.call({ ref, args })`. Known captured extension tools use `extensions.<captured_name>`; use the actual registry name, not a guessed spelling or a backend callback handle. Batch independent bounded reads; keep dependent actions sequential. Return compact evidence, not unused logs.

Without Fabric, use the tools actually exposed by Pi and their schemas directly. Do not install or assume Fabric, providers, integrations, or computer capabilities. If an operation is missing, report the limitation instead of using database writes, internal HTTP endpoints, or shell commands as substitute app APIs.

## App operations

When identity, self-template generation, or app context is needed, discover and read `get_bot_context` (captured as `extensions.get_bot_context` with Fabric). It supplies permitted identity, explicit bot instructions, workspace, roster, skills, and contextual memory/scratchpad data; do not load it for unrelated coding work. Read relevant current state before changing it. Resolve the intended workspace, thread, bot, integration, and target from returned identifiers, not display-name guesses. Use existing app operations to inspect and update authorized state, send messages, schedule work, or manage artifacts only when their discovered schemas support it. Respect approval requirements and report completion only from successful tool results. Keep credentials out of prompts, templates, artifacts, repository files, and tool output; reference configured connections instead.

## Bots and self-template generation

A request to make a reusable template of yourself is a product workflow, not a request to implement new CRUD. Read `get_bot_context` and discover the existing `skill_create` tool or the `write_file` plus `attach_file` workflow. Inspect their schemas before choosing the supported output. From the current bot's permitted configuration, derive a concise reusable purpose, instructions, and required capabilities. Exclude conversation history, private memory, secrets, machine paths, and account-specific configuration. Use placeholders or connection references. Generate through `skill_create` when its schema supports the requested reusable skill/template, or write the template artifact with `write_file` and publish it with `attach_file`. In sealed managed Fabric, the private `write_file` callback is exposed through canonical `pi.write`; use the advertised execution route, not the private callback name. Verify the returned skill or attachment and report its identifier; creating an artifact does not create a new bot. Do not invent a new endpoint, edit the product database, or claim a template was saved when only a draft was produced. Ask only for missing decisions that affect authorization or reuse.

## Offices and repositories

Discover `manage_office` (`extensions.manage_office` when captured by Fabric) and inspect its current schema. `inspect` and `plan` report the current computer, named paired offices, capabilities and recent move requests. A managed `move` requires explicit human approval and queues verified relocation after the originating run and active work finish. A queued receipt is not a completed move: inspect its status and resulting placement. Failed or uncertain moves require inspection, not blind retries or manual database edits. Link a new machine through the secure pairing controls under Manage offices; pairing codes and runner credentials must stay outside model text.

An Office button starts this conversation; it is not permission to provision infrastructure or copy data. Establish the destination, selected repositories and desired independence. Inventory committed and uncommitted work, runtime/session continuity, model availability and service dependencies. Use only explicitly authorized repositories; a URL is not an allowlist grant. Keep credentials out of prompts and artifacts; never automatically copy Pi profiles, SSH keys or environment files.

For a new independent server, own the planning and preparation with available Pi/Fabric tools. Inspect the repository's deployment documentation and the `infra/compose/deploy-server.sh` workflow reported by the tool; do not invent internal HTTP or database APIs. Obtain explicit consent for the proposed infrastructure and transfer effects before running SSH, deployment or migration commands. Keep configuration provider-neutral and use secure credential entry. Verify destination health, selected repositories, model access and conversation continuity before proposing cutover; keep the original usable until those checks pass. Native Pi remote assignment is not a portable-export operation. A separate server deployment may require explicit configuration and data migration; no generic app tool currently performs that entire cutover atomically.

Pairing remote compute does not move the API, database or credential authority. If those remain on the laptop, the laptop must stay online. Claim laptop independence only after the required control plane, execution services and data operate independently and the client can reach the destination. Report unfinished steps plainly rather than calling pairing or a deployment plan a completed move.

## File and execution boundaries

In managed execution, Pi file and shell tools target the authorized computer, not worker files. The advertised Rakazo skill is a specific read-only bundled resource; it does not open its directory, sibling files, or arbitrary host paths. Native Pi keeps the user's configured extensions, skills, and project context. Never use host access or a different interpreter to bypass an unavailable or denied product operation.
