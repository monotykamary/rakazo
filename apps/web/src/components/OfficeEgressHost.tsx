import { useEffect } from "react";
import { desktopBridge } from "../lib/desktop";
import { rpc, selectedSpaceId } from "../lib/rpc";

/** Keeps the desktop exit node up after a restart when the preference is on. */
export function OfficeEgressHost() {
  useEffect(() => {
    const egress = desktopBridge()?.egress;
    if (!egress) return;
    let cancelled = false;
    void rpc.machines.egress.get().then(async (snapshot) => {
      if (cancelled || !snapshot.enabled) return;
      const spaceId = selectedSpaceId();
      if (spaceId) await egress.start(spaceId);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
