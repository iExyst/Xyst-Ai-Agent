import { inspectNativeAutomation } from "./tools/desktop-automation.js";

type SessionEnvironment = Partial<Pick<NodeJS.ProcessEnv, "XDG_SESSION_TYPE" | "XDG_CURRENT_DESKTOP" | "WAYLAND_DISPLAY" | "DISPLAY" | "SSH_TTY" | "SSH_CONNECTION" | "PATH">>;

export type DesktopCapabilities = {
  platform: NodeJS.Platform;
  session: {
    type: "wayland" | "x11" | "unknown" | "not-applicable";
    desktop: string | null;
    remote: boolean;
  };
  browser: {
    headless: "available";
    headed: "display-detected" | "no-display-detected" | "platform-managed";
    note: string;
  };
  nativeApplicationAutomation: {
    available: boolean;
    backend: string | null;
    reason: string;
  };
};

/** Reports detected session signals and the available native automation backend. */
export function inspectDesktopCapabilities(environment: SessionEnvironment = process.env, runtimePlatform: NodeJS.Platform = process.platform): DesktopCapabilities {
  const isLinux = runtimePlatform === "linux";
  const declaredSession = environment.XDG_SESSION_TYPE?.toLowerCase();
  const sessionType = declaredSession === "wayland" || declaredSession === "x11"
    ? declaredSession
    : environment.WAYLAND_DISPLAY ? "wayland"
      : environment.DISPLAY ? "x11"
        : "unknown";
  const hasDisplaySignal = Boolean(environment.WAYLAND_DISPLAY || environment.DISPLAY);
  const remote = Boolean(environment.SSH_TTY || environment.SSH_CONNECTION);
  const nativeAutomation = inspectNativeAutomation({ platform: runtimePlatform, env: environment as NodeJS.ProcessEnv });

  return {
    platform: runtimePlatform,
    session: {
      type: isLinux ? sessionType : "not-applicable",
      desktop: isLinux ? environment.XDG_CURRENT_DESKTOP?.trim() || null : null,
      remote: isLinux && remote
    },
    browser: {
      headless: "available",
      headed: !isLinux ? "platform-managed" : hasDisplaySignal ? "display-detected" : "no-display-detected",
      note: isLinux
        ? hasDisplaySignal
          ? "A display session is advertised by the environment; Chromium launch is not verified and may still be blocked by the compositor or session permissions."
          : "No Wayland or X11 display is advertised. Use headless browser mode, or start Xyst inside a graphical session for headed Chromium."
        : "Visible browser availability depends on the host's interactive desktop session.",
    },
    nativeApplicationAutomation: {
      available: nativeAutomation.available,
      backend: nativeAutomation.backend,
      reason: nativeAutomation.limitation
    }
  };
}
