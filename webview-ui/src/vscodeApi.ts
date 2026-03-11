declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

class VscodeApiFallback {
  private ws: WebSocket | null = null;
  private messageQueue: unknown[] = [];

  constructor() {
    if (typeof window !== 'undefined') {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws`;
      this.connect(url);
    }
  }

  private connect(url: string) {
    console.log('[Standalone] Connecting to WebSocket...', url);
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[Standalone] WebSocket connected');
      while (this.messageQueue.length > 0) {
        const msg = this.messageQueue.shift();
        this.ws!.send(JSON.stringify(msg));
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        window.dispatchEvent(new MessageEvent('message', { data }));
      } catch (err) {
        console.error('[Standalone] Failed to parse WebSocket message', err);
      }
    };

    this.ws.onclose = () => {
      console.log('[Standalone] WebSocket disconnected. Reconnecting in 2s...');
      setTimeout(() => this.connect(url), 2000);
    };

    this.ws.onerror = (err) => {
      console.error('[Standalone] WebSocket error', err);
    };
  }

  postMessage(msg: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.messageQueue.push(msg);
    }
  }
}

let api: { postMessage(msg: unknown): void };
try {
  api = acquireVsCodeApi();
} catch (e) {
  api = new VscodeApiFallback();
}

export const vscode = api;
