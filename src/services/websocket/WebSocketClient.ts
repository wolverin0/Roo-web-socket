import WebSocket from "ws";
import EventEmitter from "events";
import * as vscode from "vscode";

// Define events for communication status and received messages
export interface WebSocketClientEvents {
  connected: [];
  disconnected: [];
  error: [error: Error];
  replyReceived: [taskId: string, reply: string];
}

// Define the structure for messages sent to the bot
interface FollowupMessage {
  type: "followup";
  taskId: string;
  question: string;
  suggestions: any; // Consider defining a stricter type later
}

// Define the structure for messages received from the bot
interface ReplyMessage {
  type: "reply";
  taskId: string;
  reply: string;
}

type BotMessage = FollowupMessage; // Messages sent to bot
type ExtensionMessage = ReplyMessage; // Messages received from bot

const WEBSOCKET_URL = "ws://localhost:8765"; // Default port, make configurable later
const RECONNECT_DELAY = 5000; // 5 seconds

export class WebSocketClient extends EventEmitter<WebSocketClientEvents> {
  private ws: WebSocket | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isConnecting: boolean = false;
  private logger: vscode.OutputChannel; // Changed type to OutputChannel
  
  constructor(outputChannel: vscode.OutputChannel) { // Changed parameter name and type
  	super();
  	this.logger = outputChannel; // Assign the OutputChannel
    this.connect();
  }

  private connect(): void {
    if (this.ws || this.isConnecting) {
      this.logger.appendLine("[INFO] [WebSocketClient] Already connected or connecting."); // Use appendLine
      return;
    }

    this.isConnecting = true;
    this.logger.appendLine(`[INFO] [WebSocketClient] Attempting to connect to ${WEBSOCKET_URL}...`); // Use appendLine

    try {
      // Ensure 'ws' package is installed: npm install ws @types/ws
      this.ws = new WebSocket(WEBSOCKET_URL);

      this.ws.on("open", () => {
        this.isConnecting = false;
        this.logger.appendLine("[INFO] [WebSocketClient] Connection established."); // Use appendLine
        this.emit("connected");
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }
      });

      this.ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString()) as ExtensionMessage;
          // Avoid logging potentially large message content directly
          this.logger.appendLine(`[INFO] [WebSocketClient] Received message of type: ${message.type}, taskId: ${message.taskId}`); // Use appendLine, log less verbosely
          if (message.type === "reply" && message.taskId && typeof message.reply === 'string') { // Added type check for reply
            this.emit("replyReceived", message.taskId, message.reply);
          } else {
             this.logger.appendLine(`[WARN] [WebSocketClient] Received unknown or malformed message format: ${data.toString()}`); // Use appendLine
          }
        } catch (error) {
          this.logger.appendLine(`[ERROR] [WebSocketClient] Error parsing message: ${error instanceof Error ? error.message : String(error)} - Data: ${data.toString()}`); // Use appendLine
        }
      });

      this.ws.on("close", (code, reason) => {
        this.logger.appendLine(`[WARN] [WebSocketClient] Connection closed. Code: ${code}, Reason: ${reason.toString()}`); // Use appendLine
        this.ws = null;
        this.isConnecting = false;
        this.emit("disconnected");
        this.scheduleReconnect();
      });

      this.ws.on("error", (error) => {
        this.logger.appendLine(`[ERROR] [WebSocketClient] Connection error: ${error.message}`); // Use appendLine
        // 'close' event will be triggered after 'error', so reconnection is handled there
        this.emit("error", error);
        this.isConnecting = false; // Ensure we can try reconnecting
        // Ensure ws is nullified if error occurs before 'open' or after 'close'
        if (this.ws && (this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING)) {
             this.ws = null;
        }
      });

    } catch (error) {
         this.logger.appendLine(`[ERROR] [WebSocketClient] Failed to create WebSocket instance: ${error instanceof Error ? error.message : String(error)}`); // Use appendLine
         this.isConnecting = false;
         this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    // Avoid scheduling multiple reconnects
    if (!this.reconnectTimeout && this.ws === null && !this.isConnecting) {
       this.logger.appendLine(`[INFO] [WebSocketClient] Scheduling reconnect in ${RECONNECT_DELAY / 1000} seconds...`); // Use appendLine
      this.reconnectTimeout = setTimeout(() => {
        this.reconnectTimeout = null;
        this.connect();
      }, RECONNECT_DELAY);
    }
  }

  public sendFollowupQuestion(taskId: string, question: string, suggestions: any): void {
    const message: FollowupMessage = {
      type: "followup",
      taskId,
      question,
      suggestions,
    };
    this.sendMessage(message);
  }

  private sendMessage(message: BotMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const messageString = JSON.stringify(message);
        this.ws.send(messageString);
        // Avoid logging potentially large message content
        this.logger.appendLine(`[INFO] [WebSocketClient] Sent message of type: ${message.type}, taskId: ${message.taskId}`); // Use appendLine, log less verbosely
       } catch (error) {
        this.logger.appendLine(`[ERROR] [WebSocketClient] Error sending message: ${error instanceof Error ? error.message : String(error)}`); // Use appendLine
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    } else {
      this.logger.appendLine("[WARN] [WebSocketClient] Cannot send message, connection not open."); // Use appendLine
      // Optionally queue messages here if needed
    }
  }

  public dispose(): void {
    this.logger.appendLine("[INFO] [WebSocketClient] Disposing..."); // Use appendLine
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      // Remove listeners to prevent reconnection attempts after explicit disposal
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.removeAllListeners(); // Remove listeners from the EventEmitter itself
  }
}