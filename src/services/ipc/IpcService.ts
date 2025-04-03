import * as vscode from "vscode";
import * as fs from "fs"; // Use standard fs for watch
import * as fsPromises from "fs/promises"; // Use fs/promises for async file operations
import * as path from "path";
import * as os from "os";
import { ClineProvider } from "../../core/webview/ClineProvider";
// import { formatResponse } from "../../core/prompts/responses"; // Not used in this file

interface IpcMessage {
    taskId: string;
    instanceId: string;
    // Define all possible message types
    type: "ask_response" | "response_from_telegram" | "ask_notification" | "completion_notification";
    // Payload structure varies based on type
    payload?: {
        question?: string;      // For ask_notification
        suggestions?: string[]; // For ask_notification
        result?: string;        // For completion_notification
    };
    responseText?: string; // For response_from_telegram
    chat_id?: string; // Add optional chat_id for notifications
    // Add timestamp if needed by Python side (optional)
    timestamp?: number;
}

export class IpcService implements vscode.Disposable {
    private ipcDir: string;
    private watcher: fs.FSWatcher | null = null; // FSWatcher comes from standard 'fs'
    private provider: ClineProvider;
    private isDisposed = false;

    constructor(provider: ClineProvider) {
        this.provider = provider;
        // Define IPC directory (e.g., in temp directory)
        this.ipcDir = path.join(os.tmpdir(), "roocode_ipc"); // Match the directory name used in Python config.py
        console.log(`[IpcService] Using IPC directory: ${this.ipcDir}`);
    }

    async initialize(): Promise<void> {
        try {
            await fsPromises.mkdir(this.ipcDir, { recursive: true }); // Explicitly use fsPromises.mkdir
            console.log(`[IpcService] Ensured IPC directory exists: ${this.ipcDir}`);
            this.startWatching();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to initialize Roo-Code IPC service: ${error}`);
            console.error(`[IpcService] Failed to create IPC directory: ${error}`);
        }
    }

    private startWatching(): void {
        if (this.watcher || this.isDisposed) {
            return; // Already watching or disposed
        }
        try {
            console.log(`[IpcService] Starting to watch directory: ${this.ipcDir}`);
            // Use standard fs.watch with callback
            this.watcher = fs.watch(this.ipcDir, { persistent: false }, async (eventType, filename) => {
                // Watch for *any* .response.json file change or creation
                if (filename && filename.endsWith('.response.json')) {
                    // On 'rename' (often creation) or 'change', handle the specific file
                    if (eventType === 'rename' || eventType === 'change') {
                        console.log(`[IpcService] Detected ${eventType} for response file: ${filename}`);
                        // Add a small delay, especially for 'rename', as the file might not be fully written yet
                        await new Promise(resolve => setTimeout(resolve, 150));
                        await this.handleIncomingResponse(filename); // Pass the specific filename
                    }
                } else if (filename) {
                     // console.log(`[IpcService] Ignoring change in unrelated file: ${filename}`);
                }
            });

            this.watcher.on('error', (error) => {
                console.error(`[IpcService] Watcher error: ${error}`);
                // Optionally try to restart the watcher
                this.stopWatching();
                if (!this.isDisposed) {
                    setTimeout(() => this.startWatching(), 5000); // Retry after 5 seconds
                }
            });

            console.log(`[IpcService] Successfully started watching ${this.ipcDir}`);

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to start watching IPC directory: ${error}`);
            console.error(`[IpcService] Failed to start watcher: ${error}`);
            this.watcher = null;
        }
    }

    // Update handleIncomingResponse to accept the specific filename
    private async handleIncomingResponse(filename: string): Promise<void> {
        const filePath = path.join(this.ipcDir, filename);
        try {
            // Check if file exists before attempting to read
            // Use fsPromises for async access check
            await fsPromises.access(filePath);

            // Use fsPromises for async read and unlink
            const content = await fsPromises.readFile(filePath, 'utf-8');
            await fsPromises.unlink(filePath); // Delete the file after reading
            console.log(`[IpcService] Read and deleted response file: ${filePath}`);

            if (!content.trim()) {
                console.log("[IpcService] Response file was empty.");
                return;
            }

            const message: IpcMessage = JSON.parse(content);
            console.log("[IpcService] Parsed message:", message);

            // Adjust condition to match the actual message format from Python bot
            if (message.type === "response_from_telegram" && message.taskId && message.instanceId && message.responseText) {
                const currentCline = this.provider.getCurrentCline();
                if (currentCline && currentCline.taskId === message.taskId && currentCline.instanceId === message.instanceId) {
                    console.log(`[IpcService] Current Cline instance ${message.taskId}.${message.instanceId} matches IPC message. Handling external response.`);
                    // Use the new method on Cline instance
                    currentCline.handleExternalAskResponse(message.responseText);
                } else if (currentCline) {
                    console.warn(`[IpcService] Received IPC response for ${message.taskId}.${message.instanceId}, but current active task is ${currentCline.taskId}.${currentCline.instanceId}. Ignoring.`);
                } else {
                    console.warn(`[IpcService] No active Cline instance found, but received IPC response for ${message.taskId}.${message.instanceId}. Ignoring.`);
                }
            } else {
                console.warn("[IpcService] Received invalid or unsupported message format:", message);
            }
        } catch (error) {
            // Handle file not found error gracefully (it might have been processed quickly)
            if (error.code === 'ENOENT') {
                // console.log(`[IpcService] Response file ${filePath} not found, likely already processed.`);
            } else {
                console.error(`[IpcService] Error handling incoming response from ${filePath}: ${error}`);
            }
        }
    }

    // Method to be called by Cline when an 'ask_followup_question' occurs
    public async sendAskNotification(taskId: string, instanceId: string, question: string, suggestions: string[]): Promise<void> {
        console.log(`[IpcService] sendAskNotification called for Task ${taskId}, Instance ${instanceId}`);
        // Read chat ID from configuration
        const config = vscode.workspace.getConfiguration('roo-cline');
        const chatId = config.get<string | null>('telegram.chatId');

        if (!chatId) {
            console.warn("[IpcService] Telegram Chat ID not configured ('roo-cline.telegram.chatId'). Cannot send notification.");
            // Optionally, inform the user via VS Code notification
            vscode.window.showWarningMessage("Telegram Chat ID not configured. Please set 'roo-cline.telegram.chatId' in your settings to use Telegram notifications.");
            return; // Stop if no chat ID is configured
        }

        // Construct filename based on task and instance ID
        const filename = `${taskId}_${instanceId}.notification.json`;
        const notificationFilePath = path.join(this.ipcDir, filename);

        console.log(`[IpcService] Attempting to write notification file: ${notificationFilePath}`);
        const notification: IpcMessage = {
            timestamp: Date.now(),
            taskId,
            instanceId,
            type: "ask_notification", // Match type expected by Python bot
            chat_id: chatId!, // Include the configured chat ID (non-null assertion as it's checked earlier)
            payload: {
                // Inline the logic from removeClosingTag (simplified as we don't handle partials here)
                question: question.endsWith("</question>") ? question.slice(0, -11) : question,
                // Clean suggestions too
                suggestions: suggestions.map(s => s.endsWith("</suggest>") ? s.slice(0, -10) : s)
            }
        };

        try {
            // Use fsPromises for async write
            await fsPromises.writeFile(notificationFilePath, JSON.stringify(notification, null, 2));
            console.log(`[IpcService] Sent ask notification to ${notificationFilePath}`);
        } catch (error) {
            console.error(`[IpcService] Failed to send ask notification: ${error}`);
            // Optionally notify the user in VS Code
            vscode.window.showWarningMessage(`Roo-Code: Could not notify external system (Telegram?). Error: ${error.message}`);
        }
    }

    // Method to be called by Cline when an 'attempt_completion' occurs
    public async sendCompletionNotification(taskId: string, instanceId: string, resultText: string): Promise<void> {
        console.log(`[IpcService] sendCompletionNotification called for Task ${taskId}, Instance ${instanceId}`);
        const config = vscode.workspace.getConfiguration('roo-cline');
        const chatId = config.get<string | null>('telegram.chatId');

        if (!chatId) {
            console.warn("[IpcService] Telegram Chat ID not configured ('roo-cline.telegram.chatId'). Cannot send completion notification.");
            // No need to show warning again if ask notification already did
            return; // Stop if no chat ID is configured
        }

        // Construct filename based on task and instance ID
        const filename = `${taskId}_${instanceId}.notification.json`;
        const notificationFilePath = path.join(this.ipcDir, filename);

        console.log(`[IpcService] Attempting to write completion notification file: ${notificationFilePath}`);
        const notification: IpcMessage = {
            timestamp: Date.now(),
            taskId,
            instanceId,
            type: "completion_notification",
            chat_id: chatId!, // Add chat_id (non-null assertion as it's checked earlier)
            payload: {
                result: resultText // Send the completion result text
            }
        };

        try {
            // Use fsPromises for async write
            await fsPromises.writeFile(notificationFilePath, JSON.stringify(notification, null, 2));
            console.log(`[IpcService] Sent completion notification to ${notificationFilePath}`);
        } catch (error) {
            console.error(`[IpcService] Failed to write completion notification file ${notificationFilePath}: ${error}`);
            // Optionally notify user in VS Code
            vscode.window.showErrorMessage(`Failed to send Telegram completion notification: ${error}`);
        }
    }

    private stopWatching(): void {
        if (this.watcher) {
            console.log("[IpcService] Stopping file watcher.");
            this.watcher.close();
            this.watcher = null;
        }
    }

    dispose(): void {
        console.log("[IpcService] Disposing IPC Service.");
        this.isDisposed = true;
        this.stopWatching();
        // No directory cleanup needed, OS handles temp files
    }
}
