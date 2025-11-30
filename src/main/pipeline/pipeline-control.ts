type Listener = (state: { paused: boolean }) => void;

export interface PauseSignal {
  waitIfPaused(): Promise<void>;
  readonly paused: boolean;
  onChange(listener: (state: { paused: boolean }) => void): () => void;
}

export class PipelineControl implements PauseSignal {
  private _paused = false;
  private waiters: Array<() => void> = [];
  private listeners = new Set<Listener>();

  get paused(): boolean {
    return this._paused;
  }

  pause(): void {
    if (this._paused) {
      return;
    }
    this._paused = true;
    this.emit();
  }

  resume(): void {
    if (!this._paused) {
      return;
    }
    this._paused = false;
    const waiters = [...this.waiters];
    this.waiters = [];
    for (const resolve of waiters) {
      resolve();
    }
    this.emit();
  }

  reset(): void {
    this._paused = false;
    this.waiters = [];
  }

  async waitIfPaused(): Promise<void> {
    if (!this._paused) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener({ paused: this._paused });
    }
  }
}
