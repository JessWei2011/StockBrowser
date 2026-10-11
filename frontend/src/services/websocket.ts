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
  private shouldConnect = false;

  public isConnected = false;

  public connect() {
    this.shouldConnect = true;
    this.cleanup();

    const loc = window.location;
    const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = import.meta.env.VITE_WS_HOST || loc.host;
    const wsUrl = `${protocol}//${host}/ws/quotes`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.reconnectDelay = 1000;
        this.notifyStatus(true);
        this.startHeartbeat();
      };

      this.ws.onmessage = (event) => {
        try {
          const data: WebSocketMessage = JSON.parse(event.data);
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

  private cleanup() {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
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
      }
    }, 20000);
  }

  private stopHeartbeat() {
    if (this.pingInterval) {
      window.clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
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
