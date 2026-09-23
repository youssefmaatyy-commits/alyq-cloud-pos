/**
 * Settings/marketing writes invalidate the public storefront snapshot. The
 * in-document listeners cover a route change; BroadcastChannel also refreshes
 * a storefront already open in another tab of the same origin. No settings or
 * shopper data is sent on the channel — only a request to re-read the source.
 */
type Listener = () => void;
const listeners = new Set<Listener>();
const CHANNEL = "alyq.storefront.invalidate";
let channel: BroadcastChannel | null = null;

function publishLocally(): void {
  for (const listener of listeners) listener();
}

function sharedChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof window === "undefined" || typeof window.BroadcastChannel === "undefined") return null;
  channel = new window.BroadcastChannel(CHANNEL);
  channel.onmessage = publishLocally;
  return channel;
}

export const storefrontInvalidation = {
  notify(): void {
    publishLocally();
    sharedChannel()?.postMessage("changed");
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    sharedChannel();
    return () => { listeners.delete(listener); };
  },
};