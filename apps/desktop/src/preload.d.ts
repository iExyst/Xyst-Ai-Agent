export {};

declare global {
  interface Window {
    xyst: {
      snapshot(): Promise<{ status: Record<string, unknown>; updateState?: Record<string, any>; sessions: unknown[]; memories: Array<Record<string, any>>; missions: Array<Record<string, any>>; agents: Array<Record<string, any>>; jobs: Array<Record<string, any>>; models: Array<Record<string, any>>; downloads: Array<Record<string, any>>; modelsError?: string; settings: Record<string, any> }>;
      invoke(action: string, payload?: unknown): Promise<any>;
      createMission(definition: unknown): Promise<unknown>;
      pickAttachments(): Promise<string[]>;
      runAgent(objective: string, attachments: string[] | undefined, runId: string): Promise<void>;
      resumeSession(sessionId: string, message: string, attachments: string[] | undefined, runId: string): Promise<void>;
      cancelAgent(runId: string): Promise<{ cancelled: boolean }>;
      sendAgentMessage(runId: string, content: string): Promise<{ accepted: boolean }>;
      openSessionArtifact(sessionId: string, artifactId: string): Promise<{ opened: boolean }>;
      onAgentEvent(listener: (event: Record<string, unknown>) => void): () => void;
      onUpdaterEvent(listener: (event: Record<string, unknown>) => void): () => void;
    };
  }
}
