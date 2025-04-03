import os
import logging
import asyncio
import json
import time
from typing import Dict, Any, Optional

import telegram
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    filters,
    ContextTypes
)
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# Import necessary libraries
import websockets # For exception handling
# Removed import from run_bot to break circular dependency
from config import IPC_BASE_DIR # Import to potentially use for path
 
# Define the path for the registration file
# Use IPC_BASE_DIR if available, otherwise current dir
REGISTRATION_DIR = IPC_BASE_DIR or os.path.dirname(__file__)
REGISTRATION_FILE = os.path.join(REGISTRATION_DIR, 'registrations.json')

# Define the structure for the reply message payload (optional but good practice)
from typing import TypedDict

class ReplyMessage(TypedDict):
    type: str
    taskId: str
    reply: str
class RooCodeNotificationSystem:
    def __init__(self,
                 telegram_token: str,
                 logger: logging.Logger, # Added logger parameter
                 websocket_send_func: callable, # Added function parameter for sending WS messages
                 max_retries: int = 3,
                 backoff_factor: float = 0.3):
        """
        Initialize Telegram notification system for Roo code instances using WebSockets.
 
        :param telegram_token: Bot API token
        :param logger: Logger instance for logging.
        :param websocket_send_func: An async function to send a string message over the WebSocket.
        :param max_retries: Maximum number of retries for network requests
        :param backoff_factor: Backoff factor for exponential backoff
        """
        self.bot_token = telegram_token
        self.application = Application.builder().token(self.bot_token).build()
        self.bot = self.application.bot

        self.logger = logger # Store logger instance
        self.websocket_send_func = websocket_send_func # Store the send function

        self.session = requests.Session()
        # Configure retries for HTTP requests (e.g., to Telegram API)
        retry_strategy = Retry(
            total=max_retries,
            backoff_factor=backoff_factor,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["HEAD", "GET", "OPTIONS", "POST"] # Include POST if needed
        )
        adapter = HTTPAdapter(max_retries=retry_strategy)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)


        # --- State Management ---
        # Maps taskId from VS Code to the Telegram chat_id registered for notifications
        self.registration_file = REGISTRATION_FILE
        self.task_to_chat_mapping: Dict[str, int] = {}
        self._load_registrations() # Load existing registrations on init
        # Stores pending questions awaiting a reply from a specific chat
        # Maps chat_id -> {taskId} (instanceId might not be needed here)
        self.pending_telegram_responses: Dict[int, Dict[str, str]] = {}
        # --- End State Management ---

        # Logger is now passed in via __init__

    # --- Registration based on Task ID ---
    def register_task_for_chat(self, task_id: str, chat_id: int):
        """ Registers a specific Roo-Code task ID to a Telegram chat ID """
        self.task_to_chat_mapping[task_id] = chat_id
        self.logger.info(f"Registered Task ID '{task_id}' to Chat ID {chat_id}")
        self._save_registrations() # Save after registering

    def unregister_task(self, task_id: str):
        """ Removes a task ID mapping """
        if task_id in self.task_to_chat_mapping:
            removed_chat_id = self.task_to_chat_mapping.pop(task_id)
            self.logger.info(f"Unregistered Task ID '{task_id}' from Chat ID {removed_chat_id}")
            self._save_registrations() # Save after unregistering
            # Also clear any pending response for this chat if the task is unregistered while waiting
            if removed_chat_id in self.pending_telegram_responses:
                 if self.pending_telegram_responses[removed_chat_id].get("taskId") == task_id:
                     del self.pending_telegram_responses[removed_chat_id]
                     self.logger.info(f"Cleared pending response for Chat ID {removed_chat_id} as Task '{task_id}' was unregistered.")
            return True
        return False

    async def send_telegram_message(self, chat_id: int, message: str):
        """ Sends a message via Telegram """
        try:
            await self.bot.send_message(chat_id=chat_id, text=message)
            self.logger.info(f"Telegram message sent to chat_id {chat_id}")
            return True
        except telegram.error.Forbidden as e:
             self.logger.error(f"Failed to send Telegram message to {chat_id}: Bot blocked by user or chat not found. {e}")
             # Consider unregistering the chat/task here if the bot is blocked
             # Find task ID associated with this chat_id and call self.unregister_task()
             task_id_to_remove = None
             for tid, cid in self.task_to_chat_mapping.items():
                 if cid == chat_id:
                     task_id_to_remove = tid
                     break
             if task_id_to_remove:
                 self.unregister_task(task_id_to_remove)
             return False
        except Exception as e:
            self.logger.error(f"Failed to send Telegram message to {chat_id}: {e}", exc_info=True)
            return False

    # --- Process Incoming Questions from VS Code Extension (via WebSocket) ---
    async def process_incoming_websocket_notification(self, task_id: str, question: str, suggestions: Any):
        """ Processes a question received via WebSocket from the VS Code extension """
        self.logger.info(f"Processing incoming WebSocket notification for Task ID: {task_id}")

        # Find the chat_id associated with this task_id
        chat_id = self.task_to_chat_mapping.get(task_id)

        if not chat_id:
            self.logger.warning(f"Received notification for unregistered Task ID '{task_id}'. Ignoring.")
            # Optionally send an error back via WebSocket if the connection is still active?
            return

        # Check if already waiting for a response from this chat
        if chat_id in self.pending_telegram_responses:
            self.logger.warning(f"Received a new question for Chat ID {chat_id} (Task: {task_id}) while already waiting for a response. Overwriting previous pending question.")
            # Overwriting previous state

        # Store pending state (mapping chat_id back to task_id)
        self.pending_telegram_responses[chat_id] = {"taskId": task_id}
        self.logger.info(f"Stored pending response state for Chat ID {chat_id} (Task: {task_id})")

        # Format message for Telegram
        formatted_message = f"Roo-Code Task ({task_id[:8]}...):\n\n{question}"
        if suggestions and isinstance(suggestions, list): # Check if suggestions exist and are a list
            formatted_message += "\n\nSuggestions:"
            # Assuming suggestions are strings or can be converted to strings
            for i, sug in enumerate(suggestions):
                try:
                    # Handle potential complex suggestion structures (e.g., objects)
                    if isinstance(sug, dict) and 'suggest' in sug:
                        sug_text = sug['suggest']
                    else:
                        sug_text = str(sug)
                    formatted_message += f"\n{i+1}. {sug_text}"
                except Exception as e:
                    self.logger.warning(f"Could not format suggestion {i+1}: {sug} - Error: {e}")
                    formatted_message += f"\n{i+1}. [Error formatting suggestion]"

            formatted_message += "\n\nPlease reply with your answer."
        else:
            formatted_message += "\n\nPlease reply with your answer."

        # Send the question to the user via Telegram
        await self.send_telegram_message(chat_id, formatted_message)

    # --- Process Responses from Telegram User ---
    async def handle_telegram_response(self, chat_id: int, response_text: str):
        """
        Process a response received via Telegram and forward it to the
        correct VS Code extension instance via WebSocket.
        """
        # No longer need global active_websocket, use self.websocket_send_func

        # Check if we are waiting for a response from this chat
        pending_info = self.pending_telegram_responses.pop(chat_id, None)

        if not pending_info:
            self.logger.info(f"Received response from Chat ID {chat_id}, but no question was pending. Ignoring.")
            # await self.send_telegram_message(chat_id, "I wasn't waiting for a response from you right now.")
            return False

        task_id = pending_info['taskId']
        self.logger.info(f"Processing response for Task ID '{task_id}' from Chat ID {chat_id}")

        # Construct the response payload for the VS Code extension
        reply_payload: ReplyMessage = {
            'type': 'reply',
            'taskId': task_id,
            'reply': response_text,
            # 'timestamp': time.time() # Timestamp can be added if needed
        }
        reply_payload_str = json.dumps(reply_payload)

        # Send the response back via the provided WebSocket send function
        try:
            # Use the injected send function
            await self.websocket_send_func(reply_payload_str)
            self.logger.info(f"WebSocket reply successfully sent for Task ID '{task_id}'") # Corrected indentation
            return True
            # The send function itself should handle specific websocket exceptions if needed,
            # but we catch general exceptions here.
 
        except Exception as e: # Catch potential errors during the send_func call
            self.logger.error(f"Error calling websocket_send_func for Task ID '{task_id}': {e}", exc_info=True)
            self.pending_telegram_responses[chat_id] = pending_info # Put back if send failed
            # Notify user about the error
            await self.send_telegram_message( # Corrected indentation
                chat_id,
                f"Error: Could not deliver your response for Task '{task_id[:8]}...'. An unexpected error occurred."
            )
            return False


    # Removed _ipc_listener_task, _process_ipc_payload, _write_response_file

    async def start_services(self):
        """ Start the Telegram bot polling """
        # Register handlers
        self.application.add_handler(CommandHandler("start", self.start_command))
        self.application.add_handler(CommandHandler("register", self.register_command))
        # Add unregister command
        self.application.add_handler(CommandHandler("unregister", self.unregister_command))
        self.application.add_handler(MessageHandler(
            filters.TEXT & ~filters.COMMAND,
            self.handle_telegram_message_input
        ))

        # Start the bot polling
        await self.application.initialize()
        await self.application.start()
        await self.application.updater.start_polling()
        self.logger.info("Telegram bot started polling.")

        # Removed IPC listener start


    async def start_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """ Handle /start command """
        await update.message.reply_text(
            "Welcome to the Roo-Code Telegram Bridge!\n"
            "Use /register <task_id> to link this chat to a specific Roo-Code task.\n"
            "Use /unregister <task_id> to remove the link.\n"
            "You can get the Task ID from the Roo-Code interface in VS Code."
        )

    async def register_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """ Handle /register command to link a Roo-Code Task ID to this chat """
        if not context.args or len(context.args) == 0:
            await update.message.reply_text(
                "Please provide the Roo-Code Task ID.\n"
                "Usage: /register <task_id>"
            )
            return

        task_id = context.args[0]
        chat_id = update.effective_chat.id

        # Register the mapping
        self.register_task_for_chat(task_id, chat_id)

        await update.message.reply_text(
            f"Roo-Code Task ID '{task_id}' is now linked to this chat ({chat_id}). "
            f"You will receive prompts for this task here."
        )

    async def unregister_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
         """ Handle /unregister command to remove a Roo-Code Task ID link """
         if not context.args or len(context.args) == 0:
             await update.message.reply_text(
                 "Please provide the Roo-Code Task ID to unregister.\n"
                 "Usage: /unregister <task_id>"
             )
             return

         task_id = context.args[0]
         chat_id = update.effective_chat.id # Get chat_id for confirmation message

         # Check if this task is actually registered to this chat before unregistering
         if self.task_to_chat_mapping.get(task_id) != chat_id:
              await update.message.reply_text(
                  f"Task ID '{task_id}' is not currently linked to *this* chat."
              )
              return

         # Unregister the mapping
         if self.unregister_task(task_id):
             await update.message.reply_text(
                 f"Roo-Code Task ID '{task_id}' has been unlinked from this chat."
             )
         else:
             # This case should ideally not happen if the check above works, but good to have
             await update.message.reply_text(
                 f"Could not find Task ID '{task_id}' to unregister."
             )


    async def handle_telegram_message_input(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """ Handle incoming text messages from Telegram user (potential responses) """
        chat_id = update.effective_chat.id
        response_text = update.message.text

        # Check if this chat has a pending question
        if chat_id not in self.pending_telegram_responses:
            self.logger.info(f"Received message from Chat ID {chat_id}, but no question was pending.")
            await update.message.reply_text(
                "Thanks for your message! I wasn't waiting for a response from you right now. "
                "Use /register <task_id> to link a Roo-Code task."
            )
            return

        # Process the response text
        self.logger.info(f"Received potential response '{response_text}' from chat {chat_id}")

        success = await self.handle_telegram_response(
            chat_id,
            response_text
        )

        if success:
            await update.message.reply_text(
                f"Your response has been sent to the Roo-Code task."
            )
        # Error message is handled within handle_telegram_response now
    # --- Persistence Methods ---

    def _load_registrations(self):
        """ Loads registered task-to-chat mappings from the JSON file """
        try:
            if os.path.exists(self.registration_file):
                with open(self.registration_file, 'r') as f:
                    loaded_data = json.load(f)
                    # Basic validation: check if it's a dictionary
                    if isinstance(loaded_data, dict):
                         # Ensure keys are strings and values are integers
                         self.task_to_chat_mapping = {
                             str(k): int(v) for k, v in loaded_data.items()
                             if isinstance(k, str) and isinstance(v, (int, str)) and str(v).isdigit()
                         }
                         self.logger.info(f"Loaded {len(self.task_to_chat_mapping)} valid registrations from {self.registration_file}")
                    else:
                         self.logger.warning(f"Data in {self.registration_file} is not a dictionary. Starting fresh.")
                         self.task_to_chat_mapping = {}

            else:
                self.logger.info(f"Registration file {self.registration_file} not found. Starting fresh.")
                self.task_to_chat_mapping = {}
        except json.JSONDecodeError:
            self.logger.error(f"Error decoding JSON from {self.registration_file}. Starting with empty registrations.", exc_info=True)
            self.task_to_chat_mapping = {}
        except Exception as e:
            self.logger.error(f"Failed to load registrations from {self.registration_file}: {e}", exc_info=True)
            self.task_to_chat_mapping = {}

    def _save_registrations(self):
        """ Saves the current task-to-chat mappings to the JSON file """
        try:
            # Ensure the directory exists
            os.makedirs(os.path.dirname(self.registration_file), exist_ok=True)
            with open(self.registration_file, 'w') as f:
                json.dump(self.task_to_chat_mapping, f, indent=4)
            self.logger.debug(f"Saved {len(self.task_to_chat_mapping)} registrations to {self.registration_file}")
        except Exception as e:
            self.logger.error(f"Failed to save registrations to {self.registration_file}: {e}", exc_info=True)

