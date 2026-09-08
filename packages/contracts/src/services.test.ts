import { expect, it } from "vitest";
import { isAllowedServicePort, ServicePortSchema } from "./services.js";

it("reserves computer control, VNC, and service-supervisor ports", () => {
  for (const port of [
    7070,
    9011,
    ...Array.from({ length: 16 }, (_, i) => 5900 + i),
    ...Array.from({ length: 16 }, (_, i) => 6080 + i),
  ]) {
    expect(isAllowedServicePort(port)).toBe(false);
    expect(ServicePortSchema.safeParse(port).success).toBe(false);
  }
  for (const port of [1024, 3000, 5173, 8080, 65535])
    expect(ServicePortSchema.safeParse(port).success).toBe(true);
});
