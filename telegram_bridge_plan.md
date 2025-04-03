# Plan: Telegram Bridge for Roo-Code `ask_followup_question`

## 1. Goal

Intercept `ask_followup_question` prompts from the Roo-Code VS Code extension, send them to a designated Telegram bot, receive user replies via Telegram, and inject those replies back into the waiting Roo-Code task instance in the correct VS Code window.

## 2. Components

*   **VS Code Extension (`Roo-Code-main`):** Requires modification (TypeScript).
*   **Python Backend:** Existing scripts (`ipc_communication.py`, `run_bot.py`, `telegram_notification_system.py`) require modification.
*   **Telegram Bot:** Configured via `run_bot.py`.

## 3. Communication Channels (File-based IPC)

*   **`roocode_telegram_bridge_outgoing`:** Used by the VS Code extension to send questions *to* the Python backend.
*   **`roocode_telegram_bridge_incoming`:** Used by the Python backend to send replies *back to* the VS Code extension.
*   The `IPCManager` class in `ipc_communication.py` will be used by both sides.

## 4. VS Code Extension Modifications

*   **`Roo-Code-main/src/core/Cline.ts`:**
    *   Modify the `ask` method:
        *   Inside the `else` block (around line 496, after checking `partial`), *before* the `await pWaitFor(...)` loop (line 510):
            *   Check if the `type` parameter corresponds to `ask_followup_question`.
            *   If it is, construct a JSON payload:
                ```json
                {
                  "type": "question_to_telegram",
                  "taskId": this.taskId,
                  "instanceId": this.instanceId,
                  "question": parsed_question_text, // The actual question string
                  "suggestions": parsed_suggestions_array // The array of suggestion strings
                }
                ```
            *   Get access to an `IPCManager` instance.
            *   Call `ipc_manager.send_message('roocode_telegram_bridge_outgoing', payload)` asynchronously (don't `await`).
*   **`Roo-Code-main/src/core/webview/ClineProvider.ts`:**
    *   Ensure an `IPCManager` instance is accessible.
    *   Add a new private method `_startIncomingResponseListener()`:
        *   Runs an async loop.
        *   Inside the loop, calls `ipc_manager.receive_message('roocode_telegram_bridge_incoming', ...)` to check for replies.
        *   If a message `{ type: "response_from_telegram", taskId, instanceId, responseText }` is received, call `this.injectTelegramResponse(taskId, instanceId, responseText)`.
        *   Include a delay (e.g., `await delay(1000)`) in the loop.
    *   Call `this._startIncomingResponseListener()` within `resolveWebviewView`.
    *   Add a new public method `injectTelegramResponse(taskId: string, instanceId: string, responseText: string)`:
        *   Find the `Cline` instance in `this.clineStack` matching `taskId` and `instanceId`.
        *   If found, call `theClineInstance.handleWebviewAskResponse("approve", responseText)`.
        *   Log success or warning if not found.

## 5. Python Backend Modifications

*   **`telegram_notification_system.py`:**
    *   Modify `_ipc_listener_task`:
        *   Listen on IPC channel `roocode_telegram_bridge_outgoing`.
        *   Handle incoming messages with `type: "question_to_telegram"`.
        *   Extract `taskId`, `instanceId`, `question`, `suggestions`.
        *   Find the `chat_id` associated with `taskId` (using the mapping system).
        *   Store `taskId` and `instanceId` as pending for this `chat_id`.
        *   Format and send the question/suggestions to the mapped Telegram `chat_id`.
    *   Modify `handle_telegram_message_input`:
        *   When a Telegram reply is received for a `chat_id`:
            *   Look up the pending `taskId` and `instanceId`.
            *   If found:
                *   Construct the response payload: `{ "type": "response_from_telegram", "taskId": taskId, "instanceId": instanceId, "responseText": response_text }`.
                *   Send this payload to the VS Code extension via IPC channel `roocode_telegram_bridge_incoming` (use executor thread).
                *   Clear the pending state for the `chat_id`.
                *   Notify the Telegram user.
            *   If no pending question found, notify the Telegram user.

## 6. Task ID <-> Chat ID Mapping (Python Backend)

*   Implement a persistent or in-memory mapping (e.g., dictionary) to store `taskId -> chat_id`.
*   Implement a temporary mapping (e.g., dictionary) to store `chat_id -> {taskId, instanceId}` for pending questions.
*   **Registration:** Modify the Telegram `/register` command. Instead of a project name, it should register the `taskId` of the currently active Roo-Code task in the focused VS Code window.
*   **Getting `taskId` to User:** The VS Code extension needs a way to expose the current `taskId` to the user (e.g., display in chat, add a "Copy Task ID" command) so they can use it with `/register`.
*   **Workflow:**
    1.  User starts a task in Roo-Code (gets `taskId`).
    2.  User copies `taskId`.
    3.  User sends `/register <taskId>` to the Telegram bot.
    4.  Python backend stores `taskId -> chat_id`.
    5.  Extension sends question for `taskId` -> Python backend looks up `chat_id` -> Sends to Telegram. Stores `chat_id -> {taskId, instanceId}`.
    6.  User replies in Telegram -> Python backend uses `chat_id` to find `{taskId, instanceId}` -> Sends reply to extension. Clears temporary mapping.

## 7. Testing Precaution

*   Before building the modified VS Code extension into a `.vsix` file for testing, modify its `package.json` file.
*   Change the `name`, `displayName`, and potentially `publisher` fields to unique values (e.g., `roo-code-telegram-test`, "Roo Code Telegram Test").
*   This allows the modified version to be installed alongside the official Roo-Code extension without conflicts.

## 8. Sequence Diagram

```mermaid
sequenceDiagram
    participant RooCode UI (VSCode)
    participant ClineProvider (VSCode Ext)
    participant Cline (VSCode Ext)
    participant Python Backend
    participant Telegram Bot
    participant User (Telegram)

    Note over Cline: LLM responds with <ask_followup_question>
    Cline->>Cline: Processes tool use
    Cline->>Python Backend: Sends {type: "question_to_telegram", taskId, q, suggestions} via IPC (outgoing channel)
    Cline->>Cline: Calls this.ask("followup", ...)
    Cline->>ClineProvider: Calls postStateToWebview()
    ClineProvider->>RooCode UI (VSCode): Displays question & suggestions
    Note over Cline: Execution pauses waiting for askResponse

    Python Backend->>Python Backend: Looks up chat_id from taskId
    Python Backend->>Telegram Bot: Sends formatted question/suggestions
    Telegram Bot->>User (Telegram): Displays question/suggestions

    User (Telegram)->>Telegram Bot: Sends reply message
    Telegram Bot->>Python Backend: Forwards reply message

    Python Backend->>Python Backend: Looks up pending taskId/instanceId from chat_id
    Python Backend->>ClineProvider (VSCode Ext): Sends {type: "response_from_telegram", taskId, instanceId, reply} via IPC (incoming channel)

    Note over ClineProvider (VSCode Ext): Listener task receives response via IPC
    ClineProvider (VSCode Ext)->>ClineProvider (VSCode Ext): Calls injectTelegramResponse(taskId, instanceId, reply)
    ClineProvider (VSCode Ext)->>Cline: Calls handleWebviewAskResponse("approve", reply)
    Note over Cline: askResponse is set, execution resumes
    Cline->>Cline: Processes reply as tool result
    Cline->>Cline: Continues task loop...