Solution 1: Keep the Bot Running

You need to keep the main thread alive after starting the bot. The python-telegram-bot library is designed to run continuously. Add a line to run_bot.py to wait indefinitely.

File: run_bot.py (Modification)

import asyncio
import os
import sys
import logging
from telegram_notification_system import RooCodeNotificationSystem
from ipc_communication import IPCManager
from config import TELEGRAM_BOT_TOKEN, IPC_BASE_DIR

async def main():
    # Configure logging
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    logger = logging.getLogger(__name__)

    try:
        # Initialize IPC Manager
        ipc_manager = IPCManager(base_dir=IPC_BASE_DIR)
        logger.info("IPC Manager initialized")

        # Initialize Telegram Notification System
        # *** Pass the ipc_manager to the notification system ***
        notification_system = RooCodeNotificationSystem(
            telegram_token=TELEGRAM_BOT_TOKEN,
            ipc_manager=ipc_manager # <-- Add this
        )
        logger.info("Telegram Notification System initialized")

        # Start the Telegram bot and the IPC listener
        # *** We'll modify start_bot to handle both ***
        await notification_system.start_services() # <-- Changed method name for clarity

        # Keep the main coroutine alive indefinitely
        logger.info("Bot and IPC listener running. Press Ctrl+C to stop.")
        await asyncio.Future()  # This will wait forever

    except Exception as e:
        logger.error(f"Error in main application: {e}", exc_info=True) # Added exc_info for better debugging
        sys.exit(1)
    except KeyboardInterrupt:
        logger.info("Shutdown requested.")
        # Optional: Add cleanup code here if needed
        sys.exit(0)


if __name__ == '__main__':
    # Handle potential RuntimeErrors on Windows when stopping with Ctrl+C
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Bot stopped.")
    except RuntimeError as e:
        if "Event loop is closed" in str(e):
            print("Event loop closed forcefully.")
        else:
            raise e
Use code with caution.
Python
Analysis of the Communication Flow (Deeper Issues)

Even after fixing the exit issue, your current code has logical gaps in the communication flow:

Roo Code -> Bot (Notification):

roo_code_integration.py calls ipc_manager.send_message(project_name, notification). This writes a message to project_name_message.json.

Problem: The Bot process (run_bot.py/telegram_notification_system.py) is not actively listening for these files. It only reacts to Telegram messages.

Bot -> Roo Code (Response):

When you send a message to the bot on Telegram, handle_message in telegram_notification_system.py calls handle_response.

handle_response currently writes the response to a different file ({project_name}_response.txt).

Problem: The Roo code process (roo_code_integration.py) is calling ipc_manager.receive_message(project_name), which looks for project_name_message.json, not {project_name}_response.txt. The response is never received by the Roo code.

Solution 2: Implement Full Two-Way Communication

We need to:

Make the Bot process poll for IPC messages from the Roo code.

Make the Bot process use the same IPC mechanism (ipc_manager.send_message) to send responses back to the Roo code.

Handle potential blocking issues with file I/O in the async bot.

File: telegram_notification_system.py (Modifications)

import os
import logging
import asyncio
import json # <-- Make sure json is imported
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

# Import IPCManager to use it within the bot system
from ipc_communication import IPCManager

class RooCodeNotificationSystem:
    def __init__(self,
                 telegram_token: str,
                 ipc_manager: IPCManager, # <-- Receive IPCManager instance
                 max_retries: int = 3,
                 backoff_factor: float = 0.3):
        """
        Initialize Telegram notification system for Roo code instances

        :param telegram_token: Bot API token
        :param ipc_manager: Instance of the IPCManager for communication
        :param max_retries: Maximum number of retries for network requests
        :param backoff_factor: Backoff factor for exponential backoff
        """
        self.bot_token = telegram_token
        self.application = Application.builder().token(self.bot_token).build() # Store application instance
        self.bot = self.application.bot # Get bot from application

        # *** Store the IPC Manager ***
        self.ipc_manager = ipc_manager

        self.session = requests.Session()
        # ... (rest of session setup remains the same) ...

        self.active_instances: Dict[str, Dict[str, Any]] = {}
        # Store pending step_ids awaiting response for each project
        self.pending_steps: Dict[str, str] = {}

        logging.basicConfig(
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            level=logging.INFO
        )
        self.logger = logging.getLogger(__name__)

    def register_instance(self,
                          project_name: str,
                          chat_id: int,
                          additional_info: Dict[str, Any] = None):
        """ Registers a Roo code instance and starts listening for its IPC messages """
        if project_name in self.active_instances:
             self.logger.warning(f"Project {project_name} already registered. Updating chat ID.")
        instance_info = {
            'chat_id': chat_id,
            'last_interaction': None,
            'status': 'active',
            'additional_info': additional_info or {}
        }
        self.active_instances[project_name] = instance_info
        self.logger.info(f"Registered instance: {project_name} for chat_id {chat_id}")

        # *** Start listening for IPC messages for this specific project ***
        # We will do this centrally in start_services now


    async def send_telegram_message(self,
                                   chat_id: int,
                                   message: str):
        """ Sends a message via Telegram """
        try:
            await self.bot.send_message(
                chat_id=chat_id,
                text=message
            )
            self.logger.info(f"Telegram message sent to chat_id {chat_id}")
            return True
        except Exception as e:
            self.logger.error(f"Failed to send Telegram message to {chat_id}: {e}")
            return False

    # Rename original send_notification slightly to avoid confusion
    async def process_incoming_ipc_notification(self,
                                project_name: str,
                                notification: Dict[str, Any]):
        """ Processes a notification received via IPC from Roo Code """
        if project_name not in self.active_instances:
            self.logger.warning(f"Received IPC for unregistered project {project_name}. Ignoring.")
            return

        instance = self.active_instances[project_name]
        chat_id = instance['chat_id']
        message = notification.get('message', 'Received unnamed notification.')
        step_id = notification.get('step_id')

        # Store the step_id expecting a response
        if step_id:
             self.pending_steps[project_name] = step_id
             self.logger.info(f"Stored pending step_id '{step_id}' for project '{project_name}'")
        else:
             # If a new notification comes without step_id, clear any pending one
             if project_name in self.pending_steps:
                 del self.pending_steps[project_name]

        # Send the notification to the user via Telegram
        await self.send_telegram_message(chat_id, f"Project '{project_name}':\n{message}")

        # Update instance metadata (optional)
        instance['last_interaction'] = {
            'type': 'ipc_notification_received',
            'message': message,
            'step_id': step_id,
            'timestamp': asyncio.get_event_loop().time()
        }

    async def handle_telegram_response(self,
                              project_name: str,
                              response_text: str):
        """
        Process a response received via Telegram and forward it to the
        appropriate Roo code instance via IPC.
        """
        if project_name not in self.active_instances:
            self.logger.warning(f"Cannot handle response for unregistered project {project_name}")
            return False

        # Retrieve the step_id if one was pending for this project
        step_id = self.pending_steps.pop(project_name, None) # Remove step_id once response is handled

        # Construct the response message for IPC
        ipc_response = {
            'response': response_text,
            'step_id': step_id,
             # Add other relevant info if needed, e.g., timestamp
            'timestamp': time.time()
        }

        self.logger.info(f"Sending IPC response to project '{project_name}': {ipc_response}")

        # *** Send the response back using IPCManager ***
        # Use a unique identifier for the response message channel,
        # perhaps by convention (e.g., project_name + "_response")
        # OR, more simply, the Roo code waits for *any* message on its own channel
        # Let's assume the Roo code waits on its *own* project_name channel
        # The IPCManager currently overwrites messages. This might need refinement
        # if multiple messages need queuing, but for request-response it might be ok.

        # IMPORTANT: The IPC send/receive are BLOCKING. Run them in a threadpool.
        try:
            # We need the loop to run blocking function in thread
            loop = asyncio.get_running_loop()
            # The target instance_name for sending the response *back* IS the project_name
            # The RooCodeController is waiting on its own project_name.
            send_successful = await loop.run_in_executor(
                None, # Use default executor (ThreadPoolExecutor)
                self.ipc_manager.send_message,
                project_name, # Target instance name IS the project name
                ipc_response
            )

            if send_successful:
                self.logger.info(f"IPC response successfully sent to {project_name}")
                return True
            else:
                self.logger.error(f"Failed to send IPC response to {project_name} (timeout or lock issue)")
                # Maybe notify the user the response couldn't be delivered?
                await self.send_telegram_message(
                    self.active_instances[project_name]['chat_id'],
                    f"Error: Could not deliver your response to project '{project_name}'. The process might be busy or unresponsive."
                )
                return False
        except Exception as e:
            self.logger.error(f"Exception while sending IPC response for {project_name}: {e}", exc_info=True)
            return False


    async def _ipc_listener_task(self):
        """ Background task to continuously listen for IPC messages """
        self.logger.info("IPC Listener Task started.")
        registered_projects = list(self.active_instances.keys()) # Initial list

        while True:
            # Check for newly registered projects periodically
            current_projects = list(self.active_instances.keys())
            if current_projects != registered_projects:
                 self.logger.info(f"IPC Listener detected change in registered projects: {current_projects}")
                 registered_projects = current_projects

            if not registered_projects:
                await asyncio.sleep(5) # Sleep if no projects are registered
                continue

            for project_name in registered_projects:
                # IMPORTANT: The IPC receive is BLOCKING. Run it in a threadpool.
                try:
                    loop = asyncio.get_running_loop()
                    # We check for messages intended *for the bot* from a specific project.
                    # Let's use a convention: messages *from* RooCode *to* Bot use project_name + "_notify"
                    # Modify RooCodeController to send to this channel name.
                    # *** OR *** simpler: keep using project_name, but manage file clearing.
                    # Let's stick to the original for now: RooCode sends on project_name.
                    # The Bot needs to read it and clear it.
                    ipc_message_data = await loop.run_in_executor(
                        None, # Use default executor
                        self.ipc_manager.receive_message,
                        project_name, # Check the channel named after the project
                        timeout=0.1, # Short timeout, non-blocking poll
                        remove_after_read=True # Bot reads and removes the notification
                    )

                    if ipc_message_data:
                        self.logger.info(f"Received IPC message for {project_name}: {ipc_message_data}")
                        # Process the received notification
                        await self.process_incoming_ipc_notification(project_name, ipc_message_data)

                except Exception as e:
                    # Log errors but keep the listener running
                    self.logger.error(f"Error in IPC listener loop for {project_name}: {e}", exc_info=True)

            await asyncio.sleep(1) # Poll every second (adjust as needed)


    async def start_services(self):
        """ Start the Telegram bot and the IPC listener task """
        # Register handlers
        self.application.add_handler(CommandHandler("start", self.start_command))
        self.application.add_handler(CommandHandler("register", self.register_command))
        self.application.add_handler(MessageHandler(
            filters.TEXT & ~filters.COMMAND,
            self.handle_telegram_message_input # Renamed for clarity
        ))

        # Start the bot
        await self.application.initialize()
        await self.application.start()
        # Start polling in the background
        await self.application.updater.start_polling()
        self.logger.info("Telegram bot started polling.")

        # Start the IPC listener as a background task
        asyncio.create_task(self._ipc_listener_task())


    async def start_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """ Handle /start command """
        await update.message.reply_text(
            "Welcome to RooCode Bot! "
            "Use /register <project_name> to link this chat to your Roo code instance."
        )

    async def register_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """ Handle /register command to add/update a Roo code instance link """
        if not context.args or len(context.args) == 0:
            await update.message.reply_text(
                "Please provide a project name. "
                "Usage: /register <project_name>"
            )
            return

        project_name = context.args[0]
        chat_id = update.effective_chat.id

        self.register_instance(
            project_name,
            chat_id,
            {'registered_by': update.effective_user.username}
        )

        await update.message.reply_text(
            f"Project '{project_name}' registered to this chat ({chat_id})!"
        )

    async def handle_telegram_message_input(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """ Handle incoming text messages from Telegram user """
        chat_id = update.effective_chat.id
        project_name = self._find_project_by_chat_id(chat_id)

        if not project_name:
            await update.message.reply_text(
                "This chat is not registered to any project. "
                "Use /register <project_name> first."
            )
            return

        # Check if we were actually expecting a response for this project
        if project_name not in self.pending_steps:
             await update.message.reply_text(
                 f"Received text for '{project_name}', but wasn't actively waiting for input for a specific step."
                 # Decide if you still want to forward it or just inform the user.
                 # Let's forward it anyway for flexibility.
             )
             # pass # Continue to handle_telegram_response

        # Process the response text
        response_text = update.message.text
        self.logger.info(f"Received Telegram message '{response_text}' for project '{project_name}' from chat {chat_id}")

        success = await self.handle_telegram_response(
            project_name,
            response_text
        )

        if success:
            await update.message.reply_text(
                f"Your response has been sent to project '{project_name}'."
            )
        # Error message is handled within handle_telegram_response now


    def _find_project_by_chat_id(self, chat_id: int) -> Optional[str]:
        """ Find a project name by its chat ID """
        for project, details in self.active_instances.items():
            if details['chat_id'] == chat_id:
                return project
        return None

# Need time for timestamps in handle_telegram_response
import time
Use code with caution.
Python
File: roo_code_integration.py (Minor Change - Optional but Recommended)

The wait_for_response currently uses receive_message which might instantly return None if the bot hasn't replied yet. It might be better to have it wait longer or poll. Also, make sure it clears the message file after reading.

import asyncio
import time # Import time
from ipc_communication import IPCManager

class RooCodeController:
    def __init__(self, project_name):
        self.project_name = project_name
        # Use the same base dir as the bot for consistency
        # (Ideally get from config or environment variable)
        self.ipc_manager = IPCManager(base_dir='/tmp/roocode_ipc') # Or get from config

    async def send_step_notification(self, message, step_id=None):
        """
        Send a notification about a processing step TO the bot process.
        """
        notification = {
            'project_name': self.project_name, # Good practice to include sender
            'message': message,
            'step_id': step_id
        }

        # Send via IPC - Target is the project name channel
        # The bot listener will pick this up.
        send_result = self.ipc_manager.send_message(
            self.project_name, # Use project_name as the channel identifier
            notification
        )

        if send_result:
            print(f"Notification sent: {message}")
        else:
            print(f"Failed to send notification (IPC lock/timeout)")


    def wait_for_response(self, wait_timeout=600): # Add a longer timeout (e.g., 10 minutes)
        """
        Wait for a response from the Telegram bot via IPC.
        Polls the IPC channel until a response is received or timeout occurs.
        """
        print(f"Waiting for response via IPC on channel '{self.project_name}'...")
        start_time = time.time()
        while time.time() - start_time < wait_timeout:
            # Check for message on our project channel (sent by the bot)
            # Ensure remove_after_read is True to consume the response
            response_data = self.ipc_manager.receive_message(
                self.project_name,
                timeout=0.5, # Short lock timeout per attempt
                remove_after_read=True # Consume the response message
                )

            if response_data:
                print(f"Received response via IPC: {response_data}")
                # Basic check if it looks like a response payload
                if isinstance(response_data, dict) and 'response' in response_data:
                     return response_data # Return the full payload
                else:
                     # Got a message, but not the expected format. Might be a leftover notification. Log it.
                     print(f"WARNING: Received unexpected data on response channel: {response_data}")
                     # Continue waiting

            # Wait a bit before polling again
            time.sleep(2) # Poll every 2 seconds

        print("Timeout waiting for response.")
        return None

# Example workflow
async def example_roo_code_workflow():
    # Initialize the controller for a specific project
    controller = RooCodeController('my_awesome_project')

    # Simulate a processing step
    print("Simulating step 1...")
    await asyncio.sleep(5) # Simulate work
    print("Step 1 done. Sending notification.")

    await controller.send_step_notification(
        "Data preprocessing completed. Please reply with 'proceed' or 'abort'.",
        step_id="preprocessing_step"
    )

    # Wait for user response
    response = controller.wait_for_response(wait_timeout=120) # Wait for 2 minutes

    if response:
        print("Processing received response:", response)
        user_reply = response.get('response', '').lower()
        received_step_id = response.get('step_id')

        if received_step_id == "preprocessing_step":
            if user_reply == 'proceed':
                print("User chose to proceed. Simulating next step...")
                await asyncio.sleep(5)
                print("Next step finished.")
                await controller.send_step_notification("Processing finished successfully!")
            else:
                print("User chose to abort.")
                await controller.send_step_notification("Processing aborted by user.")
        else:
            print(f"Received response, but step_id '{received_step_id}' doesn't match expected 'preprocessing_step'. Ignoring.")

    else:
        print("No response received within timeout. Proceeding with default or aborting...")
        # Add logic here for timeout case
        await controller.send_step_notification("Timeout waiting for user input. Aborting.")


# Run the example
if __name__ == '__main__':
    # NOTE: Running this example workflow requires the bot (run_bot.py)
    # to be running simultaneously in a separate process.
    # 1. Start `python run_bot.py`
    # 2. Register the project in Telegram: /register my_awesome_project
    # 3. Run `python roo_code_integration.py`
    try:
        asyncio.run(example_roo_code_workflow())
    except KeyboardInterrupt:
        print("\nRoo Code workflow interrupted.")
Use code with caution.
Python
Summary of Changes and How to Run:

run_bot.py: Keeps the script alive using await asyncio.Future() and passes the IPCManager to the RooCodeNotificationSystem. Changed start_bot call to start_services.

telegram_notification_system.py:

Accepts and stores the IPCManager.

start_services now starts the bot and the _ipc_listener_task.

_ipc_listener_task: Runs in the background, polling for IPC messages using ipc_manager.receive_message (run in a threadpool executor). When a message is found, it calls process_incoming_ipc_notification.

process_incoming_ipc_notification: Sends the message content to the user via Telegram and stores step_id if present.

handle_telegram_message_input: Triggered by user messages in Telegram. Finds the project, retrieves pending step_id.

handle_telegram_response: Constructs the response payload and uses ipc_manager.send_message (in a threadpool executor) to send it back to the Roo code process on its project_name channel.

Uses asyncio.get_running_loop().run_in_executor to run the blocking ipc_manager calls in separate threads, preventing the bot's event loop from freezing.

Keeps track of pending_steps to associate responses with notifications.

roo_code_integration.py:

wait_for_response now polls repeatedly using receive_message with remove_after_read=True until a response is found or it times out.

The example workflow demonstrates sending a notification and waiting for a specific reply.

To Run:

Open two separate terminals or command prompts in your project directory.

Terminal 1: Run the bot: python run_bot.py

Wait for the bot to log "Bot and IPC listener running..."

Go to Telegram: Find your bot.

Send /start (optional).

Send /register my_awesome_project (using the project name from the example). The bot should confirm registration.

Terminal 2: Run the example Roo code simulation: python roo_code_integration.py

Observe:

Terminal 2 will print "Simulating step 1...", wait, then "Step 1 done. Sending notification.".

Terminal 1 (Bot logs) should show it received an IPC message and sent a Telegram message.

Your Telegram client should receive the message: "Project 'my_awesome_project': Data preprocessing completed. Please reply with 'proceed' or 'abort'."

Terminal 2 will print "Waiting for response...".

Go to Telegram: Reply to the bot with proceed (or abort).

Observe:

Terminal 1 (Bot logs) should show it received the Telegram message and sent an IPC response.

Terminal 2 should print "Received response via IPC: ...", process it, and continue or abort based on your reply. It will then send a final status notification.

Your Telegram client should receive the final status message (e.g., "Processing finished successfully!").

This revised structure provides the necessary two-way communication loop using your file-based IPC mechanism, while keeping the asynchronous Telegram bot responsive. Remember that file-based IPC with locking can be slow and platform-dependent (msvcrt is Windows-only). For more complex or cross-platform needs, consider sockets or message queues (like ZeroMQ, RabbitMQ).

80.8s
the bot output:

G:_OneDrive\OneDrive\Desktop\Py Apps\rootelegram>python run_bot.py
2025-03-26 12:54:56,773 - main - INFO - IPC Manager initialized
2025-03-26 12:54:57,173 - main - INFO - Telegram Notification System initialized
2025-03-26 12:54:57,926 - httpx - INFO - HTTP Request: POST https://api.telegram.org/bot7665681465:AAGXWxzA10GcaMA44PA4nAr5UEMmOuCkNg0/getMe "HTTP/1.1 200 OK"
2025-03-26 12:54:57,927 - telegram.ext.Application - INFO - Application started
2025-03-26 12:54:58,179 - httpx - INFO - HTTP Request: POST https://api.telegram.org/bot7665681465:AAGXWxzA10GcaMA44PA4nAr5UEMmOuCkNg0/deleteWebhook "HTTP/1.1 200 OK"
2025-03-26 12:54:58,179 - telegram_notification_system - INFO - Telegram bot started polling.
2025-03-26 12:54:58,180 - main - INFO - Bot and IPC listener running. Press Ctrl+C to stop.
2025-03-26 12:54:58,180 - telegram_notification_system - INFO - IPC Listener Task started.
2025-03-26 12:55:08,910 - httpx - INFO - HTTP Request: POST https://api.telegram.org/bot7665681465:AAGXWxzA10GcaMA44PA4nAr5UEMmOuCkNg0/getUpdates "HTTP/1.1 200 OK"
2025-03-26 12:55:19,158 - httpx - INFO - HTTP Request: POST https://api.telegram.org/bot7665681465:AAGXWxzA10GcaMA44PA4nAr5UEMmOuCkNg0/getUpdates "HTTP/1.1 200 OK"
2025-03-26 12:55:29,410 - httpx - INFO - HTTP Request: POST https://api.telegram.org/bot7665681465:AAGXWxzA10GcaMA44PA4nAr5UEMmOuCkNg0/getUpdates "HTTP/1.1 200 OK"
2025-03-26 12:55:39,650 - httpx - INFO - HTTP Request: POST https://api.telegram.org/bot7665681465:AAGXWxzA10GcaMA44PA4nAr5UEMmOuCkNg0/getUpdates "HTTP/1.1 200 OK"

the roo code integration

G:_OneDrive\OneDrive\Desktop\Py Apps\rootelegram>roo_code_integration.py
Simulating step 1...
Step 1 done. Sending notification.
Notification sent: Data preprocessing completed. Please reply with 'proceed' or 'abort'.
Waiting for response via IPC on channel 'my_awesome_project'...
Received response via IPC: {'project_name': 'my_awesome_project', 'message': "Data preprocessing completed. Please reply with 'proceed' or 'abort'.", 'step_id': 'preprocessing_step'}
WARNING: Received unexpected data on response channel: {'project_name': 'my_awesome_project', 'message': "Data preprocessing completed. Please reply with 'proceed' or 'abort'.", 'step_id': 'preprocessing_step'}

what im not understanding is, wouldnt we need to do something on roo or vcs to integrate it with roo?

warning
Thoughts
*The thoughts produced by the model are experimental
experiment











































Expand to view model thoughts
20.0s
You've hit on two key points!

The IPC Mix-up: Your analysis of the output is spot on. The roo_code_integration.py script sends a message and then immediately reads that same message back because both processes are using the exact same file (my_awesome_project_message.json) for communication in both directions. The bot likely never even sees the notification because the Roo code script reads and removes the file too quickly.

The "Roo" Integration: You are absolutely right. The roo_code_integration.py file, as it stands, is just a simulation or a template. It doesn't actually interact with any specific "Roo" or "VCS" (like RVC) application yet. You do need to integrate this notification logic into your actual processing workflow.

Let's fix the IPC mix-up first, then discuss how to integrate it.

Fixing the IPC Communication Channels

We need separate "channels" (which in this file-based IPC means separate filenames) for messages going from Roo Code to the Bot, and messages going from the Bot back to Roo Code.

Changes:

roo_code_integration.py:

When sending a notification, use a name like project_name_notify.

When waiting for a response, use a name like project_name_response.

telegram_notification_system.py:

The IPC listener should receive from project_name_notify.

When handling a user's reply, it should send to project_name_response.

File: roo_code_integration.py (Modified)

import asyncio
import time
from ipc_communication import IPCManager
# It's better to get the base dir from config or environment
from config import IPC_BASE_DIR

class RooCodeController:
    def __init__(self, project_name):
        self.project_name = project_name
        # Define distinct channel names based on project name
        self.notify_channel = f"{self.project_name}_notify"
        self.response_channel = f"{self.project_name}_response"
        self.ipc_manager = IPCManager(base_dir=IPC_BASE_DIR)

    async def send_step_notification(self, message, step_id=None):
        """
        Send a notification TO the bot process via the notify channel.
        """
        notification = {
            'project_name': self.project_name,
            'message': message,
            'step_id': step_id
        }

        # Send via IPC to the NOTIFY channel
        send_result = self.ipc_manager.send_message(
            instance_name=self.notify_channel, # Send on notify channel
            message=notification
        )

        if send_result:
            print(f"Notification sent on '{self.notify_channel}': {message}")
        else:
            print(f"Failed to send notification on '{self.notify_channel}' (IPC lock/timeout)")


    def wait_for_response(self, wait_timeout=600):
        """
        Wait for a response from the Telegram bot via the RESPONSE channel.
        Polls the IPC channel until a response is received or timeout occurs.
        """
        print(f"Waiting for response via IPC on channel '{self.response_channel}'...")
        start_time = time.time()
        while time.time() - start_time < wait_timeout:
            # Check for message on the RESPONSE channel (sent by the bot)
            response_data = self.ipc_manager.receive_message(
                instance_name=self.response_channel, # Receive on response channel
                timeout=0.5,
                remove_after_read=True # Consume the response message
                )

            if response_data:
                # Basic check if it looks like a response payload
                if isinstance(response_data, dict) and 'response' in response_data:
                     print(f"Received response via IPC: {response_data}")
                     return response_data # Return the full payload
                else:
                     # Got a message, but not the expected format. Log it.
                     print(f"WARNING: Received unexpected data on response channel '{self.response_channel}': {response_data}")
                     # Might be a leftover message, ignore and continue waiting

            time.sleep(2) # Poll every 2 seconds

        print(f"Timeout waiting for response on '{self.response_channel}'.")
        return None

# Example workflow (remains the same logic)
async def example_roo_code_workflow():
    controller = RooCodeController('my_awesome_project')
    print("Simulating step 1...")
    await asyncio.sleep(2) # Shorter sleep for testing
    print("Step 1 done. Sending notification.")
    await controller.send_step_notification(
        "Data preprocessing completed. Please reply with 'proceed' or 'abort'.",
        step_id="preprocessing_step"
    )
    response = controller.wait_for_response(wait_timeout=120)
    if response:
        print("Processing received response:", response)
        user_reply = response.get('response', '').lower()
        received_step_id = response.get('step_id')
        if received_step_id == "preprocessing_step":
            if user_reply == 'proceed':
                print("User chose to proceed. Simulating next step...")
                await asyncio.sleep(3)
                print("Next step finished.")
                await controller.send_step_notification("Processing finished successfully!")
            else:
                print("User chose to abort.")
                await controller.send_step_notification("Processing aborted by user.")
        else:
             print(f"Received response, but step_id '{received_step_id}' doesn't match expected 'preprocessing_step'. Ignoring response content.")
             # Decide how to handle mismatched step_id - maybe abort?
             await controller.send_step_notification("Received response for wrong step. Aborting.")
    else:
        print("No response received within timeout. Aborting.")
        await controller.send_step_notification("Timeout waiting for user input. Aborting.")

if __name__ == '__main__':
    # Make sure config.py sets IPC_BASE_DIR if you haven't already
    if not IPC_BASE_DIR:
        print("Error: IPC_BASE_DIR not set in config.py")
        exit(1)
    print(f"Using IPC Base Directory: {IPC_BASE_DIR}")

    try:
        asyncio.run(example_roo_code_workflow())
    except KeyboardInterrupt:
        print("\nRoo Code workflow interrupted.")
Use code with caution.
Python
File: telegram_notification_system.py (Modified)

# ... (imports remain the same, ensure IPCManager and time are imported) ...
import time
from ipc_communication import IPCManager
from config import IPC_BASE_DIR # Import to know the base directory if needed, though IPCManager handles it

class RooCodeNotificationSystem:
    def __init__(self,
                 telegram_token: str,
                 ipc_manager: IPCManager, # Passed in from run_bot.py
                 max_retries: int = 3,
                 backoff_factor: float = 0.3):
        # ... (initialization mostly the same) ...
        self.ipc_manager = ipc_manager
        self.active_instances: Dict[str, Dict[str, Any]] = {}
        self.pending_steps: Dict[str, str] = {}
        # ... (logging setup) ...

    # ... (register_instance, send_telegram_message remain the same) ...

    async def process_incoming_ipc_notification(self,
                                project_name: str,
                                notification: Dict[str, Any]):
        """ Processes a notification received via IPC from Roo Code's notify channel """
        # ... (logic remains the same - finds chat_id, sends Telegram message) ...
        if project_name not in self.active_instances:
            self.logger.warning(f"Received IPC for unregistered project {project_name}. Ignoring.")
            return

        instance = self.active_instances[project_name]
        chat_id = instance['chat_id']
        message = notification.get('message', 'Received unnamed notification.')
        step_id = notification.get('step_id')

        if step_id:
             self.pending_steps[project_name] = step_id
             self.logger.info(f"Stored pending step_id '{step_id}' for project '{project_name}'")
        elif project_name in self.pending_steps:
             del self.pending_steps[project_name] # Clear pending step if notification has no ID

        await self.send_telegram_message(chat_id, f"Project '{project_name}':\n{message}")
        # ... (update instance metadata - optional) ...


    async def handle_telegram_response(self,
                              project_name: str,
                              response_text: str):
        """
        Process a response received via Telegram and forward it to the
        appropriate Roo code instance via its RESPONSE IPC channel.
        """
        # ... (check if project active, get pending step_id - same logic) ...
        if project_name not in self.active_instances:
            self.logger.warning(f"Cannot handle response for unregistered project {project_name}")
            return False
        step_id = self.pending_steps.pop(project_name, None)

        # Define the response channel name
        response_channel = f"{project_name}_response"

        ipc_response = {
            'response': response_text,
            'step_id': step_id,
            'timestamp': time.time()
        }

        self.logger.info(f"Sending IPC response to channel '{response_channel}': {ipc_response}")

        try:
            loop = asyncio.get_running_loop()
            # Send the response back using IPCManager to the RESPONSE channel
            send_successful = await loop.run_in_executor(
                None,
                self.ipc_manager.send_message,
                instance_name=response_channel, # Send on response channel
                message=ipc_response
            )

            if send_successful:
                self.logger.info(f"IPC response successfully sent to {response_channel}")
                return True
            else:
                self.logger.error(f"Failed to send IPC response to {response_channel} (timeout or lock issue)")
                await self.send_telegram_message(
                    self.active_instances[project_name]['chat_id'],
                    f"Error: Could not deliver your response to project '{project_name}'."
                )
                return False
        except Exception as e:
            self.logger.error(f"Exception while sending IPC response for {project_name}: {e}", exc_info=True)
            return False


    async def _ipc_listener_task(self):
        """ Background task to listen for IPC notifications on the notify channels """
        self.logger.info("IPC Listener Task started.")
        watched_notify_channels = set()

        while True:
            current_projects = set(self.active_instances.keys())
            new_notify_channels = {f"{p}_notify" for p in current_projects}

            if new_notify_channels != watched_notify_channels:
                 self.logger.info(f"IPC Listener updating watched channels to: {new_notify_channels}")
                 watched_notify_channels = new_notify_channels

            if not watched_notify_channels:
                await asyncio.sleep(5)
                continue

            for notify_channel in list(watched_notify_channels): # Iterate over a copy
                project_name = notify_channel.removesuffix('_notify')
                # Ensure project is still registered before checking its channel
                if project_name not in self.active_instances:
                    continue

                try:
                    loop = asyncio.get_running_loop()
                    # Check the NOTIFY channel for this project
                    ipc_message_data = await loop.run_in_executor(
                        None,
                        self.ipc_manager.receive_message,
                        instance_name=notify_channel, # Receive from notify channel
                        timeout=0.1,
                        remove_after_read=True # Bot consumes the notification
                    )

                    if ipc_message_data:
                        self.logger.info(f"Received IPC message on {notify_channel}: {ipc_message_data}")
                        # Extract project name again just to be sure or use the one derived
                        # project_name_from_msg = ipc_message_data.get('project_name')
                        await self.process_incoming_ipc_notification(project_name, ipc_message_data)

                except Exception as e:
                    self.logger.error(f"Error in IPC listener loop for {notify_channel}: {e}", exc_info=True)

            await asyncio.sleep(1) # Poll interval


    # ... (start_services, start_command, register_command, handle_telegram_message_input, _find_project_by_chat_id remain the same) ...
    # Make sure handle_telegram_message_input calls handle_telegram_response correctly.
Use code with caution.
Python
Now, when you run the two scripts again (after registering the project via Telegram), the Roo code script should send the notification on my_awesome_project_notify_message.json, the bot should read it from there, and when you reply, the bot should write the response to my_awesome_project_response_message.json, which the Roo code script is waiting to read.

Integrating with Your Actual "Roo" or "VCS" Process

This is the crucial next step. The roo_code_integration.py needs to become part of your workflow.

How to Think About It:

Imagine your current Roo/VCS process runs like this:

Load data.

Preprocess data step A.

Preprocess data step B.

Pause and ask the user: "Do you want to use model X or model Y?"

Based on user input, load the chosen model.

Train/Infer using the model.

Save results.

You need to insert the notification system at step 4:

Load data.

Preprocess data step A.

Preprocess data step B.

Integrate:

controller = RooCodeController('my_vcs_project')

await controller.send_step_notification("Choose model: Reply 'X' or 'Y'", step_id="model_choice")

response = controller.wait_for_response()

if response and response.get('step_id') == 'model_choice':

user_choice = response.get('response')

else:

# Handle timeout or error

user_choice = 'default_model_X' # Or abort

Based on user_choice, load the chosen model.

Train/Infer using the model.

Save results.

await controller.send_step_notification("Processing complete!")

Implementation Options:

If Roo/VCS is a Python Script:

Import RooCodeController.

Instantiate it.

Modify the script to be async if it isn't already (this can be complex), or run the wait_for_response part carefully (since it's blocking). You might need threads if the main script can't block.

Insert the send_step_notification and wait_for_response calls at the exact points where you need user interaction.

If Roo/VCS is a Command-Line Tool:

Modify the Tool's Source (if possible): Add Python code using RooCodeController inside the tool's source at the interaction points.

Wrapper Script: Keep roo_code_integration.py separate. Modify it to:

Use subprocess.run or subprocess.Popen to run the Roo/VCS command-line tool.

This only works if the tool itself has a way to pause and wait for external input (e.g., reading from a specific file you create after getting the Telegram response). This is less common.

Or, if the tool works in distinct stages that can be called separately via command-line arguments. Your wrapper calls stage 1, sends notification, waits, then calls stage 2 with the user's input as an argument.

The key is that the RooCodeController needs to be called by the process doing the actual work at the moment it needs to pause and get input.