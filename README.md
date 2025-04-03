# Roo Code - Telegram Integration Fork

This repository is a fork of the original [Roo Code](https://github.com/RooVetGit/Roo-Code/) project, modified to include a Telegram notification and interaction system.

## Overview

The primary goal of this fork is to enable Roo Code tasks running within VS Code to:

1.  **Notify** a user via Telegram when a task requires input or confirmation.
2.  **Receive** a response from the user via Telegram.
3.  **Inject** that response back into the running Roo Code task to allow it to proceed.

This is achieved using a combination of:

*   A Python-based Telegram bot.
*   An Inter-Process Communication (IPC) mechanism using temporary files for messaging between the Roo Code process and the Telegram bot process.

## How It Works

1.  **Roo Code Task (`roo_code_integration.py`)**: When a specific step in a Roo Code task needs user input (e.g., confirmation to proceed), it sends a message containing the notification text and a unique step ID to a designated IPC channel (`<project_name>_notify`).
2.  **IPC Listener (in `telegram_notification_system.py`)**: A background task within the Telegram bot process constantly monitors the IPC channels for registered projects.
3.  **Telegram Notification**: When the listener detects a message on a notify channel, it retrieves the target user's `chat_id` (registered via the `/register` command) and sends the notification message via the Telegram bot. It stores the `step_id` to associate the upcoming user reply.
4.  **User Reply (Telegram)**: The user receives the message on Telegram and replies directly to the bot.
5.  **Telegram Bot Handler (`telegram_notification_system.py`)**: The bot receives the user's text message. It identifies the associated `project_name` based on the `chat_id`.
6.  **IPC Response**: The bot constructs a response payload containing the user's reply text and the stored `step_id`. It sends this payload back via a different IPC channel (`<project_name>_response`).
7.  **Roo Code Task (`roo_code_integration.py`)**: The original Roo Code task, which was waiting after sending the notification, polls its response IPC channel. When it receives the response payload, it checks the `step_id` for matching and processes the user's `response` text accordingly.

## Modified/Added Files

The core logic for this integration resides in the following Python files:

*   `ipc_communication.py`: Manages file-based Inter-Process Communication with locking.
*   `telegram_notification_system.py`: Contains the `python-telegram-bot` logic, IPC listener, and message handling between Telegram and IPC.
*   `roo_code_integration.py`: Provides a `RooCodeController` class to be used within Roo Code tasks for sending notifications and waiting for responses via IPC. Includes an example workflow.
*   `run_bot.py`: The main script to start and run the Telegram bot and its associated IPC listener.
*   `config.py`: (Expected) Used to store configuration like the Telegram Bot Token and the base directory for IPC files.

## Setup Instructions

1.  **Obtain Telegram Bot Token**:
    *   Talk to the [BotFather](https://t.me/botfather) on Telegram.
    *   Create a new bot using `/newbot`.
    *   Follow the instructions and copy the **HTTP API token** provided.

2.  **Configure `config.py`**:
    *   Create or edit the `config.py` file in the root directory.
    *   Add your Telegram Bot Token:
        ```python
        TELEGRAM_BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN_HERE'
        ```
    *   Define the base directory for IPC files (it will be created if it doesn't exist). Using a temporary directory is recommended:
        ```python
        import os
        # Example: Use system's temp directory
        IPC_BASE_DIR = os.path.join(os.getenv('TEMP', '/tmp'), 'roocode_telegram_ipc')
        # Or define a specific path:
        # IPC_BASE_DIR = '/path/to/your/ipc/directory'
        ```

3.  **Install Dependencies**:
    *   Make sure you have Python 3 installed.
    *   Install the required library:
        ```bash
        pip install python-telegram-bot requests
        ```
    *   *(Optional but recommended)*: Create a `requirements.txt` file listing dependencies:
        ```
        python-telegram-bot
        requests
        ```
        Then install using: `pip install -r requirements.txt`

## Running the Integration

1.  **Start the Telegram Bot**:
    *   Open a terminal in the project's root directory (`g:/_OneDrive/OneDrive/Desktop/Py Apps/rootelegram/Roo-Code-main`).
    *   Run the bot script:
        ```bash
        python run_bot.py
        ```
    *   The bot should start polling for updates and listening for IPC messages.

2.  **Register Your Chat with a Project**:
    *   Open Telegram and find the bot you created.
    *   Send the command `/start` to initiate interaction.
    *   Send the command `/register <project_name>`, replacing `<project_name>` with a unique identifier for your Roo Code task (e.g., `/register my_awesome_project`). This links your Telegram chat to that specific project name for notifications and responses.

3.  **Run Roo Code Task**:
    *   Trigger the Roo Code task that uses the `RooCodeController` from `roo_code_integration.py`.
    *   When the task reaches a point where it calls `send_step_notification`, you should receive a message from your bot on Telegram.
    *   Reply to the bot's message on Telegram.
    *   The `wait_for_response` function in the Roo Code task should receive your reply via IPC and proceed accordingly.

    *You can test the Roo Code side independently by running:*
    ```bash
    python roo_code_integration.py
    ```
    *This will simulate a task sending a notification and waiting for a response.*

---

*This README focuses on the Telegram integration. For information about the core Roo Code extension, please refer to the [original Roo Code repository](https://github.com/RooVetGit/Roo-Code/).*
