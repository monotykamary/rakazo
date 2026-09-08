import * as z from "zod";

/** Service names become supervisord group names and conf filenames: strict slug only. */
export const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidServiceName(name: string): boolean {
  return SERVICE_NAME_PATTERN.test(name);
}

export const SERVICE_ARGV_MAX_ENTRIES = 32;
export const SERVICE_ARGV_MAX_LENGTH = 4096;
export const SERVICE_ENV_MAX_ENTRIES = 32;
export const SERVICE_PORTS_MAX = 8;
export const SERVICE_PORT_MIN = 1024;
export const SERVICE_PORT_MAX = 65535;
export const SERVICE_CWD_MAX_LENGTH = 512;

/** Never turn an app preview into access to Rakazo's control, VNC or service supervisor. */
export function isAllowedServicePort(port: unknown): port is number {
  return (
    typeof port === "number" &&
    Number.isInteger(port) &&
    port >= SERVICE_PORT_MIN &&
    port <= SERVICE_PORT_MAX &&
    port !== 7070 &&
    port !== 9011 &&
    !(port >= 5900 && port <= 5915) &&
    !(port >= 6080 && port <= 6095)
  );
}

export const ServicePortSchema = z
  .number()
  .int()
  .refine(isAllowedServicePort, "Port is reserved or out of range");

/** Zod 4 has no record size bound: enforce the entry count with a refinement. */
export const ServiceEnvSchema = z
  .record(z.string().min(1).max(256), z.string().max(8192))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > SERVICE_ENV_MAX_ENTRIES) {
      ctx.addIssue({
        code: "custom",
        message: `At most ${SERVICE_ENV_MAX_ENTRIES} environment variables`,
      });
    }
  });

export const ServiceDeclareInputSchema = z.object({
  botId: z.string().min(1),
  name: z.string().regex(SERVICE_NAME_PATTERN),
  argv: z
    .array(z.string().min(1).max(SERVICE_ARGV_MAX_LENGTH))
    .min(1)
    .max(SERVICE_ARGV_MAX_ENTRIES),
  /** Workspace-relative project directory (virtual workspace path, never a host path). */
  cwd: z.string().min(1).max(SERVICE_CWD_MAX_LENGTH),
  env: ServiceEnvSchema.default({}),
  ports: z.array(ServicePortSchema).max(SERVICE_PORTS_MAX).default([]),
  /** Kept services hold the computer awake across idle sleep decisions. */
  keepAlive: z.boolean().default(false),
});
export type ServiceDeclareInput = z.infer<typeof ServiceDeclareInputSchema>;

export const ComputerServiceSchema = z.object({
  name: z.string().regex(SERVICE_NAME_PATTERN),
  status: z.enum(["running", "stopped", "exited", "fatal", "unknown"]),
  pid: z.number().int().positive().nullable(),
  ports: z.array(ServicePortSchema),
  keepAlive: z.boolean(),
  cwd: z.string().max(SERVICE_CWD_MAX_LENGTH),
  /** Declaration-instance nonce; see ComputerServiceInfo.revision. */
  revision: z.string().max(64).optional(),
});
export type ComputerService = z.infer<typeof ComputerServiceSchema>;

export const ServiceListOutputSchema = z.object({
  /** False when the computer's image predates the supervised service runtime. */
  supported: z.boolean(),
  services: z.array(ComputerServiceSchema),
});
export type ServiceListOutput = z.infer<typeof ServiceListOutputSchema>;

export const ServiceChangesInputSchema = z.object({
  botId: z.string().min(1),
  cwd: z.string().min(1).max(SERVICE_CWD_MAX_LENGTH),
  /** Optional workspace-relative pathspecs restricting the diff. */
  paths: z.array(z.string().min(1).max(512)).max(16).default([]),
});
export type ServiceChangesInput = z.infer<typeof ServiceChangesInputSchema>;

export const ServiceChangesOutputSchema = z.object({
  branch: z.string().nullable(),
  status: z.string(),
  diff: z.string(),
  truncated: z.boolean(),
});
export type ServiceChangesOutput = z.infer<typeof ServiceChangesOutputSchema>;

export const ServicePreviewUrlInputSchema = z.object({
  botId: z.string().min(1),
  name: z.string().regex(SERVICE_NAME_PATTERN),
  port: ServicePortSchema,
});
export type ServicePreviewUrlInput = z.infer<typeof ServicePreviewUrlInputSchema>;

export const ServicePreviewUrlOutputSchema = z.object({
  /** Origin-relative path; clients resolve it against their API origin. */
  path: z.string(),
  expiresAt: z.string(),
});
export type ServicePreviewUrlOutput = z.infer<typeof ServicePreviewUrlOutputSchema>;
