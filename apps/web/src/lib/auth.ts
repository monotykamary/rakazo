import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

type AuthClientOptions = { plugins: [ReturnType<typeof organizationClient>] };

export const authClient: ReturnType<typeof createAuthClient<AuthClientOptions>> = createAuthClient({
  plugins: [organizationClient()],
});
