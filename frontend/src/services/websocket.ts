import type { WebSocketMessage } from '../types';

export type MessageHandler = (msg: WebSocketMessage) => void;
export type StatusHandler = (connected: boolean) => void;

class QuoteWebSocketClient {
  private ws: WebSocket | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();
  private reconnectDelay = 1000;
  private reconnectTimer: number | null = null;
  private pingInterval: number | null = null;
  private pongTimeoutTimer: number | null = null;
  private lastPongTime: number = Date.now();
  private shouldConnect = false;
  private visibilityListenerAttached = false;

  public isConnected = false;

  public connect() {
    this.shouldConnect = true;
    this.setupVisibilityListener();
    this.cleanup();

    const loc = window.location;
    const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = import.meta.env.VITE_WS_HOST || loc.host;
    const wsUrl = `${protocol}//${host}/ws/quotes`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.lastPongTime = Date.now();
        this.reconnectDelay = 1000;
        this.notifyStatus(true);
        this.startHeartbeat();
      };

      this.ws.onmessage = (event) => {
        this.lastPongTime = Date.now();
        this.clearPongTimeout();
        try {
          const data: WebSocketMessage = JSON.parse(event.data);
          if (data.type === 'pong') {
            return;
          }
          this.notifyMessage(data);
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this.notifyStatus(false);
        this.stopHeartbeat();
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.warn('WebSocket error:', err);
      };
    } catch (e) {
      console.error('WebSocket connection failed to initiate:', e);
      this.scheduleReconnect();
    }
  }

  public disconnect() {
    this.shouldConnect = false;
    this.cleanup();
  }

  public forceReconnect() {
    this.cleanup();
    this.reconnectDelay = 1000;
    this.connect();
  }

  private setupVisibilityListener() {
    if (this.visibilityListenerAttached || typeof document === 'undefined') return;
    this.visibilityListenerAttached = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.shouldConnect) {
        const isStale = Date.now() - this.lastPongTime > 30000;
        if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN || isStale) {
          console.log('[WebSocket] Page visible and connection is disconnected or stale, reconnecting...');
          this.forceReconnect();
        }
      }
    });
  }

  private cleanup() {
    this.stopHeartbeat();
    this.clearPongTimeout();
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch (e) {
        // Ignore close error during teardown
      }
      this.ws = null;
    }
  }

  private scheduleReconnect() {
    if (!this.shouldConnect || this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
      this.connect();
    }, this.reconnectDelay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingInterval = window.setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
        this.startPongTimeout();
      }
    }, 20000);
  }

  private startPongTimeout() {
    this.clearPongTimeout();
    this.pongTimeoutTimer = window.setTimeout(() => {
      console.warn('[WebSocket] Pong heartbeat timeout (10s), forcing reconnection...');
      this.clearPongTimeout();
      this.forceReconnect();
    }, 10000);
  }

  private clearPongTimeout() {
    if (this.pongTimeoutTimer) {
      window.clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }
  }

  private stopHeartbeat() {
    if (this.pingInterval) {
      window.clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.clearPongTimeout();
  }

  public onMessage(handler: MessageHandler) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  public onStatus(handler: StatusHandler) {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private notifyMessage(msg: WebSocketMessage) {
    this.messageHandlers.forEach((h) => h(msg));
  }

  private notifyStatus(connected: boolean) {
    this.statusHandlers.forEach((h) => h(connected));
  }
}

export const wsClient = new QuoteWebSocketClient();
