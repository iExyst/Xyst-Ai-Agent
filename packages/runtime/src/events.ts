import { EventEmitter } from "node:events";

export interface RuntimeEvent<T = unknown> {
  id: string;
  type: string;
  at: string;
  sessionId?: string;
  payload: T;
}

export class RuntimeEvents {
  private readonly emitter = new EventEmitter();
  emit<T>(type: string, payload: T, sessionId?: string): RuntimeEvent<T> {
    const event: RuntimeEvent<T> = { id: crypto.randomUUID(), type, at: new Date().toISOString(), payload, ...(sessionId ? { sessionId } : {}) };
    this.emitter.emit(type, event);
    this.emitter.emit("*", event);
    return event;
  }
  on<T = unknown>(type: string, listener: (event: RuntimeEvent<T>) => void): () => void {
    this.emitter.on(type, listener as (event: RuntimeEvent) => void);
    return () => this.emitter.off(type, listener as (event: RuntimeEvent) => void);
  }
}
