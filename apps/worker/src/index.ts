import type { JobPublisher, JobWorkerHost } from "@rakazo/adapter-kit";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";

// A managed local worker uses the exact environment snapshot authenticated at boot.
if (process.env.RAKAZO_DEV_WORKER_IPC !== "1") loadRootEnv();

import {
  ChatSdkMessagingSurface,
  createBackgroundJobHandlers,
  createCloudAgentConnection,
  createConnectorStack,
  createJobReconciler,
  createMachineFetch,
  createMachineRouting,
  createMachinesService,
  createMessagingContextLoader,
  createOfficeMovePool,
  createPostgresReconciliationLeadership,
  createRunExecutor,
  createRunSandbox,
  createRunSecretWriter,
  createWebProvider,
  EncryptedSecretStore,
  ExpoPushProvider,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
  InMemoryJobQueue,
  InstalledConnectorProvider,
  isComposioEnabled,
  isMessagingSurfaceEnabled,
  isPipedreamEnabled,
  LocalAgentHomeStore,
  LocalArtifactStore,
  LocalPiRuntime,
  McpConnector,
  McpOAuthBroker,
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
  PiAgentRuntime,
  PipedreamConnector,
  PostgresRealtimeFanout,
  pipedreamConfigFromEnv,
  reconcileCloudAgents,
  reconcileOfficeMoveIntents,
  resolveDeploymentModel,
  resolveLocalPiRuntimeOptions,
  resolveSandboxProvider,
  ScriptedAgentRuntime,
  SpaceMemoryProviderResolver,
  SupervisorAgentProcessHost,
} from "@rakazo/adapters";
import { resolveEncryptionKey, resolveSupervisorToken } from "@rakazo/core";
import {
  createDb,
  createPrismaMachineStore,
  createThreadEvents,
  machineScopeFromTunnelRequest,
  sweepExpiredMachineCommands,
} from "@rakazo/db";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { MarkdownMemoryStore } from "@rakazo/memory";

const logger = createRootLogger(SERVICE_NAMES.worker);

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const { prisma, pool } = createDb(databaseUrl);
  const officeMovePool = createOfficeMovePool(databaseUrl);
  const realtime = new PostgresRealtimeFanout({
    connectionString: process.env.REALTIME_DATABASE_URL ?? databaseUrl,
    publisher: pool,
  });
  const secrets = new EncryptedSecretStore(resolveEncryptionKey(process.env));
  const events = createThreadEvents(prisma, realtime, {
    runSecretWriter: createRunSecretWriter(secrets),
  });
  const machines = createMachinesService({ store: createPrismaMachineStore(prisma) });
  const dataDir = process.env.DATA_DIR ?? "./data";
  // Same resolver the API uses, so both processes agree on provider, model and key.
  const deploymentModel = resolveDeploymentModel();
  const { key: deploymentModelKey } = deploymentModel;
  const localPi = resolveLocalPiRuntimeOptions(process.env, dataDir);
  const sandboxProvider = resolveSandboxProvider(process.env);
  const fallbackSandbox = createRunSandbox(sandboxProvider, {
    supervisorUrl: process.env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    supervisorToken: sandboxProvider === "docker" ? resolveSupervisorToken(process.env) : undefined,
    e2bApiKey: process.env.E2B_API_KEY,
    daytonaApiKey: process.env.DAYTONA_API_KEY,
    daytonaApiUrl: process.env.DAYTONA_API_URL,
    daytonaTarget: process.env.DAYTONA_TARGET,
    boxApiKey: process.env.BOX_API_KEY,
    boxApiUrl: process.env.BOX_API_URL ?? process.env.BOX_BASE_URL,
    dataDir,
    trustedWorkspaceRoot: localPi?.cwd,
    prisma,
  });
  const machineRouting = createMachineRouting({
    prisma,
    machineFetch: (machineId) =>
      createMachineFetch(machines, machineId, {
        scopeResolver: (info) => machineScopeFromTunnelRequest(prisma, { ...info, machineId }),
      }),
    fallbackSandbox,
    fallbackHost: process.env.SANDBOX_SUPERVISOR_TOKEN
      ? new SupervisorAgentProcessHost({
          baseUrl: process.env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
          token: resolveSupervisorToken(process.env),
        })
      : undefined,
  });
  const sandbox = machineRouting.sandbox;
  const runtime =
    process.env.AGENT_RUNTIME === "scripted"
      ? new ScriptedAgentRuntime()
      : localPi
        ? new LocalPiRuntime(localPi)
        : new PiAgentRuntime({ host: machineRouting.host });
  const mcpOAuth = new McpOAuthBroker(prisma, secrets);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: process.env.MCP_STDIO_ENABLED === "true",
      allowedCommands: (process.env.MCP_STDIO_ALLOWED_COMMANDS ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    },
    mcpOAuth,
  );
  const pipedreamConfig = pipedreamConfigFromEnv({
    pipedreamClientId: process.env.PIPEDREAM_CLIENT_ID,
    pipedreamClientSecret: process.env.PIPEDREAM_CLIENT_SECRET,
    pipedreamProjectId: process.env.PIPEDREAM_PROJECT_ID,
    pipedreamEnvironment: process.env.PIPEDREAM_ENVIRONMENT,
    encryptionKey: resolveEncryptionKey(process.env),
  });
  const pipedream = isPipedreamEnabled(pipedreamConfig)
    ? new PipedreamConnector(pipedreamConfig)
    : undefined;
  // pollInboundMessages stays false (the default) here: this process
  // only ever sends outbound (messaging.deliver jobs). It must never poll
  // Telegram — that would steal the single getUpdates slot away from the
  // API process, which is the one with the inbound sink actually wired up.
  const messagingPlatforms = messagingPlatformsFromEnv(messagingEnvFromProcess(process.env));
  const messaging = isMessagingSurfaceEnabled(messagingPlatforms, {
    deploymentModelKey,
    openSignup: process.env.MESSAGING_OPEN_SIGNUP === "true",
  })
    ? new ChatSdkMessagingSurface(messagingPlatforms)
    : undefined;
  const stack = createConnectorStack(isComposioEnabled(process.env.COMPOSIO_API_KEY), undefined, [
    new InstalledConnectorProvider(prisma, secrets),
    ...(pipedream ? [pipedream] : []),
    mcp,
  ]);
  const connector = stack.destination;
  await connector.start();
  const memoryProviders = new SpaceMemoryProviderResolver(prisma, secrets);
  const home = new LocalAgentHomeStore(dataDir);
  const artifacts = new LocalArtifactStore(dataDir);
  const inMemoryJobs = process.env.WAKEUP_DRIVER === "memory" ? new InMemoryJobQueue() : undefined;
  const jobs: JobPublisher = inMemoryJobs ?? new GraphileJobPublisher(databaseUrl);
  const managedDevWorker = process.env.RAKAZO_DEV_WORKER_IPC === "1" && !!process.send;
  const jobHost: JobWorkerHost =
    inMemoryJobs ?? new GraphileJobWorkerHost(databaseUrl, { noHandleSignals: managedDevWorker });
  // One provider instance so emulator launches and polls share the same Map.
  const cloudAgent = createCloudAgentConnection();
  const executor = createRunExecutor({
    prisma,
    runtime,
    sandbox,
    memory: new MarkdownMemoryStore(prisma),
    memoryProviders,
    home,
    artifacts,
    connector: stack.connector,
    connectors: stack.connector,
    listConnectedPluginSlugs: stack.composio?.listConnectedSlugs.bind(stack.composio),
    secrets: [
      deploymentModelKey ?? "",
      process.env.COMPOSIO_API_KEY ?? "",
      process.env.CURSOR_API_KEY ?? "",
    ].filter(Boolean),
    secretStore: secrets,
    deploymentModelKey,
    deploymentModel,
    localPiCwd: localPi?.cwd,
    dataDir,
    notifications: new ExpoPushProvider(dataDir),
    jobs,
    events,
    messaging: messaging ? createMessagingContextLoader(prisma) : undefined,
    web: createWebProvider(),
    cloudAgent,
  });

  const jobHandlers = createBackgroundJobHandlers({
    executor,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    officeMove: {
      prisma,
      jobs,
      sandbox,
      home,
      pool: officeMovePool,
      defaultComputerKind: sandboxProvider,
    },
    workerId: process.pid.toString(),
    runtime,
    secretStore: secrets,
    memoryProviders,
    deploymentModelKey,
    messaging,
    cloudAgent,
  });
  await jobHost.start(jobHandlers);
  const reconciler = createJobReconciler({
    prisma,
    jobs,
    events,
    leadership: createPostgresReconciliationLeadership(pool),
    reconcileOfficeMoves: () => reconcileOfficeMoveIntents({ prisma, jobs }),
    reconcileCloudAgents: async () => {
      await sweepExpiredMachineCommands(prisma);
      await reconcileCloudAgents({ prisma, jobs, cloudAgent });
    },
  });
  reconciler.start();

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        await reconciler.stop();
        // Graphile waits for handlers even after its helper abort timer fires.
        // dev-worker-graphile.test.ts exercises the installed runner across that timeout.
        await jobHost.stop();
        await officeMovePool.end();
        await jobs.close();
        await realtime.close();
        await connector.stop();
        await mcp.close();
        await prisma.$disconnect().catch(() => undefined);
        await pool.end().catch(() => undefined);
      } finally {
        await logger.flush({ timeoutMs: 2_000 });
      }
    })());
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());

  // The local dev manager owns this entire host, not individual Pi children.
  if (managedDevWorker) {
    process.on("message", (message: unknown) => {
      if ((message as { type?: string })?.type === "dev-worker:drain") {
        void stop().then(
          () => process.exit(0),
          () => process.send?.({ type: "dev-worker:drain-failed" }),
        );
      }
    });
    process.send?.({ type: "dev-worker:ready" });
  }
  logger.info("worker ready");
}

main().catch(async (error) => {
  logger.error("worker startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  process.exit(1);
});
