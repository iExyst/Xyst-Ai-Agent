import { createRequire } from "node:module";
import type { RuntimeEvents, RuntimeEvent } from "./events.js";

export interface RunNotification { title: string; message: string }
type Notifier = { notify(options: { title: string; message: string }, callback?: (error: Error | null) => void): unknown };

const require = createRequire(import.meta.url);
const nativeNotifier = require("node-notifier") as Notifier;

export function runNotification(event: RuntimeEvent): RunNotification | undefined {
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
  if (event.type === "mission.finished") {
    const status = typeof payload.status === "string" ? payload.status : "finished";
    return status === "completed"
      ? { title: "Xyst mission complete", message: "A mission finished successfully. Open Xyst to review its results." }
      : { title: "Xyst mission needs attention", message: `Mission status: ${status}. Open Xyst to inspect the run.` };
  }
  if (event.type === "agent.failed") return { title: "Xyst task needs attention", message: "The agent run failed. Open Xyst to inspect its details." };
  if (event.type === "agent.finished") {
    const status = typeof payload.status === "string" ? payload.status : "finished";
    return status === "completed"
      ? { title: "Xyst task complete", message: "An agent run finished successfully. Open Xyst to review its results." }
      : { title: "Xyst task needs attention", message: `Agent status: ${status}. Open Xyst to inspect the run.` };
  }
  return undefined;
}

export function subscribeRunNotifications(
  events: RuntimeEvents,
  isEnabled: (event: RuntimeEvent) => boolean,
  notify: (notification: RunNotification) => void,
  onError: (error: unknown) => void = () => undefined
): () => void {
  return events.on("*", (event) => {
    try {
      const notification = runNotification(event);
      if (!notification || !isEnabled(event)) return;
      notify(notification);
    } catch (error) {
      try { onError(error); } catch { /* Notifications cannot interrupt runtime event handling. */ }
    }
  });
}

export function sendNativeNotification(notification: RunNotification): void {
  nativeNotifier.notify({ title: notification.title, message: notification.message }, (error) => {
    if (error) process.stderr.write(`Xyst notification failed: ${error.message.slice(0, 300)}\n`);
  });
}
