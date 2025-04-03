import asyncio
import os
import sys
import logging
from telegram_notification_system import RooCodeNotificationSystem
from ipc_communication import IPCManager
# Assuming config.py contains TELEGRAM_BOT_TOKEN and IPC_BASE_DIR
try:
    from config import TELEGRAM_BOT_TOKEN, IPC_BASE_DIR
except ImportError:
    print("Error: config.py not found or missing TELEGRAM_BOT_TOKEN/IPC_BASE_DIR.")
    print("Please create config.py with your Telegram Bot Token and desired IPC directory path.")
    TELEGRAM_BOT_TOKEN = None
    IPC_BASE_DIR = None
    sys.exit(1)

async def main():
    # Configure logging
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    logger = logging.getLogger(__name__)

    if not TELEGRAM_BOT_TOKEN or not IPC_BASE_DIR:
        logger.error("TELEGRAM_BOT_TOKEN or IPC_BASE_DIR not configured in config.py. Exiting.")
        sys.exit(1)

    notification_system = None # Define for cleanup scope
    try:
        # Initialize IPC Manager
        ipc_manager = IPCManager(base_dir=IPC_BASE_DIR)
        logger.info(f"IPC Manager initialized (Base Dir: {IPC_BASE_DIR})")

        # Initialize Telegram Notification System
        notification_system = RooCodeNotificationSystem(
            telegram_token=TELEGRAM_BOT_TOKEN,
            ipc_manager=ipc_manager
        )
        logger.info("Telegram Notification System initialized")

        # Start the Telegram bot polling and the IPC watcher thread
        await notification_system.start_services()

        # Keep the main coroutine alive indefinitely
        logger.info("Telegram Bot and IPC Watcher running. Press Ctrl+C to stop.")
        # Keep the main coroutine alive (e.g., by waiting indefinitely)
        # This allows background tasks (polling, watcher thread) to run.
        await asyncio.Event().wait() # Wait indefinitely until cancelled

    except Exception as e:
        logger.error(f"Error in main application: {e}", exc_info=True) # Added exc_info for better debugging
        sys.exit(1)
    except KeyboardInterrupt:
        logger.info("Shutdown requested by KeyboardInterrupt.")
        if notification_system:
            logger.info("Stopping services...")
            await notification_system.stop_services()
            logger.info("Services stopped.")
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