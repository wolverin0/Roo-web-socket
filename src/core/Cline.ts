
import { spawn } from "child_process";

import fs from "fs/promises"
import * as path from "path"
import os from "os"
import crypto from "crypto"
import EventEmitter from "events"

import { Anthropic } from "@anthropic-ai/sdk"
import cloneDeep from "clone-deep"
import delay from "delay"
import pWaitFor from "p-wait-for"
import getFolderSize from "get-folder-size"
import { serializeError } from "serialize-error"
import * as vscode from "vscode"
import { isPathOutsideWorkspace } from "../utils/pathUtils"

import { TokenUsage } from "../exports/roo-code"
import { ApiHandler, buildApiHandler } from "../api"
import { ApiStream } from "../api/transform/stream"
import { DIFF_VIEW_URI_SCHEME, DiffViewProvider } from "../integrations/editor/DiffViewProvider"
import {
	CheckpointServiceOptions,
	RepoPerTaskCheckpointService,
	RepoPerWorkspaceCheckpointService,
} from "../services/checkpoints"
import { findToolName, formatContentBlockToMarkdown } from "../integrations/misc/export-markdown"
import {
	extractTextFromFile,
	addLineNumbers,
	stripLineNumbers,
	everyLineHasLineNumbers,
} from "../integrations/misc/extract-text"
import { countFileLines } from "../integrations/misc/line-counter"
import { fetchInstructions } from "./prompts/instructions/instructions"
import { ExitCodeDetails } from "../integrations/terminal/TerminalProcess"
import { Terminal } from "../integrations/terminal/Terminal"
import { TerminalRegistry } from "../integrations/terminal/TerminalRegistry"
import { UrlContentFetcher } from "../services/browser/UrlContentFetcher"
import { listFiles } from "../services/glob/list-files"
import { regexSearchFiles } from "../services/ripgrep"
import { parseSourceCodeDefinitionsForFile, parseSourceCodeForDefinitionsTopLevel } from "../services/tree-sitter"
import { CheckpointStorage } from "../shared/checkpoints"
import { ApiConfiguration } from "../shared/api"
import { findLastIndex } from "../shared/array"
import { combineApiRequests } from "../shared/combineApiRequests"
import { combineCommandSequences } from "../shared/combineCommandSequences"
import {
	BrowserAction,
	BrowserActionResult,
	browserActions,
	ClineApiReqCancelReason,
	ClineApiReqInfo,
	ClineAsk,
	ClineAskUseMcpServer,
	ClineMessage,
	ClineSay,
	ClineSayBrowserAction,
	ClineSayTool,
	ToolProgressStatus,
} from "../shared/ExtensionMessage"
import { getApiMetrics } from "../shared/getApiMetrics"
import { HistoryItem } from "../shared/HistoryItem"
import { ClineAskResponse } from "../shared/WebviewMessage"
import { GlobalFileNames } from "../shared/globalFileNames"
import { defaultModeSlug, getModeBySlug, getFullModeDetails } from "../shared/modes"
import { EXPERIMENT_IDS, experiments as Experiments, ExperimentId } from "../shared/experiments"
import { calculateApiCostAnthropic } from "../utils/cost"
import { fileExistsAtPath } from "../utils/fs"
import { arePathsEqual, getReadablePath } from "../utils/path"
import { parseMentions } from "./mentions"
import { RooIgnoreController } from "./ignore/RooIgnoreController"
import { AssistantMessageContent, parseAssistantMessage, ToolParamName, ClineToolUseName } from "./assistant-message"
import { formatResponse } from "./prompts/responses"
import { SYSTEM_PROMPT } from "./prompts/system"
import { truncateConversationIfNeeded } from "./sliding-window"
import { ClineProvider } from "./webview/ClineProvider"
import { detectCodeOmission } from "../integrations/editor/detect-omission"
import { BrowserSession } from "../services/browser/BrowserSession"
import { formatLanguage } from "../shared/language"
import { McpHub } from "../services/mcp/McpHub"
import { WebSocketClient } from "../services/websocket/WebSocketClient" // Added WebSocketClient import
import { DiffStrategy, getDiffStrategy } from "./diff/DiffStrategy"
import { insertGroups } from "./diff/insert-groups"
import { telemetryService } from "../services/telemetry/TelemetryService"
import { validateToolUse, isToolAllowedForMode, ToolName } from "./mode-validator"
import { parseXml } from "../utils/xml"
import { readLines } from "../integrations/misc/read-lines"
import { getWorkspacePath } from "../utils/path"
import { isBinaryFile } from "isbinaryfile"

type ToolResponse = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>
type UserContent = Array<Anthropic.Messages.ContentBlockParam>

export type ClineEvents = {
	message: [{ action: "created" | "updated"; message: ClineMessage }]
	taskStarted: []
	taskPaused: []
	taskUnpaused: []
	taskAskResponded: []
	taskAborted: []
	taskSpawned: [taskId: string]
	taskCompleted: [taskId: string, usage: TokenUsage]
	taskTokenUsageUpdated: [taskId: string, usage: TokenUsage]
}

// Removed IpcService import
 
 // ... other imports

export type ClineOptions = {
	provider: ClineProvider
	apiConfiguration: ApiConfiguration
	// Removed ipcService option
	webSocketClient?: WebSocketClient // Added webSocketClient
	customInstructions?: string
	enableDiff?: boolean
	enableCheckpoints?: boolean
	checkpointStorage?: CheckpointStorage
	fuzzyMatchThreshold?: number
	task?: string
	images?: string[]
	historyItem?: HistoryItem
	experiments?: Record<string, boolean>
	startTask?: boolean
	rootTask?: Cline
	parentTask?: Cline
	taskNumber?: number
	onCreated?: (cline: Cline) => void
}

export class Cline extends EventEmitter<ClineEvents> {
	readonly taskId: string
	readonly instanceId: string
	get cwd() {
		return getWorkspacePath(path.join(os.homedir(), "Desktop"))
	}
	// Subtasks
	readonly rootTask: Cline | undefined = undefined
	readonly parentTask: Cline | undefined = undefined
	readonly taskNumber: number
	private isPaused: boolean = false
	private pausedModeSlug: string = defaultModeSlug
	private pauseInterval: NodeJS.Timeout | undefined

	readonly apiConfiguration: ApiConfiguration
	api: ApiHandler
	private urlContentFetcher: UrlContentFetcher
	private browserSession: BrowserSession
	// Removed IpcService property
	private webSocketClient?: WebSocketClient
	private didEditFile: boolean = false
	customInstructions?: string
	diffStrategy?: DiffStrategy
	diffEnabled: boolean = false
	fuzzyMatchThreshold: number = 1.0

	apiConversationHistory: (Anthropic.MessageParam & { ts?: number })[] = []
	clineMessages: ClineMessage[] = []
	rooIgnoreController?: RooIgnoreController
  private pendingCompletionBlock: Anthropic.Messages.ToolUseBlock | null = null;
	private askResponse?: ClineAskResponse
	private askResponseText?: string
	private askResponseImages?: string[]
	private lastMessageTs?: number
	private consecutiveMistakeCount: number = 0
	private consecutiveMistakeCountForApplyDiff: Map<string, number> = new Map()
	private providerRef: WeakRef<ClineProvider>
	private abort: boolean = false
	didFinishAbortingStream = false
	abandoned = false
	private diffViewProvider: DiffViewProvider
	private lastApiRequestTime?: number
	isInitialized = false

	// checkpoints
	private enableCheckpoints: boolean
	private checkpointStorage: CheckpointStorage
	private checkpointService?: RepoPerTaskCheckpointService | RepoPerWorkspaceCheckpointService

	// streaming
	isWaitingForFirstChunk = false
	isStreaming = false
	private currentStreamingContentIndex = 0
	private assistantMessageContent: AssistantMessageContent[] = []
	private presentAssistantMessageLocked = false
	private presentAssistantMessageHasPendingUpdates = false
	private userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []
	private userMessageContentReady = false
	private didRejectTool = false
	private didAlreadyUseTool = false
	private didCompleteReadingStream = false

	constructor({
		provider,
		apiConfiguration,
		// Removed ipcService
		webSocketClient, // Added webSocketClient
		customInstructions,
		enableDiff,
		enableCheckpoints = true,
		checkpointStorage = "task",
		fuzzyMatchThreshold,
		task,
		images,
		historyItem,
		experiments,
		startTask = true,
		rootTask,
		parentTask,
		taskNumber,
		onCreated,
	}: ClineOptions) {
		super()

		if (startTask && !task && !images && !historyItem) {
			throw new Error("Either historyItem or task/images must be provided")
		}

		this.rooIgnoreController = new RooIgnoreController(this.cwd)
		this.rooIgnoreController.initialize().catch((error) => {
			console.error("Failed to initialize RooIgnoreController:", error)
		})

		this.taskId = historyItem ? historyItem.id : crypto.randomUUID()
		this.instanceId = crypto.randomUUID().slice(0, 8)
		this.taskNumber = -1
		this.apiConfiguration = apiConfiguration
		this.api = buildApiHandler(apiConfiguration)
		this.urlContentFetcher = new UrlContentFetcher(provider.context)
		this.browserSession = new BrowserSession(provider.context)
		// Removed ipcService assignment
		this.webSocketClient = webSocketClient // Store WebSocketClient instance
		this.customInstructions = customInstructions
		this.diffEnabled = enableDiff ?? false
		this.fuzzyMatchThreshold = fuzzyMatchThreshold ?? 1.0
		this.providerRef = new WeakRef(provider)
		this.diffViewProvider = new DiffViewProvider(this.cwd)
		this.enableCheckpoints = enableCheckpoints
		this.checkpointStorage = checkpointStorage

		this.rootTask = rootTask
		this.parentTask = parentTask
		this.taskNumber = taskNumber ?? -1

		if (historyItem) {
			telemetryService.captureTaskRestarted(this.taskId)
		} else {
			telemetryService.captureTaskCreated(this.taskId)
		}

		// Initialize diffStrategy based on current state
		this.updateDiffStrategy(
			Experiments.isEnabled(experiments ?? {}, EXPERIMENT_IDS.DIFF_STRATEGY),
			Experiments.isEnabled(experiments ?? {}, EXPERIMENT_IDS.MULTI_SEARCH_AND_REPLACE),
		)
	
		// Add listener for WebSocket replies
		this.webSocketClient?.on("replyReceived", this.handleWebSocketReply)
	
		onCreated?.(this)

		if (startTask) {
			if (task || images) {
				this.startTask(task, images)
			} else if (historyItem) {
				this.resumeTaskFromHistory()
			} else {
				throw new Error("Either historyItem or task/images must be provided")
			}
		}
	}

	static create(options: ClineOptions): [Cline, Promise<void>] {
		// Pass all options correctly
		const instance = new Cline({ ...options, startTask: false })
		const { images, task, historyItem } = options
		let promise

		if (images || task) {
			promise = instance.startTask(task, images)
		} else if (historyItem) {
			promise = instance.resumeTaskFromHistory()
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}

		return [instance, promise]
	}

	// Add method to update diffStrategy
	async updateDiffStrategy(experimentalDiffStrategy?: boolean, multiSearchReplaceDiffStrategy?: boolean) {
		// If not provided, get from current state
		if (experimentalDiffStrategy === undefined || multiSearchReplaceDiffStrategy === undefined) {
			const { experiments: stateExperimental } = (await this.providerRef.deref()?.getState()) ?? {}
			if (experimentalDiffStrategy === undefined) {
				experimentalDiffStrategy = stateExperimental?.[EXPERIMENT_IDS.DIFF_STRATEGY] ?? false
			}
			if (multiSearchReplaceDiffStrategy === undefined) {
				multiSearchReplaceDiffStrategy = stateExperimental?.[EXPERIMENT_IDS.MULTI_SEARCH_AND_REPLACE] ?? false
			}
		}

		this.diffStrategy = getDiffStrategy(
			this.api.getModel().id,
			this.fuzzyMatchThreshold,
			experimentalDiffStrategy,
			multiSearchReplaceDiffStrategy,
		)
	}

	// Storing task to disk for history

	private async ensureTaskDirectoryExists(): Promise<string> {
		const globalStoragePath = this.providerRef.deref()?.context.globalStorageUri.fsPath
		if (!globalStoragePath) {
			throw new Error("Global storage uri is invalid")
		}

		// Use storagePathManager to retrieve the task storage directory
		const { getTaskDirectoryPath } = await import("../shared/storagePathManager")
		return getTaskDirectoryPath(globalStoragePath, this.taskId)
	}

	private async getSavedApiConversationHistory(): Promise<Anthropic.MessageParam[]> {
		const filePath = path.join(await this.ensureTaskDirectoryExists(), GlobalFileNames.apiConversationHistory)
		const fileExists = await fileExistsAtPath(filePath)
		if (fileExists) {
			return JSON.parse(await fs.readFile(filePath, "utf8"))
		}
		return []
	}

	private async addToApiConversationHistory(message: Anthropic.MessageParam) {
		const messageWithTs = { ...message, ts: Date.now() }
		this.apiConversationHistory.push(messageWithTs)
		await this.saveApiConversationHistory()
	}

	async overwriteApiConversationHistory(newHistory: Anthropic.MessageParam[]) {
		this.apiConversationHistory = newHistory
		await this.saveApiConversationHistory()
	}

	private async saveApiConversationHistory() {
		try {
			const filePath = path.join(await this.ensureTaskDirectoryExists(), GlobalFileNames.apiConversationHistory)
			await fs.writeFile(filePath, JSON.stringify(this.apiConversationHistory))
		} catch (error) {
			// in the off chance this fails, we don't want to stop the task
			console.error("Failed to save API conversation history:", error)
		}
	}

	private async getSavedClineMessages(): Promise<ClineMessage[]> {
		const filePath = path.join(await this.ensureTaskDirectoryExists(), GlobalFileNames.uiMessages)
		if (await fileExistsAtPath(filePath)) {
			return JSON.parse(await fs.readFile(filePath, "utf8"))
		} else {
			// check old location
			const oldPath = path.join(await this.ensureTaskDirectoryExists(), "claude_messages.json")
			if (await fileExistsAtPath(oldPath)) {
				const data = JSON.parse(await fs.readFile(oldPath, "utf8"))
				await fs.unlink(oldPath) // remove old file
				return data
			}
		}
		return []
	}

	private async addToClineMessages(message: ClineMessage) {
		this.clineMessages.push(message)
		await this.providerRef.deref()?.postStateToWebview()
		this.emit("message", { action: "created", message })
		await this.saveClineMessages()
	}

	public async overwriteClineMessages(newMessages: ClineMessage[]) {
		this.clineMessages = newMessages
		await this.saveClineMessages()
	}

	private async updateClineMessage(partialMessage: ClineMessage) {
		await this.providerRef.deref()?.postMessageToWebview({ type: "partialMessage", partialMessage })
		this.emit("message", { action: "updated", message: partialMessage })
	}

	private getTokenUsage() {
		const usage = getApiMetrics(combineApiRequests(combineCommandSequences(this.clineMessages.slice(1))))
		this.emit("taskTokenUsageUpdated", this.taskId, usage)
		return usage
	}

	private async saveClineMessages() {
		try {
			const taskDir = await this.ensureTaskDirectoryExists()
			const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
			await fs.writeFile(filePath, JSON.stringify(this.clineMessages))
			// combined as they are in ChatView
			const apiMetrics = this.getTokenUsage()
			const taskMessage = this.clineMessages[0] // first message is always the task say
			const lastRelevantMessage =
				this.clineMessages[
					findLastIndex(
						this.clineMessages,
						(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
					)
				]

			let taskDirSize = 0

			try {
				taskDirSize = await getFolderSize.loose(taskDir)
			} catch (err) {
				console.error(
					`[saveClineMessages] failed to get task directory size (${taskDir}): ${err instanceof Error ? err.message : String(err)}`,
				)
			}

			await this.providerRef.deref()?.updateTaskHistory({
				id: this.taskId,
				number: this.taskNumber,
				ts: lastRelevantMessage.ts,
				task: taskMessage.text ?? "",
				tokensIn: apiMetrics.totalTokensIn,
				tokensOut: apiMetrics.totalTokensOut,
				cacheWrites: apiMetrics.totalCacheWrites,
				cacheReads: apiMetrics.totalCacheReads,
				totalCost: apiMetrics.totalCost,
				size: taskDirSize,
			})
		} catch (error) {
			console.error("Failed to save cline messages:", error)
		}
	}

	// Communicate with webview

	// partial has three valid states true (partial message), false (completion of partial message), undefined (individual complete message)
	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
		// If this Cline instance was aborted by the provider, then the only
		// thing keeping us alive is a promise still running in the background,
		// in which case we don't want to send its result to the webview as it
		// is attached to a new instance of Cline now. So we can safely ignore
		// the result of any active promises, and this class will be
		// deallocated. (Although we set Cline = undefined in provider, that
		// simply removes the reference to this instance, but the instance is
		// still alive until this promise resolves or rejects.)
		if (this.abort) {
			throw new Error(`[Cline#ask] task ${this.taskId}.${this.instanceId} aborted`)
		}

		let askTs: number

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)
			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type
			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					// TODO: Be more efficient about saving and posting only new
					// data or one whole message at a time so ignore partial for
					// saves, and only post parts of partial message instead of
					// whole array in new listener.
					this.updateClineMessage(lastMessage)
					throw new Error("Current ask promise was ignored (#1)")
				} else {
					// This is a new partial message, so add it with partial
					// state.
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, partial })
					throw new Error("Current ask promise was ignored (#2)")
				}
			} else {
				if (isUpdatingPreviousPartial) {
					// This is the complete version of a previously partial
					// message, so replace the partial with the complete version.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined

					/*
					Bug for the history books:
					In the webview we use the ts as the chatrow key for the virtuoso list. Since we would update this ts right at the end of streaming, it would cause the view to flicker. The key prop has to be stable otherwise react has trouble reconciling items between renders, causing unmounting and remounting of components (flickering).
					The lesson here is if you see flickering when rendering lists, it's likely because the key prop is not stable.
					So in this case we must make sure that the message ts is never altered after first setting it.
					*/
					askTs = lastMessage.ts
					this.lastMessageTs = askTs
					// lastMessage.ts = askTs
					lastMessage.text = text
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					await this.saveClineMessages()
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
	
					// Removed erroneous WebSocket integration blocks from ask() method
			
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text })
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			this.askResponse = undefined
			this.askResponseText = undefined
			this.askResponseImages = undefined
			askTs = Date.now()
			this.lastMessageTs = askTs
			await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text })
		}

		await pWaitFor(() => this.askResponse !== undefined || this.lastMessageTs !== askTs, { interval: 100 })

		if (this.lastMessageTs !== askTs) {
			// Could happen if we send multiple asks in a row i.e. with
			// command_output. It's important that when we know an ask could
			// fail, it is handled gracefully.
			throw new Error("Current ask promise was ignored")
		}

		const result = { response: this.askResponse!, text: this.askResponseText, images: this.askResponseImages }
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined
		this.emit("taskAskResponded")
		return result
    }

	async handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[]) {
		this.askResponse = askResponse
		this.askResponseText = text
		this.askResponseImages = images
	} // Closing brace for handleWebviewAskResponse

/**
 * Handles responses received from external sources (like the Telegram bridge)
 * that correspond to a pending 'ask_followup_question'.
 * @param responseText The text response received externally.
 */
public handleExternalAskResponse(responseText: string): void {
  if (this.askResponse !== undefined) {
    console.warn(`[Cline ${this.taskId}] Received external response, but askResponse was already set. Ignoring.`);
    return;
  }

  console.log(`[Cline ${this.taskId}] Handling external ask response: ${responseText}`);
  // Set the internal state to mimic receiving a response, allowing the ask() promise to resolve.
  // Note: Ensure 'ok' is a valid value for ClineAskResponse or adjust accordingly.
  // If ClineAskResponse only allows specific strings like 'yesButtonClicked', etc.,
  // we might need a different approach or adjust the type. For now, using 'ok'.
  this.askResponse = "ok" as ClineAskResponse;
  this.askResponseText = responseText;
  this.askResponseImages = undefined; // No images expected from text-based bridge

  // Emit event to potentially update UI or notify listeners
  this.emit("taskAskResponded");
}


	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: ToolProgressStatus,
	): Promise<undefined> {
		if (this.abort) {
			throw new Error(`[Cline#say] task ${this.taskId}.${this.instanceId} aborted`)
		}

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)
			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type
			if (partial) {
				if (isUpdatingPreviousPartial) {
					// existing partial message, so update it
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					this.updateClineMessage(lastMessage)
				} else {
					// this is a new partial message, so add it with partial state
					const sayTs = Date.now()
					this.lastMessageTs = sayTs
					await this.addToClineMessages({ ts: sayTs, type: "say", say: type, text, images, partial })
				}
			} else {
				// New now have a complete version of a previously partial message.
				if (isUpdatingPreviousPartial) {
					// This is the complete version of a previously partial
					// message, so replace the partial with the complete version.
					this.lastMessageTs = lastMessage.ts
					// lastMessage.ts = sayTs
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					// Instead of streaming partialMessage events, we do a save
					// and post like normal to persist to disk.
					await this.saveClineMessages()
					// More performant than an entire postStateToWebview.
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					const sayTs = Date.now()
					this.lastMessageTs = sayTs
					await this.addToClineMessages({ ts: sayTs, type: "say", say: type, text, images })
				}
			}
		} else {
			// this is a new non-partial message, so add it like normal
			const sayTs = Date.now()
			this.lastMessageTs = sayTs
			await this.addToClineMessages({ ts: sayTs, type: "say", say: type, text, images, checkpoint })
		}
	}

	async sayAndCreateMissingParamError(toolName: ClineToolUseName, paramName: string, relPath?: string) {
		await this.say(
			"error",
			`Roo tried to use ${toolName}${
				relPath ? ` for '${relPath.toPosix()}'` : ""
			} without value for required parameter '${paramName}'. Retrying...`,
		)
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName))
	}

	// Task lifecycle

	private async startTask(task?: string, images?: string[]): Promise<void> {
		// conversationHistory (for API) and clineMessages (for webview) need to be in sync
		// if the extension process were killed, then on restart the clineMessages might not be empty, so we need to set it to [] when we create a new Cline client (otherwise webview would show stale messages from previous session)
		this.clineMessages = []
		this.apiConversationHistory = []
		await this.providerRef.deref()?.postStateToWebview()

		await this.say("text", task, images)
		this.isInitialized = true

		let imageBlocks: Anthropic.ImageBlockParam[] = formatResponse.imageBlocks(images)

		console.log(`[subtasks] task ${this.taskId}.${this.instanceId} starting`)

		await this.initiateTaskLoop([
			{
				type: "text",
				text: `<task>\n${task}\n</task>`,
			},
			...imageBlocks,
		])
	}

	async resumePausedTask(lastMessage?: string) {
		// release this Cline instance from paused state
		this.isPaused = false
		this.emit("taskUnpaused")

		// fake an answer from the subtask that it has completed running and this is the result of what it has done
		// add the message to the chat history and to the webview ui
		try {
			await this.say("text", `${lastMessage ?? "Please continue to the next task."}`)

			await this.addToApiConversationHistory({
				role: "user",
				content: [
					{
						type: "text",
						text: `[new_task completed] Result: ${lastMessage ?? "Please continue to the next task."}`,
					},
				],
			})
		} catch (error) {
			this.providerRef
				.deref()
				?.log(`Error failed to add reply from subtast into conversation of parent task, error: ${error}`)
			throw error
		}
	}

	private async resumeTaskFromHistory() {
		const modifiedClineMessages = await this.getSavedClineMessages()

		// Remove any resume messages that may have been added before
		const lastRelevantMessageIndex = findLastIndex(
			modifiedClineMessages,
			(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
		)
		if (lastRelevantMessageIndex !== -1) {
			modifiedClineMessages.splice(lastRelevantMessageIndex + 1)
		}

		// since we don't use api_req_finished anymore, we need to check if the last api_req_started has a cost value, if it doesn't and no cancellation reason to present, then we remove it since it indicates an api request without any partial content streamed
		const lastApiReqStartedIndex = findLastIndex(
			modifiedClineMessages,
			(m) => m.type === "say" && m.say === "api_req_started",
		)
		if (lastApiReqStartedIndex !== -1) {
			const lastApiReqStarted = modifiedClineMessages[lastApiReqStartedIndex]
			const { cost, cancelReason }: ClineApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")
			if (cost === undefined && cancelReason === undefined) {
				modifiedClineMessages.splice(lastApiReqStartedIndex, 1)
			}
		}

		await this.overwriteClineMessages(modifiedClineMessages)
		this.clineMessages = await this.getSavedClineMessages()

		// Now present the cline messages to the user and ask if they want to
		// resume (NOTE: we ran into a bug before where the
		// apiConversationHistory wouldn't be initialized when opening a old
		// task, and it was because we were waiting for resume).
		// This is important in case the user deletes messages without resuming
		// the task first.
		this.apiConversationHistory = await this.getSavedApiConversationHistory()

		const lastClineMessage = this.clineMessages
			.slice()
			.reverse()
			.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")) // could be multiple resume tasks

		let askType: ClineAsk
		if (lastClineMessage?.ask === "completion_result") {
			askType = "resume_completed_task"
		} else {
			askType = "resume_task"
		}

		this.isInitialized = true

		const { response, text, images } = await this.ask(askType) // calls poststatetowebview
		let responseText: string | undefined
		let responseImages: string[] | undefined
		if (response === "messageResponse") {
			await this.say("user_feedback", text, images)
			responseText = text
			responseImages = images
		}

		// Make sure that the api conversation history can be resumed by the API,
		// even if it goes out of sync with cline messages.
		let existingApiConversationHistory: Anthropic.Messages.MessageParam[] =
			await this.getSavedApiConversationHistory()

		// v2.0 xml tags refactor caveat: since we don't use tools anymore, we need to replace all tool use blocks with a text block since the API disallows conversations with tool uses and no tool schema
		const conversationWithoutToolBlocks = existingApiConversationHistory.map((message) => {
			if (Array.isArray(message.content)) {
				const newContent = message.content.map((block) => {
					if (block.type === "tool_use") {
						// it's important we convert to the new tool schema format so the model doesn't get confused about how to invoke tools
						const inputAsXml = Object.entries(block.input as Record<string, string>)
							.map(([key, value]) => `<${key}>\n${value}\n</${key}>`)
							.join("\n")
						return {
							type: "text",
							text: `<${block.name}>\n${inputAsXml}\n</${block.name}>`,
						} as Anthropic.Messages.TextBlockParam
					} else if (block.type === "tool_result") {
						// Convert block.content to text block array, removing images
						const contentAsTextBlocks = Array.isArray(block.content)
							? block.content.filter((item) => item.type === "text")
							: [{ type: "text", text: block.content }]
						const textContent = contentAsTextBlocks.map((item) => item.text).join("\n\n")
						const toolName = findToolName(block.tool_use_id, existingApiConversationHistory)
						return {
							type: "text",
							text: `[${toolName} Result]\n\n${textContent}`,
						} as Anthropic.Messages.TextBlockParam
					}
					return block
				})
				return { ...message, content: newContent }
			}
			return message
		})
		existingApiConversationHistory = conversationWithoutToolBlocks

		// FIXME: remove tool use blocks altogether

		// if the last message is an assistant message, we need to check if there's tool use since every tool use has to have a tool response
		// if there's no tool use and only a text block, then we can just add a user message
		// (note this isn't relevant anymore since we use custom tool prompts instead of tool use blocks, but this is here for legacy purposes in case users resume old tasks)

		// if the last message is a user message, we can need to get the assistant message before it to see if it made tool calls, and if so, fill in the remaining tool responses with 'interrupted'

		let modifiedOldUserContent: UserContent // either the last message if its user message, or the user message before the last (assistant) message
		let modifiedApiConversationHistory: Anthropic.Messages.MessageParam[] // need to remove the last user message to replace with new modified user message
		if (existingApiConversationHistory.length > 0) {
			const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]

			if (lastMessage.role === "assistant") {
				const content = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				const hasToolUse = content.some((block) => block.type === "tool_use")

				if (hasToolUse) {
					const toolUseBlocks = content.filter(
						(block) => block.type === "tool_use",
					) as Anthropic.Messages.ToolUseBlock[]
					const toolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => ({
						type: "tool_result",
						tool_use_id: block.id,
						content: "Task was interrupted before this tool call could be completed.",
					}))
					modifiedApiConversationHistory = [...existingApiConversationHistory] // no changes
					modifiedOldUserContent = [...toolResponses]
				} else {
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = []
				}
			} else if (lastMessage.role === "user") {
				const previousAssistantMessage: Anthropic.Messages.MessageParam | undefined =
					existingApiConversationHistory[existingApiConversationHistory.length - 2]

				const existingUserContent: UserContent = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				if (previousAssistantMessage && previousAssistantMessage.role === "assistant") {
					const assistantContent = Array.isArray(previousAssistantMessage.content)
						? previousAssistantMessage.content
						: [{ type: "text", text: previousAssistantMessage.content }]

					const toolUseBlocks = assistantContent.filter(
						(block) => block.type === "tool_use",
					) as Anthropic.Messages.ToolUseBlock[]

					if (toolUseBlocks.length > 0) {
						const existingToolResults = existingUserContent.filter(
							(block) => block.type === "tool_result",
						) as Anthropic.ToolResultBlockParam[]

						const missingToolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks
							.filter(
								(toolUse) => !existingToolResults.some((result) => result.tool_use_id === toolUse.id),
							)
							.map((toolUse) => ({
								type: "tool_result",
								tool_use_id: toolUse.id,
								content: "Task was interrupted before this tool call could be completed.",
							}))

						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1) // removes the last user message
						modifiedOldUserContent = [...existingUserContent, ...missingToolResponses]
					} else {
						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
						modifiedOldUserContent = [...existingUserContent]
					}
				} else {
					modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
					modifiedOldUserContent = [...existingUserContent]
				}
			} else {
				throw new Error("Unexpected: Last message is not a user or assistant message")
			}
		} else {
			throw new Error("Unexpected: No existing API conversation history")
		}

		let newUserContent: UserContent = [...modifiedOldUserContent]

		const agoText = ((): string => {
			const timestamp = lastClineMessage?.ts ?? Date.now()
			const now = Date.now()
			const diff = now - timestamp
			const minutes = Math.floor(diff / 60000)
			const hours = Math.floor(minutes / 60)
			const days = Math.floor(hours / 24)

			if (days > 0) {
				return `${days} day${days > 1 ? "s" : ""} ago`
			}
			if (hours > 0) {
				return `${hours} hour${hours > 1 ? "s" : ""} ago`
			}
			if (minutes > 0) {
				return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
			}
			return "just now"
		})()

		const wasRecent = lastClineMessage?.ts && Date.now() - lastClineMessage.ts < 30_000

		newUserContent.push({
			type: "text",
			text:
				`[TASK RESUMPTION] This task was interrupted ${agoText}. It may or may not be complete, so please reassess the task context. Be aware that the project state may have changed since then. The current working directory is now '${this.cwd.toPosix()}'. If the task has not been completed, retry the last step before interruption and proceed with completing the task.\n\nNote: If you previously attempted a tool use that the user did not provide a result for, you should assume the tool use was not successful and assess whether you should retry. If the last tool was a browser_action, the browser has been closed and you must launch a new browser if needed.${
					wasRecent
						? "\n\nIMPORTANT: If the last tool use was a write_to_file that was interrupted, the file was reverted back to its original state before the interrupted edit, and you do NOT need to re-read the file as you already have its up-to-date contents."
						: ""
				}` +
				(responseText
					? `\n\nNew instructions for task continuation:\n<user_message>\n${responseText}\n</user_message>`
					: ""),
		})

		if (responseImages && responseImages.length > 0) {
			newUserContent.push(...formatResponse.imageBlocks(responseImages))
		}

		await this.overwriteApiConversationHistory(modifiedApiConversationHistory)

		console.log(`[subtasks] task ${this.taskId}.${this.instanceId} resuming from history item`)

		await this.initiateTaskLoop(newUserContent)
	}

	private async initiateTaskLoop(userContent: UserContent): Promise<void> {
		// Kicks off the checkpoints initialization process in the background.
		this.getCheckpointService()

		let nextUserContent = userContent
		let includeFileDetails = true

		this.emit("taskStarted")

		while (!this.abort) {
			const didEndLoop = await this.recursivelyMakeClineRequests(nextUserContent, includeFileDetails)
			includeFileDetails = false // we only need file details the first time

			// The way this agentic loop works is that cline will be given a
			// task that he then calls tools to complete. Unless there's an
			// attempt_completion call, we keep responding back to him with his
			// tool's responses until he either attempt_completion or does not
			// use anymore tools. If he does not use anymore tools, we ask him
			// to consider if he's completed the task and then call
			// attempt_completion, otherwise proceed with completing the task.
			// There is a MAX_REQUESTS_PER_TASK limit to prevent infinite
			// requests, but Cline is prompted to finish the task as efficiently
			// as he can.

			if (didEndLoop) {
				// For now a task never 'completes'. This will only happen if
				// the user hits max requests and denies resetting the count.
				break
			} else {
				nextUserContent = [{ type: "text", text: formatResponse.noToolsUsed() }]
				this.consecutiveMistakeCount++
			}
		}
	}

	async abortTask(isAbandoned = false) {
		// if (this.abort) {
		// 	console.log(`[subtasks] already aborted task ${this.taskId}.${this.instanceId}`)
		// 	return
		// }

		console.log(`[subtasks] aborting task ${this.taskId}.${this.instanceId}`)

		// Will stop any autonomously running promises.
		if (isAbandoned) {
			this.abandoned = true
		}

		this.abort = true
		this.emit("taskAborted")

		// Stop waiting for child task completion.
		if (this.pauseInterval) {
			clearInterval(this.pauseInterval)
			this.pauseInterval = undefined
		}

		// Release any terminals associated with this task.
		TerminalRegistry.releaseTerminalsForTask(this.taskId)

		this.urlContentFetcher.closeBrowser()
		this.browserSession.closeBrowser()
		this.rooIgnoreController?.dispose()

		// If we're not streaming then `abortStream` (which reverts the diff
		// view changes) won't be called, so we need to revert the changes here.
		if (this.isStreaming && this.diffViewProvider.isEditing) {
			await this.diffViewProvider.revertChanges()
		}
	}

	// Tools

	async executeCommandTool(command: string, customCwd?: string): Promise<[boolean, ToolResponse]> {
		let workingDir: string
		if (!customCwd) {
			workingDir = this.cwd
		} else if (path.isAbsolute(customCwd)) {
			workingDir = customCwd
		} else {
			workingDir = path.resolve(this.cwd, customCwd)
		}

		// Check if directory exists
		try {
			await fs.access(workingDir)
		} catch (error) {
			return [false, `Working directory '${workingDir}' does not exist.`]
		}

		const terminalInfo = await TerminalRegistry.getOrCreateTerminal(workingDir, !!customCwd, this.taskId)

		// Update the working directory in case the terminal we asked for has
		// a different working directory so that the model will know where the
		// command actually executed:
		workingDir = terminalInfo.getCurrentWorkingDirectory()

		const workingDirInfo = workingDir ? ` from '${workingDir.toPosix()}'` : ""
		terminalInfo.terminal.show() // weird visual bug when creating new terminals (even manually) where there's an empty space at the top.
		const process = terminalInfo.runCommand(command)

		let userFeedback: { text?: string; images?: string[] } | undefined
		let didContinue = false
		const sendCommandOutput = async (line: string): Promise<void> => {
			try {
				const { response, text, images } = await this.ask("command_output", line)
				if (response === "yesButtonClicked") {
					// proceed while running
				} else {
					userFeedback = { text, images }
				}
				didContinue = true
				process.continue() // continue past the await
			} catch {
				// This can only happen if this ask promise was ignored, so ignore this error
			}
		}

		const { terminalOutputLineLimit } = (await this.providerRef.deref()?.getState()) ?? {}

		process.on("line", (line) => {
			if (!didContinue) {
				sendCommandOutput(Terminal.compressTerminalOutput(line, terminalOutputLineLimit))
			} else {
				this.say("command_output", Terminal.compressTerminalOutput(line, terminalOutputLineLimit))
			}
		})

		let completed = false
		let result: string = ""
		let exitDetails: ExitCodeDetails | undefined
		process.once("completed", (output?: string) => {
			// Use provided output if available, otherwise keep existing result.
			result = output ?? ""
			completed = true
		})

		process.once("shell_execution_complete", (details: ExitCodeDetails) => {
			exitDetails = details
		})

		process.once("no_shell_integration", async (message: string) => {
			await this.say("shell_integration_warning", message)
		})

		await process

		// Wait for a short delay to ensure all messages are sent to the webview
		// This delay allows time for non-awaited promises to be created and
		// for their associated messages to be sent to the webview, maintaining
		// the correct order of messages (although the webview is smart about
		// grouping command_output messages despite any gaps anyways)
		await delay(50)

		result = Terminal.compressTerminalOutput(result, terminalOutputLineLimit)

		if (userFeedback) {
			await this.say("user_feedback", userFeedback.text, userFeedback.images)
			return [
				true,
				formatResponse.toolResult(
					`Command is still running in terminal ${terminalInfo.id}${workingDirInfo}.${
						result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
					}\n\nThe user provided the following feedback:\n<feedback>\n${userFeedback.text}\n</feedback>`,
					userFeedback.images,
				),
			]
		} else if (completed) {
			let exitStatus: string = ""
			if (exitDetails !== undefined) {
				if (exitDetails.signal) {
					exitStatus = `Process terminated by signal ${exitDetails.signal} (${exitDetails.signalName})`
					if (exitDetails.coreDumpPossible) {
						exitStatus += " - core dump possible"
					}
				} else if (exitDetails.exitCode === undefined) {
					result += "<VSCE exit code is undefined: terminal output and command execution status is unknown.>"
					exitStatus = `Exit code: <undefined, notify user>`
				} else {
					if (exitDetails.exitCode !== 0) {
						exitStatus += "Command execution was not successful, inspect the cause and adjust as needed.\n"
					}
					exitStatus += `Exit code: ${exitDetails.exitCode}`
				}
			} else {
				result += "<VSCE exitDetails == undefined: terminal output and command execution status is unknown.>"
				exitStatus = `Exit code: <undefined, notify user>`
			}

			let workingDirInfo: string = workingDir ? ` within working directory '${workingDir.toPosix()}'` : ""
			const newWorkingDir = terminalInfo.getCurrentWorkingDirectory()

			if (newWorkingDir !== workingDir) {
				workingDirInfo += `; command changed working directory for this terminal to '${newWorkingDir.toPosix()} so be aware that future commands will be executed from this directory`
			}

			const outputInfo = `\nOutput:\n${result}`
			return [
				false,
				`Command executed in terminal ${terminalInfo.id}${workingDirInfo}. ${exitStatus}${outputInfo}`,
			]
		} else {
			return [
				false,
				`Command is still running in terminal ${terminalInfo.id}${workingDirInfo}.${
					result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
				}\n\nYou will be updated on the terminal status and new output in the future.`,
			]
		}
	}

	async *attemptApiRequest(previousApiReqIndex: number, retryAttempt: number = 0): ApiStream {
		let mcpHub: McpHub | undefined

		const { mcpEnabled, alwaysApproveResubmit, requestDelaySeconds, rateLimitSeconds } =
			(await this.providerRef.deref()?.getState()) ?? {}

		let rateLimitDelay = 0

		// Only apply rate limiting if this isn't the first request
		if (this.lastApiRequestTime) {
			const now = Date.now()
			const timeSinceLastRequest = now - this.lastApiRequestTime
			const rateLimit = rateLimitSeconds || 0
			rateLimitDelay = Math.ceil(Math.max(0, rateLimit * 1000 - timeSinceLastRequest) / 1000)
		}

		// Only show rate limiting message if we're not retrying. If retrying, we'll include the delay there.
		if (rateLimitDelay > 0 && retryAttempt === 0) {
			// Show countdown timer
			for (let i = rateLimitDelay; i > 0; i--) {
				const delayMessage = `Rate limiting for ${i} seconds...`
				await this.say("api_req_retry_delayed", delayMessage, undefined, true)
				await delay(1000)
			}
		}

		// Update last request time before making the request
		this.lastApiRequestTime = Date.now()

		if (mcpEnabled ?? true) {
			mcpHub = this.providerRef.deref()?.getMcpHub()
			if (!mcpHub) {
				throw new Error("MCP hub not available")
			}
			// Wait for MCP servers to be connected before generating system prompt
			await pWaitFor(() => mcpHub!.isConnecting !== true, { timeout: 10_000 }).catch(() => {
				console.error("MCP servers failed to connect in time")
			})
		}

		const rooIgnoreInstructions = this.rooIgnoreController?.getInstructions()

		const {
			browserViewportSize,
			mode,
			customModePrompts,
			experiments,
			enableMcpServerCreation,
			browserToolEnabled,
			language,
		} = (await this.providerRef.deref()?.getState()) ?? {}
		const { customModes } = (await this.providerRef.deref()?.getState()) ?? {}
		const systemPrompt = await (async () => {
			const provider = this.providerRef.deref()
			if (!provider) {
				throw new Error("Provider not available")
			}
			return SYSTEM_PROMPT(
				provider.context,
				this.cwd,
				(this.api.getModel().info.supportsComputerUse ?? false) && (browserToolEnabled ?? true),
				mcpHub,
				this.diffStrategy,
				browserViewportSize,
				mode,
				customModePrompts,
				customModes,
				this.customInstructions,
				this.diffEnabled,
				experiments,
				enableMcpServerCreation,
				language,
				rooIgnoreInstructions,
			)
		})()

		// If the previous API request's total token usage is close to the context window, truncate the conversation history to free up space for the new request
		if (previousApiReqIndex >= 0) {
			const previousRequest = this.clineMessages[previousApiReqIndex]?.text
			if (!previousRequest) return

			const {
				tokensIn = 0,
				tokensOut = 0,
				cacheWrites = 0,
				cacheReads = 0,
			}: ClineApiReqInfo = JSON.parse(previousRequest)

			const totalTokens = tokensIn + tokensOut + cacheWrites + cacheReads

			// Default max tokens value for thinking models when no specific value is set
			const DEFAULT_THINKING_MODEL_MAX_TOKENS = 16_384

			const modelInfo = this.api.getModel().info
			const maxTokens = modelInfo.thinking
				? this.apiConfiguration.modelMaxTokens || DEFAULT_THINKING_MODEL_MAX_TOKENS
				: modelInfo.maxTokens
			const contextWindow = modelInfo.contextWindow
			const trimmedMessages = await truncateConversationIfNeeded({
				messages: this.apiConversationHistory,
				totalTokens,
				maxTokens,
				contextWindow,
				apiHandler: this.api,
			})

			if (trimmedMessages !== this.apiConversationHistory) {
				await this.overwriteApiConversationHistory(trimmedMessages)
			}
		}

		// Clean conversation history by:
		// 1. Converting to Anthropic.MessageParam by spreading only the API-required properties
		// 2. Converting image blocks to text descriptions if model doesn't support images
		const cleanConversationHistory = this.apiConversationHistory.map(({ role, content }) => {
			// Handle array content (could contain image blocks)
			if (Array.isArray(content)) {
				if (!this.api.getModel().info.supportsImages) {
					// Convert image blocks to text descriptions
					content = content.map((block) => {
						if (block.type === "image") {
							// Convert image blocks to text descriptions
							// Note: We can't access the actual image content/url due to API limitations,
							// but we can indicate that an image was present in the conversation
							return {
								type: "text",
								text: "[Referenced image in conversation]",
							}
						}
						return block
					})
				}
			}
			return { role, content }
		})
		const stream = this.api.createMessage(systemPrompt, cleanConversationHistory)
		const iterator = stream[Symbol.asyncIterator]()

		try {
			// awaiting first chunk to see if it will throw an error
			this.isWaitingForFirstChunk = true
			const firstChunk = await iterator.next()
			yield firstChunk.value
			this.isWaitingForFirstChunk = false
		} catch (error) {
			// note that this api_req_failed ask is unique in that we only present this option if the api hasn't streamed any content yet (ie it fails on the first chunk due), as it would allow them to hit a retry button. However if the api failed mid-stream, it could be in any arbitrary state where some tools may have executed, so that error is handled differently and requires cancelling the task entirely.
			if (alwaysApproveResubmit) {
				let errorMsg

				if (error.error?.metadata?.raw) {
					errorMsg = JSON.stringify(error.error.metadata.raw, null, 2)
				} else if (error.message) {
					errorMsg = error.message
				} else {
					errorMsg = "Unknown error"
				}

				const baseDelay = requestDelaySeconds || 5
				const exponentialDelay = Math.ceil(baseDelay * Math.pow(2, retryAttempt))
				// Wait for the greater of the exponential delay or the rate limit delay
				const finalDelay = Math.max(exponentialDelay, rateLimitDelay)

				// Show countdown timer with exponential backoff
				for (let i = finalDelay; i > 0; i--) {
					await this.say(
						"api_req_retry_delayed",
						`${errorMsg}\n\nRetry attempt ${retryAttempt + 1}\nRetrying in ${i} seconds...`,
						undefined,
						true,
					)
					await delay(1000)
				}

				await this.say(
					"api_req_retry_delayed",
					`${errorMsg}\n\nRetry attempt ${retryAttempt + 1}\nRetrying now...`,
					undefined,
					false,
				)

				// delegate generator output from the recursive call with incremented retry count
				yield* this.attemptApiRequest(previousApiReqIndex, retryAttempt + 1)
				return
			} else {
				const { response } = await this.ask(
					"api_req_failed",
					error.message ?? JSON.stringify(serializeError(error), null, 2),
				)
				if (response !== "yesButtonClicked") {
					// this will never happen since if noButtonClicked, we will clear current task, aborting this instance
					throw new Error("API request failed")
				}
				await this.say("api_req_retried")
				// delegate generator output from the recursive call
				yield* this.attemptApiRequest(previousApiReqIndex)
				return
			}
		}

		// no error, so we can continue to yield all remaining chunks
		// (needs to be placed outside of try/catch since it we want caller to handle errors not with api_req_failed as that is reserved for first chunk failures only)
		// this delegates to another generator or iterable object. In this case, it's saying "yield all remaining values from this iterator". This effectively passes along all subsequent chunks from the original stream.
		yield* iterator
	}

	async presentAssistantMessage() {
		if (this.abort) {
			throw new Error(`[Cline#presentAssistantMessage] task ${this.taskId}.${this.instanceId} aborted`)
		}

		if (this.presentAssistantMessageLocked) {
			this.presentAssistantMessageHasPendingUpdates = true
			return
		}
		this.presentAssistantMessageLocked = true
		this.presentAssistantMessageHasPendingUpdates = false

		if (this.currentStreamingContentIndex >= this.assistantMessageContent.length) {
			// this may happen if the last content block was completed before streaming could finish. if streaming is finished, and we're out of bounds then this means we already presented/executed the last content block and are ready to continue to next request
			if (this.didCompleteReadingStream) {
				this.userMessageContentReady = true
			}
			// console.log("no more content blocks to stream! this shouldn't happen?")
			this.presentAssistantMessageLocked = false
			return
			//throw new Error("No more content blocks to stream! This shouldn't happen...") // remove and just return after testing
		}

		const block = cloneDeep(this.assistantMessageContent[this.currentStreamingContentIndex]) // need to create copy bc while stream is updating the array, it could be updating the reference block properties too

		let isCheckpointPossible = false

		switch (block.type) {
			case "text": {
				if (this.didRejectTool || this.didAlreadyUseTool) {
					break
				}
				let content = block.content
				if (content) {
					// (have to do this for partial and complete since sending content in thinking tags to markdown renderer will automatically be removed)
					// Remove end substrings of <thinking or </thinking (below xml parsing is only for opening tags)
					// (this is done with the xml parsing below now, but keeping here for reference)
					// content = content.replace(/<\/?t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?$/, "")
					// Remove all instances of <thinking> (with optional line break after) and </thinking> (with optional line break before)
					// - Needs to be separate since we dont want to remove the line break before the first tag
					// - Needs to happen before the xml parsing below
					content = content.replace(/<thinking>\s?/g, "")
					content = content.replace(/\s?<\/thinking>/g, "")

					// Remove partial XML tag at the very end of the content (for tool use and thinking tags)
					// (prevents scrollview from jumping when tags are automatically removed)
					const lastOpenBracketIndex = content.lastIndexOf("<")
					if (lastOpenBracketIndex !== -1) {
						const possibleTag = content.slice(lastOpenBracketIndex)
						// Check if there's a '>' after the last '<' (i.e., if the tag is complete) (complete thinking and tool tags will have been removed by now)
						const hasCloseBracket = possibleTag.includes(">")
						if (!hasCloseBracket) {
							// Extract the potential tag name
							let tagContent: string
							if (possibleTag.startsWith("</")) {
								tagContent = possibleTag.slice(2).trim()
							} else {
								tagContent = possibleTag.slice(1).trim()
							}
							// Check if tagContent is likely an incomplete tag name (letters and underscores only)
							const isLikelyTagName = /^[a-zA-Z_]+$/.test(tagContent)
							// Preemptively remove < or </ to keep from these artifacts showing up in chat (also handles closing thinking tags)
							const isOpeningOrClosing = possibleTag === "<" || possibleTag === "</"
							// If the tag is incomplete and at the end, remove it from the content
							if (isOpeningOrClosing || isLikelyTagName) {
								content = content.slice(0, lastOpenBracketIndex).trim()
							}
						}
					}
				}
				await this.say("text", content, undefined, block.partial)
				break
			}
			case "tool_use":
				const toolDescription = (): string => {
					switch (block.name) {
						case "execute_command":
							return `[${block.name} for '${block.params.command}']`
						case "read_file":
							return `[${block.name} for '${block.params.path}']`
						case "fetch_instructions":
							return `[${block.name} for '${block.params.task}']`
						case "write_to_file":
							return `[${block.name} for '${block.params.path}']`
						case "apply_diff":
							return `[${block.name} for '${block.params.path}']`
						case "search_files":
							return `[${block.name} for '${block.params.regex}'${
								block.params.file_pattern ? ` in '${block.params.file_pattern}'` : ""
							}]`
						case "insert_content":
							return `[${block.name} for '${block.params.path}']`
						case "search_and_replace":
							return `[${block.name} for '${block.params.path}']`
						case "list_files":
							return `[${block.name} for '${block.params.path}']`
						case "list_code_definition_names":
							return `[${block.name} for '${block.params.path}']`
						case "browser_action":
							return `[${block.name} for '${block.params.action}']`
						case "use_mcp_tool":
							return `[${block.name} for '${block.params.server_name}']`
						case "access_mcp_resource":
							return `[${block.name} for '${block.params.server_name}']`
						case "ask_followup_question":
							return `[${block.name} for '${block.params.question}']`
						case "attempt_completion":
							return `[${block.name}]`
						case "switch_mode":
							return `[${block.name} to '${block.params.mode_slug}'${block.params.reason ? ` because: ${block.params.reason}` : ""}]`
						case "new_task": {
							const mode = block.params.mode ?? defaultModeSlug
							const message = block.params.message ?? "(no message)"
							const modeName = getModeBySlug(mode, customModes)?.name ?? mode
							return `[${block.name} in ${modeName} mode: '${message}']`
						}
					}
				}

				if (this.didRejectTool) {
					// ignore any tool content after user has rejected tool once
					if (!block.partial) {
						this.userMessageContent.push({
							type: "text",
							text: `Skipping tool ${toolDescription()} due to user rejecting a previous tool.`,
						})
					} else {
						// partial tool after user rejected a previous tool
						this.userMessageContent.push({
							type: "text",
							text: `Tool ${toolDescription()} was interrupted and not executed due to user rejecting a previous tool.`,
						})
					}
					break
				}

				if (this.didAlreadyUseTool) {
					// ignore any content after a tool has already been used
					this.userMessageContent.push({
						type: "text",
						text: `Tool [${block.name}] was not executed because a tool has already been used in this message. Only one tool may be used per message. You must assess the first tool's result before proceeding to use the next tool.`,
					})
					break
				}

				const pushToolResult = (content: ToolResponse) => {
					this.userMessageContent.push({
						type: "text",
						text: `${toolDescription()} Result:`,
					})
					if (typeof content === "string") {
						this.userMessageContent.push({
							type: "text",
							text: content || "(tool did not return anything)",
						})
					} else {
						this.userMessageContent.push(...content)
					}
					// once a tool result has been collected, ignore all other tool uses since we should only ever present one tool result per message
					this.didAlreadyUseTool = true

					// Flag a checkpoint as possible since we've used a tool
					// which may have changed the file system.
					isCheckpointPossible = true
				}

				const askApproval = async (
					type: ClineAsk,
					partialMessage?: string,
					progressStatus?: ToolProgressStatus,
				) => {
					const { response, text, images } = await this.ask(type, partialMessage, false, progressStatus)
					if (response !== "yesButtonClicked") {
						// Handle both messageResponse and noButtonClicked with text
						if (text) {
							await this.say("user_feedback", text, images)
							pushToolResult(
								formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images),
							)
						} else {
							pushToolResult(formatResponse.toolDenied())
						}
						this.didRejectTool = true
						return false
					}
					// Handle yesButtonClicked with text
					if (text) {
						await this.say("user_feedback", text, images)
						pushToolResult(formatResponse.toolResult(formatResponse.toolApprovedWithFeedback(text), images))
					}
					return true
				}

				const askFinishSubTaskApproval = async () => {
					// ask the user to approve this task has completed, and he has reviewd it, and we can declare task is finished
					// and return control to the parent task to continue running the rest of the sub-tasks
					const toolMessage = JSON.stringify({
						tool: "finishTask",
						content:
							"Subtask completed! You can review the results and suggest any corrections or next steps. If everything looks good, confirm to return the result to the parent task.",
					})

					return await askApproval("tool", toolMessage)
				}

				const handleError = async (action: string, error: Error) => {
					const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`
					await this.say(
						"error",
						`Error ${action}:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`,
					)
					// this.toolResults.push({
					// 	type: "tool_result",
					// 	tool_use_id: toolUseId,
					// 	content: await this.formatToolError(errorString),
					// })
					pushToolResult(formatResponse.toolError(errorString))
				}

				// If block is partial, remove partial closing tag so its not presented to user
				const removeClosingTag = (tag: ToolParamName, text?: string) => {
					if (!block.partial) {
						return text || ""
					}
					if (!text) {
						return ""
					}
					// This regex dynamically constructs a pattern to match the closing tag:
					// - Optionally matches whitespace before the tag
					// - Matches '<' or '</' optionally followed by any subset of characters from the tag name
					const tagRegex = new RegExp(
						`\\s?<\/?${tag
							.split("")
							.map((char) => `(?:${char})?`)
							.join("")}$`,
						"g",
					)
					return text.replace(tagRegex, "")
				}

				if (block.name !== "browser_action") {
					await this.browserSession.closeBrowser()
				}

				if (!block.partial) {
					telemetryService.captureToolUsage(this.taskId, block.name)
				}

				// Validate tool use before execution
				const { mode, customModes } = (await this.providerRef.deref()?.getState()) ?? {}
				try {
					validateToolUse(
						block.name as ToolName,
						mode ?? defaultModeSlug,
						customModes ?? [],
						{
							apply_diff: this.diffEnabled,
						},
						block.params,
					)
				} catch (error) {
					this.consecutiveMistakeCount++
					pushToolResult(formatResponse.toolError(error.message))
					break
				}

				switch (block.name) {
					case "write_to_file": {
						const relPath: string | undefined = block.params.path
						let newContent: string | undefined = block.params.content
						let predictedLineCount: number | undefined = parseInt(block.params.line_count ?? "0")
						if (!relPath || !newContent) {
							// checking for newContent ensure relPath is complete
							// wait so we can determine if it's a new file or editing an existing file
							break
						}

						const accessAllowed = this.rooIgnoreController?.validateAccess(relPath)
						if (!accessAllowed) {
							await this.say("rooignore_error", relPath)
							pushToolResult(formatResponse.toolError(formatResponse.rooIgnoreError(relPath)))

							break
						}

						// Check if file exists using cached map or fs.access
						let fileExists: boolean
						if (this.diffViewProvider.editType !== undefined) {
							fileExists = this.diffViewProvider.editType === "modify"
						} else {
							const absolutePath = path.resolve(this.cwd, relPath)
							fileExists = await fileExistsAtPath(absolutePath)
							this.diffViewProvider.editType = fileExists ? "modify" : "create"
						}

						// pre-processing newContent for cases where weaker models might add artifacts like markdown codeblock markers (deepseek/llama) or extra escape characters (gemini)
						if (newContent.startsWith("```")) {
							// this handles cases where it includes language specifiers like ```python ```js
							newContent = newContent.split("\n").slice(1).join("\n").trim()
						}
						if (newContent.endsWith("```")) {
							newContent = newContent.split("\n").slice(0, -1).join("\n").trim()
						}

						if (!this.api.getModel().id.includes("claude")) {
							// it seems not just llama models are doing this, but also gemini and potentially others
							if (
								newContent.includes("&gt;") ||
								newContent.includes("&lt;") ||
								newContent.includes("&quot;")
							) {
								newContent = newContent
									.replace(/&gt;/g, ">")
									.replace(/&lt;/g, "<")
									.replace(/&quot;/g, '"')
							}
						}

						// Determine if the path is outside the workspace
						const fullPath = relPath ? path.resolve(this.cwd, removeClosingTag("path", relPath)) : ""
						const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)

						const sharedMessageProps: ClineSayTool = {
							tool: fileExists ? "editedExistingFile" : "newFileCreated",
							path: getReadablePath(this.cwd, removeClosingTag("path", relPath)),
							isOutsideWorkspace,
						}
						try {
							if (block.partial) {
								// update gui message
								const partialMessage = JSON.stringify(sharedMessageProps)
								await this.ask("tool", partialMessage, block.partial).catch(() => {})
								// update editor
								if (!this.diffViewProvider.isEditing) {
									// open the editor and prepare to stream content in
									await this.diffViewProvider.open(relPath)
								}
								// editor is open, stream content in
								await this.diffViewProvider.update(
									everyLineHasLineNumbers(newContent) ? stripLineNumbers(newContent) : newContent,
									false,
								)
								break
							} else {
								if (!relPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("write_to_file", "path"))
									await this.diffViewProvider.reset()
									break
								}
								if (!newContent) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("write_to_file", "content"))
									await this.diffViewProvider.reset()
									break
								}
								if (!predictedLineCount) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("write_to_file", "line_count"),
									)
									await this.diffViewProvider.reset()
									break
								}
								this.consecutiveMistakeCount = 0

								// if isEditingFile false, that means we have the full contents of the file already.
								// it's important to note how this function works, you can't make the assumption that the block.partial conditional will always be called since it may immediately get complete, non-partial data. So this part of the logic will always be called.
								// in other words, you must always repeat the block.partial logic here
								if (!this.diffViewProvider.isEditing) {
									// show gui message before showing edit animation
									const partialMessage = JSON.stringify(sharedMessageProps)
									await this.ask("tool", partialMessage, true).catch(() => {}) // sending true for partial even though it's not a partial, this shows the edit row before the content is streamed into the editor
									await this.diffViewProvider.open(relPath)
								}
								await this.diffViewProvider.update(
									everyLineHasLineNumbers(newContent) ? stripLineNumbers(newContent) : newContent,
									true,
								)
								await delay(300) // wait for diff view to update
								this.diffViewProvider.scrollToFirstDiff()

								// Check for code omissions before proceeding
								if (
									detectCodeOmission(
										this.diffViewProvider.originalContent || "",
										newContent,
										predictedLineCount,
									)
								) {
									if (this.diffStrategy) {
										await this.diffViewProvider.revertChanges()
										pushToolResult(
											formatResponse.toolError(
												`Content appears to be truncated (file has ${
													newContent.split("\n").length
												} lines but was predicted to have ${predictedLineCount} lines), and found comments indicating omitted code (e.g., '// rest of code unchanged', '/* previous code */'). Please provide the complete file content without any omissions if possible, or otherwise use the 'apply_diff' tool to apply the diff to the original file.`,
											),
										)
										break
									} else {
										vscode.window
											.showWarningMessage(
												"Potential code truncation detected. This happens when the AI reaches its max output limit.",
												"Follow this guide to fix the issue",
											)
											.then((selection) => {
												if (selection === "Follow this guide to fix the issue") {
													vscode.env.openExternal(
														vscode.Uri.parse(
															"https://github.com/cline/cline/wiki/Troubleshooting-%E2%80%90-Cline-Deleting-Code-with-%22Rest-of-Code-Here%22-Comments",
														),
													)
												}
											})
									}
								}

								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: fileExists ? undefined : newContent,
									diff: fileExists
										? formatResponse.createPrettyPatch(
												relPath,
												this.diffViewProvider.originalContent,
												newContent,
											)
										: undefined,
								} satisfies ClineSayTool)
								const didApprove = await askApproval("tool", completeMessage)
								if (!didApprove) {
									await this.diffViewProvider.revertChanges()
									break
								}
								const { newProblemsMessage, userEdits, finalContent } =
									await this.diffViewProvider.saveChanges()
								this.didEditFile = true // used to determine if we should wait for busy terminal to update before sending api request
								if (userEdits) {
									await this.say(
										"user_feedback_diff",
										JSON.stringify({
											tool: fileExists ? "editedExistingFile" : "newFileCreated",
											path: getReadablePath(this.cwd, relPath),
											diff: userEdits,
										} satisfies ClineSayTool),
									)
									pushToolResult(
										`The user made the following updates to your content:\n\n${userEdits}\n\n` +
											`The updated content, which includes both your original modifications and the user's edits, has been successfully saved to ${relPath.toPosix()}. Here is the full, updated content of the file, including line numbers:\n\n` +
											`<final_file_content path="${relPath.toPosix()}">\n${addLineNumbers(
												finalContent || "",
											)}\n</final_file_content>\n\n` +
											`Please note:\n` +
											`1. You do not need to re-write the file with these changes, as they have already been applied.\n` +
											`2. Proceed with the task using this updated file content as the new baseline.\n` +
											`3. If the user's edits have addressed part of the task or changed the requirements, adjust your approach accordingly.` +
											`${newProblemsMessage}`,
									)
								} else {
									pushToolResult(
										`The content was successfully saved to ${relPath.toPosix()}.${newProblemsMessage}`,
									)
								}
								await this.diffViewProvider.reset()
								break
							}
						} catch (error) {
							await handleError("writing file", error)
							await this.diffViewProvider.reset()
							break
						}
					}
					case "apply_diff": {
						const relPath: string | undefined = block.params.path
						const diffContent: string | undefined = block.params.diff

						const sharedMessageProps: ClineSayTool = {
							tool: "appliedDiff",
							path: getReadablePath(this.cwd, removeClosingTag("path", relPath)),
						}

						try {
							if (block.partial) {
								// update gui message
								let toolProgressStatus
								if (this.diffStrategy && this.diffStrategy.getProgressStatus) {
									toolProgressStatus = this.diffStrategy.getProgressStatus(block)
								}

								const partialMessage = JSON.stringify(sharedMessageProps)

								await this.ask("tool", partialMessage, block.partial, toolProgressStatus).catch(
									() => {},
								)
								break
							} else {
								if (!relPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("apply_diff", "path"))
									break
								}
								if (!diffContent) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("apply_diff", "diff"))
									break
								}

								const accessAllowed = this.rooIgnoreController?.validateAccess(relPath)
								if (!accessAllowed) {
									await this.say("rooignore_error", relPath)
									pushToolResult(formatResponse.toolError(formatResponse.rooIgnoreError(relPath)))

									break
								}

								const absolutePath = path.resolve(this.cwd, relPath)
								const fileExists = await fileExistsAtPath(absolutePath)

								if (!fileExists) {
									this.consecutiveMistakeCount++
									const formattedError = `File does not exist at path: ${absolutePath}\n\n<error_details>\nThe specified file could not be found. Please verify the file path and try again.\n</error_details>`
									await this.say("error", formattedError)
									pushToolResult(formattedError)
									break
								}

								const originalContent = await fs.readFile(absolutePath, "utf-8")

								// Apply the diff to the original content
								const diffResult = (await this.diffStrategy?.applyDiff(
									originalContent,
									diffContent,
									parseInt(block.params.start_line ?? ""),
									parseInt(block.params.end_line ?? ""),
								)) ?? {
									success: false,
									error: "No diff strategy available",
								}
								let partResults = ""

								if (!diffResult.success) {
									this.consecutiveMistakeCount++
									const currentCount =
										(this.consecutiveMistakeCountForApplyDiff.get(relPath) || 0) + 1
									this.consecutiveMistakeCountForApplyDiff.set(relPath, currentCount)
									let formattedError = ""
									if (diffResult.failParts && diffResult.failParts.length > 0) {
										for (const failPart of diffResult.failParts) {
											if (failPart.success) {
												continue
											}
											const errorDetails = failPart.details
												? JSON.stringify(failPart.details, null, 2)
												: ""
											formattedError = `<error_details>\n${
												failPart.error
											}${errorDetails ? `\n\nDetails:\n${errorDetails}` : ""}\n</error_details>`
											partResults += formattedError
										}
									} else {
										const errorDetails = diffResult.details
											? JSON.stringify(diffResult.details, null, 2)
											: ""
										formattedError = `Unable to apply diff to file: ${absolutePath}\n\n<error_details>\n${
											diffResult.error
										}${errorDetails ? `\n\nDetails:\n${errorDetails}` : ""}\n</error_details>`
									}

									if (currentCount >= 2) {
										await this.say("error", formattedError)
									}
									pushToolResult(formattedError)
									break
								}

								this.consecutiveMistakeCount = 0
								this.consecutiveMistakeCountForApplyDiff.delete(relPath)
								// Show diff view before asking for approval
								this.diffViewProvider.editType = "modify"
								await this.diffViewProvider.open(relPath)
								await this.diffViewProvider.update(diffResult.content, true)
								await this.diffViewProvider.scrollToFirstDiff()

								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									diff: diffContent,
								} satisfies ClineSayTool)

								let toolProgressStatus
								if (this.diffStrategy && this.diffStrategy.getProgressStatus) {
									toolProgressStatus = this.diffStrategy.getProgressStatus(block, diffResult)
								}

								const didApprove = await askApproval("tool", completeMessage, toolProgressStatus)
								if (!didApprove) {
									await this.diffViewProvider.revertChanges() // This likely handles closing the diff view
									break
								}

								const { newProblemsMessage, userEdits, finalContent } =
									await this.diffViewProvider.saveChanges()
								this.didEditFile = true // used to determine if we should wait for busy terminal to update before sending api request
								let partFailHint = ""
								if (diffResult.failParts && diffResult.failParts.length > 0) {
									partFailHint = `But unable to apply all diff parts to file: ${absolutePath}, silently use <read_file> tool to check newest file version and re-apply diffs\n`
								}
								if (userEdits) {
									await this.say(
										"user_feedback_diff",
										JSON.stringify({
											tool: fileExists ? "editedExistingFile" : "newFileCreated",
											path: getReadablePath(this.cwd, relPath),
											diff: userEdits,
										} satisfies ClineSayTool),
									)
									pushToolResult(
										`The user made the following updates to your content:\n\n${userEdits}\n\n` +
											partFailHint +
											`The updated content, which includes both your original modifications and the user's edits, has been successfully saved to ${relPath.toPosix()}. Here is the full, updated content of the file, including line numbers:\n\n` +
											`<final_file_content path="${relPath.toPosix()}">\n${addLineNumbers(
												finalContent || "",
											)}\n</final_file_content>\n\n` +
											`Please note:\n` +
											`1. You do not need to re-write the file with these changes, as they have already been applied.\n` +
											`2. Proceed with the task using this updated file content as the new baseline.\n` +
											`3. If the user's edits have addressed part of the task or changed the requirements, adjust your approach accordingly.` +
											`${newProblemsMessage}`,
									)
								} else {
									pushToolResult(
										`Changes successfully applied to ${relPath.toPosix()}:\n\n${newProblemsMessage}\n` +
											partFailHint,
									)
								}
								await this.diffViewProvider.reset()
								break
							}
						} catch (error) {
							await handleError("applying diff", error)
							await this.diffViewProvider.reset()
							break
						}
					}

					case "insert_content": {
						const relPath: string | undefined = block.params.path
						const operations: string | undefined = block.params.operations

						const sharedMessageProps: ClineSayTool = {
							tool: "appliedDiff",
							path: getReadablePath(this.cwd, removeClosingTag("path", relPath)),
						}

						try {
							if (block.partial) {
								const partialMessage = JSON.stringify(sharedMessageProps)
								await this.ask("tool", partialMessage, block.partial).catch(() => {})
								break
							}

							// Validate required parameters
							if (!relPath) {
								this.consecutiveMistakeCount++
								pushToolResult(await this.sayAndCreateMissingParamError("insert_content", "path"))
								break
							}

							if (!operations) {
								this.consecutiveMistakeCount++
								pushToolResult(await this.sayAndCreateMissingParamError("insert_content", "operations"))
								break
							}

							const absolutePath = path.resolve(this.cwd, relPath)
							const fileExists = await fileExistsAtPath(absolutePath)

							if (!fileExists) {
								this.consecutiveMistakeCount++
								const formattedError = `File does not exist at path: ${absolutePath}\n\n<error_details>\nThe specified file could not be found. Please verify the file path and try again.\n</error_details>`
								await this.say("error", formattedError)
								pushToolResult(formattedError)
								break
							}

							let parsedOperations: Array<{
								start_line: number
								content: string
							}>

							try {
								parsedOperations = JSON.parse(operations)
								if (!Array.isArray(parsedOperations)) {
									throw new Error("Operations must be an array")
								}
							} catch (error) {
								this.consecutiveMistakeCount++
								await this.say("error", `Failed to parse operations JSON: ${error.message}`)
								pushToolResult(formatResponse.toolError("Invalid operations JSON format"))
								break
							}

							this.consecutiveMistakeCount = 0

							// Read the file
							const fileContent = await fs.readFile(absolutePath, "utf8")
							this.diffViewProvider.editType = "modify"
							this.diffViewProvider.originalContent = fileContent
							const lines = fileContent.split("\n")

							const updatedContent = insertGroups(
								lines,
								parsedOperations.map((elem) => {
									return {
										index: elem.start_line - 1,
										elements: elem.content.split("\n"),
									}
								}),
							).join("\n")

							// Show changes in diff view
							if (!this.diffViewProvider.isEditing) {
								await this.ask("tool", JSON.stringify(sharedMessageProps), true).catch(() => {})
								// First open with original content
								await this.diffViewProvider.open(relPath)
								await this.diffViewProvider.update(fileContent, false)
								this.diffViewProvider.scrollToFirstDiff()
								await delay(200)
							}

							const diff = formatResponse.createPrettyPatch(relPath, fileContent, updatedContent)

							if (!diff) {
								pushToolResult(`No changes needed for '${relPath}'`)
								break
							}

							await this.diffViewProvider.update(updatedContent, true)

							const completeMessage = JSON.stringify({
								...sharedMessageProps,
								diff,
							} satisfies ClineSayTool)

							const didApprove = await this.ask("tool", completeMessage, false).then(
								(response) => response.response === "yesButtonClicked",
							)

							if (!didApprove) {
								await this.diffViewProvider.revertChanges()
								pushToolResult("Changes were rejected by the user.")
								break
							}

							const { newProblemsMessage, userEdits, finalContent } =
								await this.diffViewProvider.saveChanges()
							this.didEditFile = true

							if (!userEdits) {
								pushToolResult(
									`The content was successfully inserted in ${relPath.toPosix()}.${newProblemsMessage}`,
								)
								await this.diffViewProvider.reset()
								break
							}

							const userFeedbackDiff = JSON.stringify({
								tool: "appliedDiff",
								path: getReadablePath(this.cwd, relPath),
								diff: userEdits,
							} satisfies ClineSayTool)

							console.debug("[DEBUG] User made edits, sending feedback diff:", userFeedbackDiff)
							await this.say("user_feedback_diff", userFeedbackDiff)
							pushToolResult(
								`The user made the following updates to your content:\n\n${userEdits}\n\n` +
									`The updated content, which includes both your original modifications and the user's edits, has been successfully saved to ${relPath.toPosix()}. Here is the full, updated content of the file:\n\n` +
									`<final_file_content path="${relPath.toPosix()}">\n${finalContent}\n</final_file_content>\n\n` +
									`Please note:\n` +
									`1. You do not need to re-write the file with these changes, as they have already been applied.\n` +
									`2. Proceed with the task using this updated file content as the new baseline.\n` +
									`3. If the user's edits have addressed part of the task or changed the requirements, adjust your approach accordingly.` +
									`${newProblemsMessage}`,
							)
							await this.diffViewProvider.reset()
						} catch (error) {
							handleError("insert content", error)
							await this.diffViewProvider.reset()
						}
						break
					}

					case "search_and_replace": {
						const relPath: string | undefined = block.params.path
						const operations: string | undefined = block.params.operations

						const sharedMessageProps: ClineSayTool = {
							tool: "appliedDiff",
							path: getReadablePath(this.cwd, removeClosingTag("path", relPath)),
						}

						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									path: removeClosingTag("path", relPath),
									operations: removeClosingTag("operations", operations),
								})
								await this.ask("tool", partialMessage, block.partial).catch(() => {})
								break
							} else {
								if (!relPath) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("search_and_replace", "path"),
									)
									break
								}
								if (!operations) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("search_and_replace", "operations"),
									)
									break
								}

								const absolutePath = path.resolve(this.cwd, relPath)
								const fileExists = await fileExistsAtPath(absolutePath)

								if (!fileExists) {
									this.consecutiveMistakeCount++
									const formattedError = `File does not exist at path: ${absolutePath}\n\n<error_details>\nThe specified file could not be found. Please verify the file path and try again.\n</error_details>`
									await this.say("error", formattedError)
									pushToolResult(formattedError)
									break
								}

								let parsedOperations: Array<{
									search: string
									replace: string
									start_line?: number
									end_line?: number
									use_regex?: boolean
									ignore_case?: boolean
									regex_flags?: string
								}>

								try {
									parsedOperations = JSON.parse(operations)
									if (!Array.isArray(parsedOperations)) {
										throw new Error("Operations must be an array")
									}
								} catch (error) {
									this.consecutiveMistakeCount++
									await this.say("error", `Failed to parse operations JSON: ${error.message}`)
									pushToolResult(formatResponse.toolError("Invalid operations JSON format"))
									break
								}

								// Read the original file content
								const fileContent = await fs.readFile(absolutePath, "utf-8")
								this.diffViewProvider.editType = "modify"
								this.diffViewProvider.originalContent = fileContent
								let lines = fileContent.split("\n")

								for (const op of parsedOperations) {
									const flags = op.regex_flags ?? (op.ignore_case ? "gi" : "g")
									const multilineFlags = flags.includes("m") ? flags : flags + "m"

									const searchPattern = op.use_regex
										? new RegExp(op.search, multilineFlags)
										: new RegExp(escapeRegExp(op.search), multilineFlags)

									if (op.start_line || op.end_line) {
										const startLine = Math.max((op.start_line ?? 1) - 1, 0)
										const endLine = Math.min((op.end_line ?? lines.length) - 1, lines.length - 1)

										// Get the content before and after the target section
										const beforeLines = lines.slice(0, startLine)
										const afterLines = lines.slice(endLine + 1)

										// Get the target section and perform replacement
										const targetContent = lines.slice(startLine, endLine + 1).join("\n")
										const modifiedContent = targetContent.replace(searchPattern, op.replace)
										const modifiedLines = modifiedContent.split("\n")

										// Reconstruct the full content with the modified section
										lines = [...beforeLines, ...modifiedLines, ...afterLines]
									} else {
										// Global replacement
										const fullContent = lines.join("\n")
										const modifiedContent = fullContent.replace(searchPattern, op.replace)
										lines = modifiedContent.split("\n")
									}
								}

								const newContent = lines.join("\n")

								this.consecutiveMistakeCount = 0

								// Show diff preview
								const diff = formatResponse.createPrettyPatch(relPath, fileContent, newContent)

								if (!diff) {
									pushToolResult(`No changes needed for '${relPath}'`)
									break
								}

								await this.diffViewProvider.open(relPath)
								await this.diffViewProvider.update(newContent, true)
								this.diffViewProvider.scrollToFirstDiff()

								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									diff: diff,
								} satisfies ClineSayTool)

								const didApprove = await askApproval("tool", completeMessage)
								if (!didApprove) {
									await this.diffViewProvider.revertChanges() // This likely handles closing the diff view
									break
								}

								const { newProblemsMessage, userEdits, finalContent } =
									await this.diffViewProvider.saveChanges()
								this.didEditFile = true // used to determine if we should wait for busy terminal to update before sending api request
								if (userEdits) {
									await this.say(
										"user_feedback_diff",
										JSON.stringify({
											tool: fileExists ? "editedExistingFile" : "newFileCreated",
											path: getReadablePath(this.cwd, relPath),
											diff: userEdits,
										} satisfies ClineSayTool),
									)
									pushToolResult(
										`The user made the following updates to your content:\n\n${userEdits}\n\n` +
											`The updated content, which includes both your original modifications and the user's edits, has been successfully saved to ${relPath.toPosix()}. Here is the full, updated content of the file, including line numbers:\n\n` +
											`<final_file_content path="${relPath.toPosix()}">\n${addLineNumbers(finalContent || "")}\n</final_file_content>\n\n` +
											`Please note:\n` +
											`1. You do not need to re-write the file with these changes, as they have already been applied.\n` +
											`2. Proceed with the task using this updated file content as the new baseline.\n` +
											`3. If the user's edits have addressed part of the task or changed the requirements, adjust your approach accordingly.` +
											`${newProblemsMessage}`,
									)
								} else {
									pushToolResult(
										`Changes successfully applied to ${relPath.toPosix()}:\n\n${newProblemsMessage}`,
									)
								}
								await this.diffViewProvider.reset()
								break
							}
						} catch (error) {
							await handleError("applying search and replace", error)
							await this.diffViewProvider.reset()
							break
						}
					}

					case "read_file": {
						const relPath: string | undefined = block.params.path
						const startLineStr: string | undefined = block.params.start_line
						const endLineStr: string | undefined = block.params.end_line

						// Get the full path and determine if it's outside the workspace
						const fullPath = relPath ? path.resolve(this.cwd, removeClosingTag("path", relPath)) : ""
						const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)

						const sharedMessageProps: ClineSayTool = {
							tool: "readFile",
							path: getReadablePath(this.cwd, removeClosingTag("path", relPath)),
							isOutsideWorkspace,
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: undefined,
								} satisfies ClineSayTool)
								await this.ask("tool", partialMessage, block.partial).catch(() => {})
								break
							} else {
								if (!relPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("read_file", "path"))
									break
								}

								// Check if we're doing a line range read
								let isRangeRead = false
								let startLine: number | undefined = undefined
								let endLine: number | undefined = undefined

								// Check if we have either range parameter
								if (startLineStr || endLineStr) {
									isRangeRead = true
								}

								// Parse start_line if provided
								if (startLineStr) {
									startLine = parseInt(startLineStr)
									if (isNaN(startLine)) {
										// Invalid start_line
										this.consecutiveMistakeCount++
										await this.say("error", `Failed to parse start_line: ${startLineStr}`)
										pushToolResult(formatResponse.toolError("Invalid start_line value"))
										break
									}
									startLine -= 1 // Convert to 0-based index
								}

								// Parse end_line if provided
								if (endLineStr) {
									endLine = parseInt(endLineStr)

									if (isNaN(endLine)) {
										// Invalid end_line
										this.consecutiveMistakeCount++
										await this.say("error", `Failed to parse end_line: ${endLineStr}`)
										pushToolResult(formatResponse.toolError("Invalid end_line value"))
										break
									}

									// Convert to 0-based index
									endLine -= 1
								}

								const accessAllowed = this.rooIgnoreController?.validateAccess(relPath)
								if (!accessAllowed) {
									await this.say("rooignore_error", relPath)
									pushToolResult(formatResponse.toolError(formatResponse.rooIgnoreError(relPath)))

									break
								}

								this.consecutiveMistakeCount = 0
								const absolutePath = path.resolve(this.cwd, relPath)
								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: absolutePath,
								} satisfies ClineSayTool)

								const didApprove = await askApproval("tool", completeMessage)
								if (!didApprove) {
									break
								}

								// Get the maxReadFileLine setting
								const { maxReadFileLine } = (await this.providerRef.deref()?.getState()) ?? {}

								// Count total lines in the file
								let totalLines = 0
								try {
									totalLines = await countFileLines(absolutePath)
								} catch (error) {
									console.error(`Error counting lines in file ${absolutePath}:`, error)
								}

								// now execute the tool like normal
								let content: string
								let isFileTruncated = false
								let sourceCodeDef = ""

								const isBinary = await isBinaryFile(absolutePath).catch(() => false)
								const autoTruncate = block.params.auto_truncate === "true"

								if (isRangeRead) {
									if (startLine === undefined) {
										content = addLineNumbers(await readLines(absolutePath, endLine, startLine))
									} else {
										content = addLineNumbers(
											await readLines(absolutePath, endLine, startLine),
											startLine + 1,
										)
									}
								} else if (autoTruncate && !isBinary && totalLines > maxReadFileLine) {
									// If file is too large, only read the first maxReadFileLine lines
									isFileTruncated = true

									const res = await Promise.all([
										maxReadFileLine > 0 ? readLines(absolutePath, maxReadFileLine - 1, 0) : "",
										parseSourceCodeDefinitionsForFile(absolutePath, this.rooIgnoreController),
									])

									content = res[0].length > 0 ? addLineNumbers(res[0]) : ""
									const result = res[1]
									if (result) {
										sourceCodeDef = `\n\n${result}`
									}
								} else {
									// Read entire file
									content = await extractTextFromFile(absolutePath)
								}

								// Add truncation notice if applicable
								if (isFileTruncated) {
									content += `\n\n[File truncated: showing ${maxReadFileLine} of ${totalLines} total lines. Use start_line and end_line or set auto_truncate to false if you need to read more.].${sourceCodeDef}`
								}

								pushToolResult(content)
								break
							}
						} catch (error) {
							await handleError("reading file", error)
							break
						}
					}

					case "fetch_instructions": {
						const task: string | undefined = block.params.task
						const sharedMessageProps: ClineSayTool = {
							tool: "fetchInstructions",
							content: task,
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: undefined,
								} satisfies ClineSayTool)
								await this.ask("tool", partialMessage, block.partial).catch(() => {})
								break
							} else {
								if (!task) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("fetch_instructions", "task"),
									)
									break
								}

								this.consecutiveMistakeCount = 0
								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: task,
								} satisfies ClineSayTool)

								const didApprove = await askApproval("tool", completeMessage)
								if (!didApprove) {
									break
								}

								// now fetch the content and provide it to the agent.
								const provider = this.providerRef.deref()
								const mcpHub = provider?.getMcpHub()
								if (!mcpHub) {
									throw new Error("MCP hub not available")
								}
								const diffStrategy = this.diffStrategy
								const context = provider?.context
								const content = await fetchInstructions(task, { mcpHub, diffStrategy, context })
								if (!content) {
									pushToolResult(formatResponse.toolError(`Invalid instructions request: ${task}`))
									break
								}
								pushToolResult(content)
								break
							}
						} catch (error) {
							await handleError("fetch instructions", error)
							break
						}
					}

					case "list_files": {
						const relDirPath: string | undefined = block.params.path
						const recursiveRaw: string | undefined = block.params.recursive
						const recursive = recursiveRaw?.toLowerCase() === "true"
						const sharedMessageProps: ClineSayTool = {
							tool: !recursive ? "listFilesTopLevel" : "listFilesRecursive",
							path: getReadablePath(this.cwd, removeClosingTag("path", relDirPath)),
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: "",
								} satisfies ClineSayTool)
								await this.ask("tool", partialMessage, block.partial).catch(() => {})
								break
							} else {
								if (!relDirPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("list_files", "path"))
									break
								}
								this.consecutiveMistakeCount = 0
								const absolutePath = path.resolve(this.cwd, relDirPath)
								const [files, didHitLimit] = await listFiles(absolutePath, recursive, 200)
								const { showRooIgnoredFiles } = (await this.providerRef.deref()?.getState()) ?? {}
								const result = formatResponse.formatFilesList(
									absolutePath,
									files,
									didHitLimit,
									this.rooIgnoreController,
									showRooIgnoredFiles ?? true,
								)
								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: result,
								} satisfies ClineSayTool)
								const didApprove = await askApproval("tool", completeMessage)
								if (!didApprove) {
									break
								}
								pushToolResult(result)
								break
							}
						} catch (error) {
							await handleError("listing files", error)
							break
						}
					}
					case "list_code_definition_names": {
						const relDirPath: string | undefined = block.params.path
						const sharedMessageProps: ClineSayTool = {
							tool: "listCodeDefinitionNames",
							path: getReadablePath(this.cwd, removeClosingTag("path", relDirPath)),
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: "",
								} satisfies ClineSayTool)
								await this.ask("tool", partialMessage, block.partial).catch(() => {})
								break
							} else {
								if (!relDirPath) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("list_code_definition_names", "path"),
									)
									break
								}
								this.consecutiveMistakeCount = 0
								const absolutePath = path.resolve(this.cwd, relDirPath)
								const result = await parseSourceCodeForDefinitionsTopLevel(
									absolutePath,
									this.rooIgnoreController,
								)
								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: result,
								} satisfies ClineSayTool)
								const didApprove = await askApproval("tool", completeMessage)
								if (!didApprove) {
									break
								}
								pushToolResult(result)
								break
							}
						} catch (error) {
							await handleError("parsing source code definitions", error)
							break
						}
					}
					case "search_files": {
						const relDirPath: string | undefined = block.params.path
						const regex: string | undefined = block.params.regex
						const filePattern: string | undefined = block.params.file_pattern
						const sharedMessageProps: ClineSayTool = {
							tool: "searchFiles",
							path: getReadablePath(this.cwd, removeClosingTag("path", relDirPath)),
							regex: removeClosingTag("regex", regex),
							filePattern: removeClosingTag("file_pattern", filePattern),
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: "",
								} satisfies ClineSayTool)
								await this.ask("tool", partialMessage, block.partial).catch(() => {})
								break
							} else {
								if (!relDirPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("search_files", "path"))
									break
								}
								if (!regex) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("search_files", "regex"))
									break
								}
								this.consecutiveMistakeCount = 0
								const absolutePath = path.resolve(this.cwd, relDirPath)
								const results = await regexSearchFiles(
									this.cwd,
									absolutePath,
									regex,
									filePattern,
									this.rooIgnoreController,
								)
								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: results,
								} satisfies ClineSayTool)
								const didApprove = await askApproval("tool", completeMessage)
								if (!didApprove) {
									break
								}
								pushToolResult(results)
								break
							}
						} catch (error) {
							await handleError("searching files", error)
							break
						}
					}
					case "browser_action": {
						const action: BrowserAction | undefined = block.params.action as BrowserAction
						const url: string | undefined = block.params.url
						const coordinate: string | undefined = block.params.coordinate
						const text: string | undefined = block.params.text
						if (!action || !browserActions.includes(action)) {
							// checking for action to ensure it is complete and valid
							if (!block.partial) {
								// if the block is complete and we don't have a valid action this is a mistake
								this.consecutiveMistakeCount++
								pushToolResult(await this.sayAndCreateMissingParamError("browser_action", "action"))
								await this.browserSession.closeBrowser()
							}
							break
						}

						try {
							if (block.partial) {
								if (action === "launch") {
									await this.ask(
										"browser_action_launch",
										removeClosingTag("url", url),
										block.partial,
									).catch(() => {})
								} else {
									await this.say(
										"browser_action",
										JSON.stringify({
											action: action as BrowserAction,
											coordinate: removeClosingTag("coordinate", coordinate),
											text: removeClosingTag("text", text),
										} satisfies ClineSayBrowserAction),
										undefined,
										block.partial,
									)
								}
								break
							} else {
								let browserActionResult: BrowserActionResult
								if (action === "launch") {
									if (!url) {
										this.consecutiveMistakeCount++
										pushToolResult(
											await this.sayAndCreateMissingParamError("browser_action", "url"),
										)
										await this.browserSession.closeBrowser()
										break
									}
									this.consecutiveMistakeCount = 0
									const didApprove = await askApproval("browser_action_launch", url)
									if (!didApprove) {
										break
									}

									// NOTE: it's okay that we call this message since the partial inspect_site is finished streaming. The only scenario we have to avoid is sending messages WHILE a partial message exists at the end of the messages array. For example the api_req_finished message would interfere with the partial message, so we needed to remove that.
									// await this.say("inspect_site_result", "") // no result, starts the loading spinner waiting for result
									await this.say("browser_action_result", "") // starts loading spinner

									await this.browserSession.launchBrowser()
									browserActionResult = await this.browserSession.navigateToUrl(url)
								} else {
									if (action === "click") {
										if (!coordinate) {
											this.consecutiveMistakeCount++
											pushToolResult(
												await this.sayAndCreateMissingParamError(
													"browser_action",
													"coordinate",
												),
											)
											await this.browserSession.closeBrowser()
											break // can't be within an inner switch
										}
									}
									if (action === "type") {
										if (!text) {
											this.consecutiveMistakeCount++
											pushToolResult(
												await this.sayAndCreateMissingParamError("browser_action", "text"),
											)
											await this.browserSession.closeBrowser()
											break
										}
									}
									this.consecutiveMistakeCount = 0
									await this.say(
										"browser_action",
										JSON.stringify({
											action: action as BrowserAction,
											coordinate,
											text,
										} satisfies ClineSayBrowserAction),
										undefined,
										false,
									)
									switch (action) {
										case "click":
											browserActionResult = await this.browserSession.click(coordinate!)
											break
										case "type":
											browserActionResult = await this.browserSession.type(text!)
											break
										case "scroll_down":
											browserActionResult = await this.browserSession.scrollDown()
											break
										case "scroll_up":
											browserActionResult = await this.browserSession.scrollUp()
											break
										case "close":
											browserActionResult = await this.browserSession.closeBrowser()
											break
									}
								}

								switch (action) {
									case "launch":
									case "click":
									case "type":
									case "scroll_down":
									case "scroll_up":
										await this.say("browser_action_result", JSON.stringify(browserActionResult))
										pushToolResult(
											formatResponse.toolResult(
												`The browser action has been executed. The console logs and screenshot have been captured for your analysis.\n\nConsole logs:\n${
													browserActionResult.logs || "(No new logs)"
												}\n\n(REMEMBER: if you need to proceed to using non-\`browser_action\` tools or launch a new browser, you MUST first close this browser. For example, if after analyzing the logs and screenshot you need to edit a file, you must first close the browser before you can use the write_to_file tool.)`,
												browserActionResult.screenshot ? [browserActionResult.screenshot] : [],
											),
										)
										break
									case "close":
										pushToolResult(
											formatResponse.toolResult(
												`The browser has been closed. You may now proceed to using other tools.`,
											),
										)
										break
								}
								break
							}
						} catch (error) {
							await this.browserSession.closeBrowser() // if any error occurs, the browser session is terminated
							await handleError("executing browser action", error)
							break
						}
					}
					case "execute_command": {
						const command: string | undefined = block.params.command
						const customCwd: string | undefined = block.params.cwd
						try {
							if (block.partial) {
								await this.ask("command", removeClosingTag("command", command), block.partial).catch(
									() => {},
								)
								break
							} else {
								if (!command) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("execute_command", "command"),
									)
									break
								}

								const ignoredFileAttemptedToAccess = this.rooIgnoreController?.validateCommand(command)
								if (ignoredFileAttemptedToAccess) {
									await this.say("rooignore_error", ignoredFileAttemptedToAccess)
									pushToolResult(
										formatResponse.toolError(
											formatResponse.rooIgnoreError(ignoredFileAttemptedToAccess),
										),
									)

									break
								}

								this.consecutiveMistakeCount = 0

								const didApprove = await askApproval("command", command)
								if (!didApprove) {
									break
								}
								const [userRejected, result] = await this.executeCommandTool(command, customCwd)
								if (userRejected) {
									this.didRejectTool = true
								}
								pushToolResult(result)
								break
							}
						} catch (error) {
							await handleError("executing command", error)
							break
						}
					}
					case "use_mcp_tool": {
						const server_name: string | undefined = block.params.server_name
						const tool_name: string | undefined = block.params.tool_name
						const mcp_arguments: string | undefined = block.params.arguments
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									type: "use_mcp_tool",
									serverName: removeClosingTag("server_name", server_name),
									toolName: removeClosingTag("tool_name", tool_name),
									arguments: removeClosingTag("arguments", mcp_arguments),
								} satisfies ClineAskUseMcpServer)
								await this.ask("use_mcp_server", partialMessage, block.partial).catch(() => {})
								break
							} else {
								if (!server_name) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("use_mcp_tool", "server_name"),
									)
									break
								}
								if (!tool_name) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("use_mcp_tool", "tool_name"),
									)
									break
								}
								// arguments are optional, but if they are provided they must be valid JSON
								// if (!mcp_arguments) {
								// 	this.consecutiveMistakeCount++
								// 	pushToolResult(await this.sayAndCreateMissingParamError("use_mcp_tool", "arguments"))
								// 	break
								// }
								let parsedArguments: Record<string, unknown> | undefined
								if (mcp_arguments) {
									try {
										parsedArguments = JSON.parse(mcp_arguments)
									} catch (error) {
										this.consecutiveMistakeCount++
										await this.say(
											"error",
											`Roo tried to use ${tool_name} with an invalid JSON argument. Retrying...`,
										)
										pushToolResult(
											formatResponse.toolError(
												formatResponse.invalidMcpToolArgumentError(server_name, tool_name),
											),
										)
										break
									}
								}
								this.consecutiveMistakeCount = 0
								const completeMessage = JSON.stringify({
									type: "use_mcp_tool",
									serverName: server_name,
									toolName: tool_name,
									arguments: mcp_arguments,
								} satisfies ClineAskUseMcpServer)
								const didApprove = await askApproval("use_mcp_server", completeMessage)
								if (!didApprove) {
									break
								}
								// now execute the tool
								await this.say("mcp_server_request_started") // same as browser_action_result
								const toolResult = await this.providerRef
									.deref()
									?.getMcpHub()
									?.callTool(server_name, tool_name, parsedArguments)

								// TODO: add progress indicator and ability to parse images and non-text responses
								const toolResultPretty =
									(toolResult?.isError ? "Error:\n" : "") +
										toolResult?.content
											.map((item) => {
												if (item.type === "text") {
													return item.text
												}
												if (item.type === "resource") {
													const { blob, ...rest } = item.resource
													return JSON.stringify(rest, null, 2)
												}
												return ""
											})
											.filter(Boolean)
											.join("\n\n") || "(No response)"
								await this.say("mcp_server_response", toolResultPretty)
								pushToolResult(formatResponse.toolResult(toolResultPretty))
								break
							}
						} catch (error) {
							await handleError("executing MCP tool", error)
							break
						}
					}
					case "access_mcp_resource": {
						const server_name: string | undefined = block.params.server_name
						const uri: string | undefined = block.params.uri
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									type: "access_mcp_resource",
									serverName: removeClosingTag("server_name", server_name),
									uri: removeClosingTag("uri", uri),
								} satisfies ClineAskUseMcpServer)
								await this.ask("use_mcp_server", partialMessage, block.partial).catch(() => {})
								break
							} else {
								if (!server_name) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("access_mcp_resource", "server_name"),
									)
									break
								}
								if (!uri) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("access_mcp_resource", "uri"),
									)
									break
								}
								this.consecutiveMistakeCount = 0
								const completeMessage = JSON.stringify({
									type: "access_mcp_resource",
									serverName: server_name,
									uri,
								} satisfies ClineAskUseMcpServer)
								const didApprove = await askApproval("use_mcp_server", completeMessage)
								if (!didApprove) {
									break
								}
								// now execute the tool
								await this.say("mcp_server_request_started")
								const resourceResult = await this.providerRef
									.deref()
									?.getMcpHub()
									?.readResource(server_name, uri)
								const resourceResultPretty =
									resourceResult?.contents
										.map((item) => {
											if (item.text) {
												return item.text
											}
											return ""
										})
										.filter(Boolean)
										.join("\n\n") || "(Empty response)"

								// handle images (image must contain mimetype and blob)
								let images: string[] = []
								resourceResult?.contents.forEach((item) => {
									if (item.mimeType?.startsWith("image") && item.blob) {
										images.push(item.blob)
									}
								})
								await this.say("mcp_server_response", resourceResultPretty, images)
								pushToolResult(formatResponse.toolResult(resourceResultPretty, images))
								break
							}
						} catch (error) {
							await handleError("accessing MCP resource", error)
							break
						}
					}
					case "ask_followup_question": {
						const question: string | undefined = block.params.question
						const follow_up: string | undefined = block.params.follow_up
						try {
							if (block.partial) {
								await this.ask("followup", removeClosingTag("question", question), block.partial).catch(
									() => {},
								)
								break
							} else {
								if (!question) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("ask_followup_question", "question"),
									)
									break
								}

								type Suggest = {
									answer: string
								}

								let follow_up_json = {
									question,
									suggest: [] as Suggest[],
								}

								if (follow_up) {
									let parsedSuggest: {
										suggest: Suggest[] | Suggest
									}

									try {
										parsedSuggest = parseXml(follow_up, ["suggest"]) as {
											suggest: Suggest[] | Suggest
										}
									} catch (error) {
										this.consecutiveMistakeCount++
										await this.say("error", `Failed to parse operations: ${error.message}`)
										pushToolResult(formatResponse.toolError("Invalid operations xml format"))
										break
									}

									const normalizedSuggest = Array.isArray(parsedSuggest?.suggest)
										? parsedSuggest.suggest
										: [parsedSuggest?.suggest].filter((sug): sug is Suggest => sug !== undefined)

									follow_up_json.suggest = normalizedSuggest
								}

								this.consecutiveMistakeCount = 0

								// --- BEGIN Telegram Notification via WebSocket ---
								try {
									const questionText = follow_up_json.question;
									// Extract suggestions, handling different possible structures from XML parser
									const suggestions: string[] = Array.isArray(follow_up_json.suggest)
										? follow_up_json.suggest
											.map(s => {
												let text = null;
												if (s && typeof s === 'object') {
													if ('#text' in s && typeof s['#text'] === 'string') text = s['#text'];
													else if ('_' in s && typeof s['_'] === 'string') text = s['_'];
													else if ('value' in s && typeof s['value'] === 'string') text = s['value'];
												} else if (typeof s === 'string') {
													text = s;
												}
												return text;
											})
											.filter((text): text is string => text !== null)
										: []; // Default to empty array if not an array

									// Use WebSocketClient to send the notification
									if (this.webSocketClient) {
										console.log("[Cline] Calling WebSocketClient.sendFollowupQuestion");
										this.webSocketClient.sendFollowupQuestion(
											this.taskId,
											questionText,
											suggestions
										);
										console.log("[Cline] WebSocketClient.sendFollowupQuestion called");
									} else {
										console.error("[Cline] WebSocketClient not available. Cannot send Telegram notification.");
										await this.say("error", "Internal error: WebSocket service not available for Telegram.");
										// Decide if we should break or continue without notification
										// break; // Option: Stop if notification fails
									}
								} catch (wsError) {
									console.error("Error calling WebSocketClient.sendFollowupQuestion:", wsError);
									await this.say("error", `Internal error sending Telegram notification via WebSocket: ${wsError instanceof Error ? wsError.message : String(wsError)}`);
									// Decide if we should break or continue without notification
									// break; // Option: Stop if notification fails
								}
								// --- END Telegram Notification ---

// Reset askResponse state before waiting for the next response
this.askResponse = undefined;
this.askResponseText = undefined;
this.askResponseImages = undefined;
console.log(`[Cline ${this.taskId}] Reset askResponse state before waiting for external response.`);

// Now proceed to wait for the response via the standard mechanism
const { text, images } = await this.ask(
	"followup",
	JSON.stringify(follow_up_json), // Still send original structure to UI
	false,
)
								// Removed extra closing parenthesis from line 3102
								// The response 'text' will eventually be populated by the incoming IPC message triggering handleWebviewAskResponse
								await this.say("user_feedback", text ?? "", images)
								pushToolResult(formatResponse.toolResult(`<answer>\n${text}\n</answer>`, images))
								break
							}
						} catch (error) {
							await handleError("asking question", error)
							break
						}
					}
					case "switch_mode": {
						const mode_slug: string | undefined = block.params.mode_slug
						const reason: string | undefined = block.params.reason
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									tool: "switchMode",
									mode: removeClosingTag("mode_slug", mode_slug),
									reason: removeClosingTag("reason", reason),
								})
								await this.ask("tool", partialMessage, block.partial).catch(() => {})
								break
							} else {
								if (!mode_slug) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("switch_mode", "mode_slug"))
									break
								}
								this.consecutiveMistakeCount = 0

								// Verify the mode exists
								const targetMode = getModeBySlug(
									mode_slug,
									(await this.providerRef.deref()?.getState())?.customModes,
								)
								if (!targetMode) {
									pushToolResult(formatResponse.toolError(`Invalid mode: ${mode_slug}`))
									break
								}

								// Check if already in requested mode
								const currentMode =
									(await this.providerRef.deref()?.getState())?.mode ?? defaultModeSlug
								if (currentMode === mode_slug) {
									pushToolResult(`Already in ${targetMode.name} mode.`)
									break
								}

								const completeMessage = JSON.stringify({
									tool: "switchMode",
									mode: mode_slug,
									reason,
								})

								const didApprove = await askApproval("tool", completeMessage)
								if (!didApprove) {
									break
								}

								// Switch the mode using shared handler
								await this.providerRef.deref()?.handleModeSwitch(mode_slug)
								pushToolResult(
									`Successfully switched from ${getModeBySlug(currentMode)?.name ?? currentMode} mode to ${
										targetMode.name
									} mode${reason ? ` because: ${reason}` : ""}.`,
								)
								await delay(500) // delay to allow mode change to take effect before next tool is executed
								break
							}
						} catch (error) {
							await handleError("switching mode", error)
							break
						}
					}

					case "new_task": {
						const mode: string | undefined = block.params.mode
						const message: string | undefined = block.params.message
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									tool: "newTask",
									mode: removeClosingTag("mode", mode),
									message: removeClosingTag("message", message),
								})
								await this.ask("tool", partialMessage, block.partial).catch(() => {})
								break
							} else {
								if (!mode) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("new_task", "mode"))
									break
								}
								if (!message) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("new_task", "message"))
									break
								}
								this.consecutiveMistakeCount = 0

								// Verify the mode exists
								const targetMode = getModeBySlug(
									mode,
									(await this.providerRef.deref()?.getState())?.customModes,
								)
								if (!targetMode) {
									pushToolResult(formatResponse.toolError(`Invalid mode: ${mode}`))
									break
								}

								const toolMessage = JSON.stringify({
									tool: "newTask",
									mode: targetMode.name,
									content: message,
								})
								const didApprove = await askApproval("tool", toolMessage)

								if (!didApprove) {
									break
								}

								const provider = this.providerRef.deref()

								if (!provider) {
									break
								}

								// Preserve the current mode so we can resume with it later.
								this.pausedModeSlug = (await provider.getState()).mode ?? defaultModeSlug

								// Switch mode first, then create new task instance.
								await provider.handleModeSwitch(mode)

								// Delay to allow mode change to take effect before next tool is executed.
								await delay(500)

								const newCline = await provider.initClineWithTask(message, undefined, this)
								this.emit("taskSpawned", newCline.taskId)

								pushToolResult(
									`Successfully created new task in ${targetMode.name} mode with message: ${message}`,
								)

								// Set the isPaused flag to true so the parent
								// task can wait for the sub-task to finish.
								this.isPaused = true
								this.emit("taskPaused")

								break
							}
						} catch (error) {
							await handleError("creating new task", error)
							break
						}
					}

					case "attempt_completion": {
						// Store the block for later processing by _executePendingCompletion
						// We are already inside the 'case "tool_use":' block of the outer switch,
						// so 'block' is guaranteed to be of type Anthropic.Messages.ToolUseBlock here.
						this.pendingCompletionBlock = block as unknown as Anthropic.Messages.ToolUseBlock
						console.log("[Cline] Storing pending attempt_completion block.")
						// Don't process the completion logic here. It will be handled
						// by _executePendingCompletion after the stream ends.
						break
					}
// Removed erroneous code remnants between switch cases
            }
		}

		if (isCheckpointPossible) {
			this.checkpointSave()
		}

		/*
		Seeing out of bounds is fine, it means that the next too call is being built up and ready to add to assistantMessageContent to present.
		When you see the UI inactive during this, it means that a tool is breaking without presenting any UI. For example the write_to_file tool was breaking when relpath was undefined, and for invalid relpath it never presented UI.
		*/
		this.presentAssistantMessageLocked = false // this needs to be placed here, if not then calling this.presentAssistantMessage below would fail (sometimes) since it's locked
		// NOTE: when tool is rejected, iterator stream is interrupted and it waits for userMessageContentReady to be true. Future calls to present will skip execution since didRejectTool and iterate until contentIndex is set to message length and it sets userMessageContentReady to true itself (instead of preemptively doing it in iterator)
		if (!block.partial || this.didRejectTool || this.didAlreadyUseTool) {
			// block is finished streaming and executing
			if (this.currentStreamingContentIndex === this.assistantMessageContent.length - 1) {
				// its okay that we increment if !didCompleteReadingStream, it'll just return bc out of bounds and as streaming continues it will call presentAssitantMessage if a new block is ready. if streaming is finished then we set userMessageContentReady to true when out of bounds. This gracefully allows the stream to continue on and all potential content blocks be presented.
				// last block is complete and it is finished executing
				this.userMessageContentReady = true // will allow pwaitfor to continue
			}

			// call next block if it exists (if not then read stream will call it when its ready)
			this.currentStreamingContentIndex++ // need to increment regardless, so when read stream calls this function again it will be streaming the next block

			if (this.currentStreamingContentIndex < this.assistantMessageContent.length) {
				// there are already more content blocks to stream, so we'll call this function ourselves
				// await this.presentAssistantContent()

				this.presentAssistantMessage()
				return
			}
		}
		// block is partial, but the read stream may have finished
		if (this.presentAssistantMessageHasPendingUpdates) {
			this.presentAssistantMessage()
		}
	}

	// Used when a sub-task is launched and the parent task is waiting for it to
	// finish.
	// TBD: The 1s should be added to the settings, also should add a timeout to
	// prevent infinite waiting.
	async waitForResume() {
		await new Promise<void>((resolve) => {
			this.pauseInterval = setInterval(() => {
				if (!this.isPaused) {
					clearInterval(this.pauseInterval)
					this.pauseInterval = undefined
					resolve()
				}
			}, 1000)
		})
	}

	async recursivelyMakeClineRequests(
		userContent: UserContent,
		includeFileDetails: boolean = false,
	): Promise<boolean> {
		if (this.abort) {
			throw new Error(`[Cline#recursivelyMakeClineRequests] task ${this.taskId}.${this.instanceId} aborted`)
		}

		if (this.consecutiveMistakeCount >= 3) {
			const { response, text, images } = await this.ask(
				"mistake_limit_reached",
				this.api.getModel().id.includes("claude")
					? `This may indicate a failure in his thought process or inability to use a tool properly, which can be mitigated with some user guidance (e.g. "Try breaking down the task into smaller steps").`
					: "Roo Code uses complex prompts and iterative task execution that may be challenging for less capable models. For best results, it's recommended to use Claude 3.7 Sonnet for its advanced agentic coding capabilities.",
			)
			if (response === "messageResponse") {
				userContent.push(
					...[
						{
							type: "text",
							text: formatResponse.tooManyMistakes(text),
						} as Anthropic.Messages.TextBlockParam,
						...formatResponse.imageBlocks(images),
					],
				)
			}
			this.consecutiveMistakeCount = 0
		}

		// Get previous api req's index to check token usage and determine if we
		// need to truncate conversation history.
		const previousApiReqIndex = findLastIndex(this.clineMessages, (m) => m.say === "api_req_started")

		// In this Cline request loop, we need to check if this task instance
		// has been asked to wait for a subtask to finish before continuing.
		const provider = this.providerRef.deref()

		if (this.isPaused && provider) {
			provider.log(`[subtasks] paused ${this.taskId}.${this.instanceId}`)
			await this.waitForResume()
			provider.log(`[subtasks] resumed ${this.taskId}.${this.instanceId}`)
			const currentMode = (await provider.getState())?.mode ?? defaultModeSlug

			if (currentMode !== this.pausedModeSlug) {
				// The mode has changed, we need to switch back to the paused mode.
				await provider.handleModeSwitch(this.pausedModeSlug)

				// Delay to allow mode change to take effect before next tool is executed.
				await delay(500)

				provider.log(
					`[subtasks] task ${this.taskId}.${this.instanceId} has switched back to '${this.pausedModeSlug}' from '${currentMode}'`,
				)
			}
		}

		// Getting verbose details is an expensive operation, it uses globby to
		// top-down build file structure of project which for large projects can
		// take a few seconds. For the best UX we show a placeholder api_req_started
		// message with a loading spinner as this happens.
		await this.say(
			"api_req_started",
			JSON.stringify({
				request:
					userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n") + "\n\nLoading...",
			}),
		)

		const [parsedUserContent, environmentDetails] = await this.loadContext(userContent, includeFileDetails)
		userContent = parsedUserContent
		// add environment details as its own text block, separate from tool results
		userContent.push({ type: "text", text: environmentDetails })

		await this.addToApiConversationHistory({ role: "user", content: userContent })
		telemetryService.captureConversationMessage(this.taskId, "user")

		// since we sent off a placeholder api_req_started message to update the webview while waiting to actually start the API request (to load potential details for example), we need to update the text of that message
		const lastApiReqIndex = findLastIndex(this.clineMessages, (m) => m.say === "api_req_started")
		this.clineMessages[lastApiReqIndex].text = JSON.stringify({
			request: userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n"),
		} satisfies ClineApiReqInfo)
		await this.saveClineMessages()
		await this.providerRef.deref()?.postStateToWebview()

		try {
			let cacheWriteTokens = 0
			let cacheReadTokens = 0
			let inputTokens = 0
			let outputTokens = 0
			let totalCost: number | undefined

			// update api_req_started. we can't use api_req_finished anymore since it's a unique case where it could come after a streaming message (ie in the middle of being updated or executed)
			// fortunately api_req_finished was always parsed out for the gui anyways, so it remains solely for legacy purposes to keep track of prices in tasks from history
			// (it's worth removing a few months from now)
			const updateApiReqMsg = (cancelReason?: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
				this.clineMessages[lastApiReqIndex].text = JSON.stringify({
					...JSON.parse(this.clineMessages[lastApiReqIndex].text || "{}"),
					tokensIn: inputTokens,
					tokensOut: outputTokens,
					cacheWrites: cacheWriteTokens,
					cacheReads: cacheReadTokens,
					cost:
						totalCost ??
						calculateApiCostAnthropic(
							this.api.getModel().info,
							inputTokens,
							outputTokens,
							cacheWriteTokens,
							cacheReadTokens,
						),
					cancelReason,
					streamingFailedMessage,
				} satisfies ClineApiReqInfo)
			}

			const abortStream = async (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
				if (this.diffViewProvider.isEditing) {
					await this.diffViewProvider.revertChanges() // closes diff view
				}

				// if last message is a partial we need to update and save it
				const lastMessage = this.clineMessages.at(-1)
				if (lastMessage && lastMessage.partial) {
					// lastMessage.ts = Date.now() DO NOT update ts since it is used as a key for virtuoso list
					lastMessage.partial = false
					// instead of streaming partialMessage events, we do a save and post like normal to persist to disk
					console.log("updating partial message", lastMessage)
					// await this.saveClineMessages()
				}

				// Let assistant know their response was interrupted for when task is resumed
				await this.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text:
								assistantMessage +
								`\n\n[${
									cancelReason === "streaming_failed"
										? "Response interrupted by API Error"
										: "Response interrupted by user"
								}]`,
						},
					],
				})

				// update api_req_started to have cancelled and cost, so that we can display the cost of the partial stream
				updateApiReqMsg(cancelReason, streamingFailedMessage)
				await this.saveClineMessages()

				// signals to provider that it can retrieve the saved messages from disk, as abortTask can not be awaited on in nature
				this.didFinishAbortingStream = true
			}

			// reset streaming state
			this.currentStreamingContentIndex = 0
			this.assistantMessageContent = []
			this.didCompleteReadingStream = false
			this.userMessageContent = []
			this.userMessageContentReady = false
			this.didRejectTool = false
			this.didAlreadyUseTool = false
			this.presentAssistantMessageLocked = false
			this.presentAssistantMessageHasPendingUpdates = false
			await this.diffViewProvider.reset()

			const stream = this.attemptApiRequest(previousApiReqIndex) // yields only if the first chunk is successful, otherwise will allow the user to retry the request (most likely due to rate limit error, which gets thrown on the first chunk)
			let assistantMessage = ""
			let reasoningMessage = ""
			this.isStreaming = true

			try {
				for await (const chunk of stream) {
					if (!chunk) {
						// Sometimes chunk is undefined, no idea that can cause it, but this workaround seems to fix it
						continue
					}
					switch (chunk.type) {
						case "reasoning":
							reasoningMessage += chunk.text
							await this.say("reasoning", reasoningMessage, undefined, true)
							break
						case "usage":
							inputTokens += chunk.inputTokens
							outputTokens += chunk.outputTokens
							cacheWriteTokens += chunk.cacheWriteTokens ?? 0
							cacheReadTokens += chunk.cacheReadTokens ?? 0
							totalCost = chunk.totalCost
							break
						case "text":
							assistantMessage += chunk.text
							// parse raw assistant message into content blocks
							const prevLength = this.assistantMessageContent.length
							this.assistantMessageContent = parseAssistantMessage(assistantMessage)
							if (this.assistantMessageContent.length > prevLength) {
								this.userMessageContentReady = false // new content we need to present, reset to false in case previous content set this to true
							}
							// present content to user
							this.presentAssistantMessage()
							break
					}

					if (this.abort) {
						console.log(`aborting stream, this.abandoned = ${this.abandoned}`)

						if (!this.abandoned) {
							// only need to gracefully abort if this instance isn't abandoned (sometimes openrouter stream hangs, in which case this would affect future instances of cline)
							await abortStream("user_cancelled")
						}

						break // aborts the stream
					}

					if (this.didRejectTool) {
						// userContent has a tool rejection, so interrupt the assistant's response to present the user's feedback
						assistantMessage += "\n\n[Response interrupted by user feedback]"
						// this.userMessageContentReady = true // instead of setting this premptively, we allow the present iterator to finish and set userMessageContentReady when its ready
						break
					}

					// PREV: we need to let the request finish for openrouter to get generation details
					// UPDATE: it's better UX to interrupt the request at the cost of the api cost not being retrieved
					if (this.didAlreadyUseTool) {
						assistantMessage +=
							"\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]"
						break
					}
				}
			} catch (error) {
				// abandoned happens when extension is no longer waiting for the cline instance to finish aborting (error is thrown here when any function in the for loop throws due to this.abort)
				if (!this.abandoned) {
					this.abortTask() // if the stream failed, there's various states the task could be in (i.e. could have streamed some tools the user may have executed), so we just resort to replicating a cancel task
					await abortStream(
						"streaming_failed",
						error.message ?? JSON.stringify(serializeError(error), null, 2),
					)
					const history = await this.providerRef.deref()?.getTaskWithId(this.taskId)
					if (history) {
						await this.providerRef.deref()?.initClineWithHistoryItem(history.historyItem)
						// await this.providerRef.deref()?.postStateToWebview()
					}
				}
			} finally {
				this.isStreaming = false
			}

			// need to call here in case the stream was aborted
			if (this.abort || this.abandoned) {
				throw new Error(`[Cline#recursivelyMakeClineRequests] task ${this.taskId}.${this.instanceId} aborted`)
			}

			this.didCompleteReadingStream = true

			// set any blocks to be complete to allow presentAssistantMessage to finish and set userMessageContentReady to true
			// (could be a text block that had no subsequent tool uses, or a text block at the very end, or an invalid tool use, etc. whatever the case, presentAssistantMessage relies on these blocks either to be completed or the user to reject a block in order to proceed and eventually set userMessageContentReady to true)
			const partialBlocks = this.assistantMessageContent.filter((block) => block.partial)
			partialBlocks.forEach((block) => {
				block.partial = false
			})
			// this.assistantMessageContent.forEach((e) => (e.partial = false)) // cant just do this bc a tool could be in the middle of executing ()
			if (partialBlocks.length > 0) {
				this.presentAssistantMessage() // if there is content to update then it will complete and update this.userMessageContentReady to true, which we pwaitfor before making the next request. all this is really doing is presenting the last partial message that we just set to complete
			}

			updateApiReqMsg()
			await this.saveClineMessages()
			await this.providerRef.deref()?.postStateToWebview()

			// now add to apiconversationhistory
			// need to save assistant responses to file before proceeding to tool use since user can exit at any moment and we wouldn't be able to save the assistant's response
			let didEndLoop = false
			if (assistantMessage.length > 0) {
				await this.addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: assistantMessage }],
				})
				telemetryService.captureConversationMessage(this.taskId, "assistant")

				// NOTE: this comment is here for future reference - this was a workaround for userMessageContent not getting set to true. It was due to it not recursively calling for partial blocks when didRejectTool, so it would get stuck waiting for a partial block to complete before it could continue.
				// in case the content blocks finished
				// it may be the api stream finished after the last parsed content block was executed, so  we are able to detect out of bounds and set userMessageContentReady to true (note you should not call presentAssistantMessage since if the last block is completed it will be presented again)
				// const completeBlocks = this.assistantMessageContent.filter((block) => !block.partial) // if there are any partial blocks after the stream ended we can consider them invalid
				// if (this.currentStreamingContentIndex >= completeBlocks.length) {
				// 	this.userMessageContentReady = true
				// }

				await pWaitFor(() => this.userMessageContentReady)

				// if the model did not tool use, then we need to tell it to either use a tool or attempt_completion
				const didToolUse = this.assistantMessageContent.some((block) => block.type === "tool_use")
				if (!didToolUse) {
					this.userMessageContent.push({
						type: "text",
						text: formatResponse.noToolsUsed(),
					})
					this.consecutiveMistakeCount++
				}

				const recDidEndLoop = await this.recursivelyMakeClineRequests(this.userMessageContent)
				didEndLoop = recDidEndLoop
			} else {
				// if there's no assistant_responses, that means we got no text or tool_use content blocks from API which we should assume is an error
				await this.say(
					"error",
					"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
				)
				await this.addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: "Failure: I did not provide a response." }],
				})
			}

			return didEndLoop // will always be false for now
		} catch (error) {
			// this should never happen since the only thing that can throw an error is the attemptApiRequest, which is wrapped in a try catch that sends an ask where if noButtonClicked, will clear current task and destroy this instance. However to avoid unhandled promise rejection, we will end this loop which will end execution of this instance (see startTask)
			return true // needs to be true so parent loop knows to end task
		}
	}

	async loadContext(userContent: UserContent, includeFileDetails: boolean = false) {
		return await Promise.all([
			// Process userContent array, which contains various block types:
			// TextBlockParam, ImageBlockParam, ToolUseBlockParam, and ToolResultBlockParam.
			// We need to apply parseMentions() to:
			// 1. All TextBlockParam's text (first user message with task)
			// 2. ToolResultBlockParam's content/context text arrays if it contains "<feedback>" (see formatToolDeniedFeedback, attemptCompletion, executeCommand, and consecutiveMistakeCount >= 3) or "<answer>" (see askFollowupQuestion), we place all user generated content in these tags so they can effectively be used as markers for when we should parse mentions)
			Promise.all(
				userContent.map(async (block) => {
					const shouldProcessMentions = (text: string) =>
						text.includes("<task>") || text.includes("<feedback>")

					if (block.type === "text") {
						if (shouldProcessMentions(block.text)) {
							return {
								...block,
								text: await parseMentions(block.text, this.cwd, this.urlContentFetcher),
							}
						}
						return block
					} else if (block.type === "tool_result") {
						if (typeof block.content === "string") {
							if (shouldProcessMentions(block.content)) {
								return {
									...block,
									content: await parseMentions(block.content, this.cwd, this.urlContentFetcher),
								}
							}
							return block
						} else if (Array.isArray(block.content)) {
							const parsedContent = await Promise.all(
								block.content.map(async (contentBlock) => {
									if (contentBlock.type === "text" && shouldProcessMentions(contentBlock.text)) {
										return {
											...contentBlock,
											text: await parseMentions(
												contentBlock.text,
												this.cwd,
												this.urlContentFetcher,
											),
										}
									}
									return contentBlock
								}),
							)
							return {
								...block,
								content: parsedContent,
							}
						}
						return block
					}
					return block
				}),
			),
			this.getEnvironmentDetails(includeFileDetails),
		])
	}

	async getEnvironmentDetails(includeFileDetails: boolean = false) {
		let details = ""

		const { terminalOutputLineLimit, maxWorkspaceFiles } = (await this.providerRef.deref()?.getState()) ?? {}

		// It could be useful for cline to know if the user went from one or no file to another between messages, so we always include this context
		details += "\n\n# VSCode Visible Files"
		const visibleFilePaths = vscode.window.visibleTextEditors
			?.map((editor) => editor.document?.uri?.fsPath)
			.filter(Boolean)
			.map((absolutePath) => path.relative(this.cwd, absolutePath))
			.slice(0, maxWorkspaceFiles ?? 200)

		// Filter paths through rooIgnoreController
		const allowedVisibleFiles = this.rooIgnoreController
			? this.rooIgnoreController.filterPaths(visibleFilePaths)
			: visibleFilePaths.map((p) => p.toPosix()).join("\n")

		if (allowedVisibleFiles) {
			details += `\n${allowedVisibleFiles}`
		} else {
			details += "\n(No visible files)"
		}

		details += "\n\n# VSCode Open Tabs"
		const { maxOpenTabsContext } = (await this.providerRef.deref()?.getState()) ?? {}
		const maxTabs = maxOpenTabsContext ?? 20
		const openTabPaths = vscode.window.tabGroups.all
			.flatMap((group) => group.tabs)
			.map((tab) => (tab.input as vscode.TabInputText)?.uri?.fsPath)
			.filter(Boolean)
			.map((absolutePath) => path.relative(this.cwd, absolutePath).toPosix())
			.slice(0, maxTabs)

		// Filter paths through rooIgnoreController
		const allowedOpenTabs = this.rooIgnoreController
			? this.rooIgnoreController.filterPaths(openTabPaths)
			: openTabPaths.map((p) => p.toPosix()).join("\n")

		if (allowedOpenTabs) {
			details += `\n${allowedOpenTabs}`
		} else {
			details += "\n(No open tabs)"
		}

		// Get task-specific and background terminals
		const busyTerminals = [
			...TerminalRegistry.getTerminals(true, this.taskId),
			...TerminalRegistry.getBackgroundTerminals(true),
		]
		const inactiveTerminals = [
			...TerminalRegistry.getTerminals(false, this.taskId),
			...TerminalRegistry.getBackgroundTerminals(false),
		]

		if (busyTerminals.length > 0 && this.didEditFile) {
			await delay(300) // delay after saving file to let terminals catch up
		}

		if (busyTerminals.length > 0) {
			// wait for terminals to cool down
			await pWaitFor(() => busyTerminals.every((t) => !TerminalRegistry.isProcessHot(t.id)), {
				interval: 100,
				timeout: 15_000,
			}).catch(() => {})
		}

		// we want to get diagnostics AFTER terminal cools down for a few reasons: terminal could be scaffolding a project, dev servers (compilers like webpack) will first re-compile and then send diagnostics, etc
		/*
		let diagnosticsDetails = ""
		const diagnostics = await this.diagnosticsMonitor.getCurrentDiagnostics(this.didEditFile || terminalWasBusy) // if cline ran a command (ie npm install) or edited the workspace then wait a bit for updated diagnostics
		for (const [uri, fileDiagnostics] of diagnostics) {
			const problems = fileDiagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
			if (problems.length > 0) {
				diagnosticsDetails += `\n## ${path.relative(this.cwd, uri.fsPath)}`
				for (const diagnostic of problems) {
					// let severity = diagnostic.severity === vscode.DiagnosticSeverity.Error ? "Error" : "Warning"
					const line = diagnostic.range.start.line + 1 // VSCode lines are 0-indexed
					const source = diagnostic.source ? `[${diagnostic.source}] ` : ""
					diagnosticsDetails += `\n- ${source}Line ${line}: ${diagnostic.message}`
				}
			}
		}
		*/
		this.didEditFile = false // reset, this lets us know when to wait for saved files to update terminals

		// waiting for updated diagnostics lets terminal output be the most up-to-date possible
		let terminalDetails = ""
		if (busyTerminals.length > 0) {
			// terminals are cool, let's retrieve their output
			terminalDetails += "\n\n# Actively Running Terminals"
			for (const busyTerminal of busyTerminals) {
				terminalDetails += `\n## Original command: \`${busyTerminal.getLastCommand()}\``
				let newOutput = TerminalRegistry.getUnretrievedOutput(busyTerminal.id)
				if (newOutput) {
					newOutput = Terminal.compressTerminalOutput(newOutput, terminalOutputLineLimit)
					terminalDetails += `\n### New Output\n${newOutput}`
				} else {
					// details += `\n(Still running, no new output)` // don't want to show this right after running the command
				}
			}
		}

		// First check if any inactive terminals in this task have completed processes with output
		const terminalsWithOutput = inactiveTerminals.filter((terminal) => {
			const completedProcesses = terminal.getProcessesWithOutput()
			return completedProcesses.length > 0
		})

		// Only add the header if there are terminals with output
		if (terminalsWithOutput.length > 0) {
			terminalDetails += "\n\n# Inactive Terminals with Completed Process Output"

			// Process each terminal with output
			for (const inactiveTerminal of terminalsWithOutput) {
				let terminalOutputs: string[] = []

				// Get output from completed processes queue
				const completedProcesses = inactiveTerminal.getProcessesWithOutput()
				for (const process of completedProcesses) {
					let output = process.getUnretrievedOutput()
					if (output) {
						output = Terminal.compressTerminalOutput(output, terminalOutputLineLimit)
						terminalOutputs.push(`Command: \`${process.command}\`\n${output}`)
					}
				}

				// Clean the queue after retrieving output
				inactiveTerminal.cleanCompletedProcessQueue()

				// Add this terminal's outputs to the details
				if (terminalOutputs.length > 0) {
					terminalDetails += `\n## Terminal ${inactiveTerminal.id}`
					terminalOutputs.forEach((output, index) => {
						terminalDetails += `\n### New Output\n${output}`
					})
				}
			}
		}

		// details += "\n\n# VSCode Workspace Errors"
		// if (diagnosticsDetails) {
		// 	details += diagnosticsDetails
		// } else {
		// 	details += "\n(No errors detected)"
		// }

		if (terminalDetails) {
			details += terminalDetails
		}

		// Add current time information with timezone
		const now = new Date()
		const formatter = new Intl.DateTimeFormat(undefined, {
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
			hour12: true,
		})
		const timeZone = formatter.resolvedOptions().timeZone
		const timeZoneOffset = -now.getTimezoneOffset() / 60 // Convert to hours and invert sign to match conventional notation
		const timeZoneOffsetHours = Math.floor(Math.abs(timeZoneOffset))
		const timeZoneOffsetMinutes = Math.abs(Math.round((Math.abs(timeZoneOffset) - timeZoneOffsetHours) * 60))
		const timeZoneOffsetStr = `${timeZoneOffset >= 0 ? "+" : "-"}${timeZoneOffsetHours}:${timeZoneOffsetMinutes.toString().padStart(2, "0")}`
		details += `\n\n# Current Time\n${formatter.format(now)} (${timeZone}, UTC${timeZoneOffsetStr})`

		// Add context tokens information
		const { contextTokens, totalCost } = getApiMetrics(this.clineMessages)
		const modelInfo = this.api.getModel().info
		const contextWindow = modelInfo.contextWindow
		const contextPercentage =
			contextTokens && contextWindow ? Math.round((contextTokens / contextWindow) * 100) : undefined
		details += `\n\n# Current Context Size (Tokens)\n${contextTokens ? `${contextTokens.toLocaleString()} (${contextPercentage}%)` : "(Not available)"}`
		details += `\n\n# Current Cost\n${totalCost !== null ? `$${totalCost.toFixed(2)}` : "(Not available)"}`
		// Add current mode and any mode-specific warnings
		const {
			mode,
			customModes,
			customModePrompts,
			experiments = {} as Record<ExperimentId, boolean>,
			customInstructions: globalCustomInstructions,
			language,
		} = (await this.providerRef.deref()?.getState()) ?? {}
		const currentMode = mode ?? defaultModeSlug
		const modeDetails = await getFullModeDetails(currentMode, customModes, customModePrompts, {
			cwd: this.cwd,
			globalCustomInstructions,
			language: language ?? formatLanguage(vscode.env.language),
		})
		details += `\n\n# Current Mode\n`
		details += `<slug>${currentMode}</slug>\n`
		details += `<name>${modeDetails.name}</name>\n`
		if (Experiments.isEnabled(experiments ?? {}, EXPERIMENT_IDS.POWER_STEERING)) {
			details += `<role>${modeDetails.roleDefinition}</role>\n`
			if (modeDetails.customInstructions) {
				details += `<custom_instructions>${modeDetails.customInstructions}</custom_instructions>\n`
			}
		}

		// Add warning if not in code mode
		if (
			!isToolAllowedForMode("write_to_file", currentMode, customModes ?? [], {
				apply_diff: this.diffEnabled,
			}) &&
			!isToolAllowedForMode("apply_diff", currentMode, customModes ?? [], { apply_diff: this.diffEnabled })
		) {
			const currentModeName = getModeBySlug(currentMode, customModes)?.name ?? currentMode
			const defaultModeName = getModeBySlug(defaultModeSlug, customModes)?.name ?? defaultModeSlug
			details += `\n\nNOTE: You are currently in '${currentModeName}' mode, which does not allow write operations. To write files, the user will need to switch to a mode that supports file writing, such as '${defaultModeName}' mode.`
		}

		if (includeFileDetails) {
			details += `\n\n# Current Working Directory (${this.cwd.toPosix()}) Files\n`
			const isDesktop = arePathsEqual(this.cwd, path.join(os.homedir(), "Desktop"))
			if (isDesktop) {
				// don't want to immediately access desktop since it would show permission popup
				details += "(Desktop files not shown automatically. Use list_files to explore if needed.)"
			} else {
				const maxFiles = maxWorkspaceFiles ?? 200
				const [files, didHitLimit] = await listFiles(this.cwd, true, maxFiles)
				const { showRooIgnoredFiles } = (await this.providerRef.deref()?.getState()) ?? {}
				const result = formatResponse.formatFilesList(
					this.cwd,
					files,
					didHitLimit,
					this.rooIgnoreController,
					showRooIgnoredFiles,
				)
				details += result
			}
		}

		return `<environment_details>\n${details.trim()}\n</environment_details>`
	}

	// Checkpoints

	private getCheckpointService() {
		if (!this.enableCheckpoints) {
			return undefined
		}

		if (this.checkpointService) {
			return this.checkpointService
		}

		const log = (message: string) => {
			console.log(message)

			try {
				this.providerRef.deref()?.log(message)
			} catch (err) {
				// NO-OP
			}
		}

		try {
			const workspaceDir = getWorkspacePath()

			if (!workspaceDir) {
				log("[Cline#initializeCheckpoints] workspace folder not found, disabling checkpoints")
				this.enableCheckpoints = false
				return undefined
			}

			const globalStorageDir = this.providerRef.deref()?.context.globalStorageUri.fsPath

			if (!globalStorageDir) {
				log("[Cline#initializeCheckpoints] globalStorageDir not found, disabling checkpoints")
				this.enableCheckpoints = false
				return undefined
			}

			const options: CheckpointServiceOptions = {
				taskId: this.taskId,
				workspaceDir,
				shadowDir: globalStorageDir,
				log,
			}

			// Only `task` is supported at the moment until we figure out how
			// to fully isolate the `workspace` variant.
			// const service =
			// 	this.checkpointStorage === "task"
			// 		? RepoPerTaskCheckpointService.create(options)
			// 		: RepoPerWorkspaceCheckpointService.create(options)

			const service = RepoPerTaskCheckpointService.create(options)

			service.on("initialize", () => {
				try {
					const isCheckpointNeeded =
						typeof this.clineMessages.find(({ say }) => say === "checkpoint_saved") === "undefined"

					this.checkpointService = service

					if (isCheckpointNeeded) {
						log("[Cline#initializeCheckpoints] no checkpoints found, saving initial checkpoint")
						this.checkpointSave()
					}
				} catch (err) {
					log("[Cline#initializeCheckpoints] caught error in on('initialize'), disabling checkpoints")
					this.enableCheckpoints = false
				}
			})

			service.on("checkpoint", ({ isFirst, fromHash: from, toHash: to }) => {
				try {
					this.providerRef.deref()?.postMessageToWebview({ type: "currentCheckpointUpdated", text: to })

					this.say("checkpoint_saved", to, undefined, undefined, { isFirst, from, to }).catch((err) => {
						log("[Cline#initializeCheckpoints] caught unexpected error in say('checkpoint_saved')")
						console.error(err)
					})
				} catch (err) {
					log(
						"[Cline#initializeCheckpoints] caught unexpected error in on('checkpoint'), disabling checkpoints",
					)
					console.error(err)
					this.enableCheckpoints = false
				}
			})

			service.initShadowGit().catch((err) => {
				log("[Cline#initializeCheckpoints] caught unexpected error in initShadowGit, disabling checkpoints")
				console.error(err)
				this.enableCheckpoints = false
			})

			return service
		} catch (err) {
			log("[Cline#initializeCheckpoints] caught unexpected error, disabling checkpoints")
			this.enableCheckpoints = false
			return undefined
		}
	}

	private async getInitializedCheckpointService({
		interval = 250,
		timeout = 15_000,
	}: { interval?: number; timeout?: number } = {}) {
		const service = this.getCheckpointService()

		if (!service || service.isInitialized) {
			return service
		}

		try {
			await pWaitFor(
				() => {
					console.log("[Cline#getCheckpointService] waiting for service to initialize")
					return service.isInitialized
				},
				{ interval, timeout },
			)
			return service
		} catch (err) {
			return undefined
		}
	}

	public async checkpointDiff({
		ts,
		previousCommitHash,
		commitHash,
		mode,
	}: {
		ts: number
		previousCommitHash?: string
		commitHash: string
		mode: "full" | "checkpoint"
	}) {
		const service = await this.getInitializedCheckpointService()

		if (!service) {
			return
		}

		telemetryService.captureCheckpointDiffed(this.taskId)

		if (!previousCommitHash && mode === "checkpoint") {
			const previousCheckpoint = this.clineMessages
				.filter(({ say }) => say === "checkpoint_saved")
				.sort((a, b) => b.ts - a.ts)
				.find((message) => message.ts < ts)

			previousCommitHash = previousCheckpoint?.text
		}

		try {
			const changes = await service.getDiff({ from: previousCommitHash, to: commitHash })

			if (!changes?.length) {
				vscode.window.showInformationMessage("No changes found.")
				return
			}

			await vscode.commands.executeCommand(
				"vscode.changes",
				mode === "full" ? "Changes since task started" : "Changes since previous checkpoint",
				changes.map((change) => [
					vscode.Uri.file(change.paths.absolute),
					vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${change.paths.relative}`).with({
						query: Buffer.from(change.content.before ?? "").toString("base64"),
					}),
					vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${change.paths.relative}`).with({
						query: Buffer.from(change.content.after ?? "").toString("base64"),
					}),
				]),
			)
		} catch (err) {
			this.providerRef.deref()?.log("[checkpointDiff] disabling checkpoints for this task")
			this.enableCheckpoints = false
		}
	}

	public checkpointSave() {
		const service = this.getCheckpointService()

		if (!service) {
			return
		}

		if (!service.isInitialized) {
			this.providerRef
				.deref()
				?.log("[checkpointSave] checkpoints didn't initialize in time, disabling checkpoints for this task")
			this.enableCheckpoints = false
			return
		}

		telemetryService.captureCheckpointCreated(this.taskId)

		// Start the checkpoint process in the background.
		service.saveCheckpoint(`Task: ${this.taskId}, Time: ${Date.now()}`).catch((err) => {
			console.error("[Cline#checkpointSave] caught unexpected error, disabling checkpoints", err)
			this.enableCheckpoints = false
		})
	}

	public async checkpointRestore({
		ts,
		commitHash,
		mode,
	}: {
		ts: number
		commitHash: string
		mode: "preview" | "restore"
	}) {
		const service = await this.getInitializedCheckpointService()

		if (!service) {
			return
		}

		const index = this.clineMessages.findIndex((m) => m.ts === ts)

		if (index === -1) {
			return
		}

		try {
			await service.restoreCheckpoint(commitHash)

			telemetryService.captureCheckpointRestored(this.taskId)

			await this.providerRef.deref()?.postMessageToWebview({ type: "currentCheckpointUpdated", text: commitHash })

			if (mode === "restore") {
				await this.overwriteApiConversationHistory(
					this.apiConversationHistory.filter((m) => !m.ts || m.ts < ts),
				)

				const deletedMessages = this.clineMessages.slice(index + 1)

				const { totalTokensIn, totalTokensOut, totalCacheWrites, totalCacheReads, totalCost } = getApiMetrics(
					combineApiRequests(combineCommandSequences(deletedMessages)),
				)

				await this.overwriteClineMessages(this.clineMessages.slice(0, index + 1))

				// TODO: Verify that this is working as expected.
				await this.say(
					"api_req_deleted",
					JSON.stringify({
						tokensIn: totalTokensIn,
						tokensOut: totalTokensOut,
						cacheWrites: totalCacheWrites,
						cacheReads: totalCacheReads,
						cost: totalCost,
					} satisfies ClineApiReqInfo),
				)
			}

			// The task is already cancelled by the provider beforehand, but we
			// need to re-init to get the updated messages.
			//
			// This was take from Cline's implementation of the checkpoints
			// feature. The cline instance will hang if we don't cancel twice,
			// so this is currently necessary, but it seems like a complicated
			// and hacky solution to a problem that I don't fully understand.
			// I'd like to revisit this in the future and try to improve the
			// task flow and the communication between the webview and the
			// Cline instance.
			this.providerRef.deref()?.cancelTask()
		} catch (err) {
			this.providerRef.deref()?.log("[checkpointRestore] disabling checkpoints for this task")
			this.enableCheckpoints = false
		}
	}
	 
		// --- WebSocket Reply Handler ---
		private handleWebSocketReply = (taskId: string, reply: string): void => {
			// Ensure the reply is for the currently active task this Cline instance manages
			if (taskId === this.taskId && !this.askResponse) { // Check !this.askResponse to see if we are waiting
				this.providerRef.deref()?.log(`[INFO] [Cline ${this.taskId}] Received WebSocket reply: ${reply.substring(0, 50)}...`)
				// Inject the reply as if it came from the webview's primary action
				// Keep as is, ClineAskResponse is an enum used correctly here
				// Pass the string literal "primary" instead of using the type alias as a value
				this.handleWebviewAskResponse("messageResponse", reply)
			} else if (taskId === this.taskId && this.askResponse) {
				this.providerRef.deref()?.log(`[WARN] [Cline ${this.taskId}] Received WebSocket reply but already have a response. Ignoring WebSocket reply.`)
			} else {
				// Log if the reply is for a different task ID (shouldn't happen if client manages connections well)
				this.providerRef.deref()?.log(`[WARN] [Cline ${this.taskId}] Received WebSocket reply for different task ID: ${taskId}. Ignoring.`)
			}
		}
		// --- End WebSocket Reply Handler ---
	 
		// Add a dispose method to clean up listeners
		public dispose(): void {
			this.providerRef.deref()?.log(`[INFO] [Cline ${this.taskId}] Disposing Cline instance.`)
			this.webSocketClient?.off("replyReceived", this.handleWebSocketReply) // Unregister listener
			this.removeAllListeners() // Remove listeners from EventEmitter
			// Any other cleanup needed
		}
}

function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
