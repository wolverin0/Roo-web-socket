import asyncio
import os
import sys
import logging
import json
import websockets # Added
import inspect # For debugging handler signature
from telegram_notification_system import RooCodeNotificationSystem
# from ipc_communication import IPCManager # Removed
from config import TELEGRAM_BOT_TOKEN # Removed IPC_BASE_DIR

# --- WebSocket Server Setup ---
WEBSOCKET_HOST = "localhost"
WEBSOCKET_PORT = 8765 # Same as in WebSocketClient.ts
logger = logging.getLogger(__name__) # Moved logger setup earlier

# Simple global state to hold the single active connection
# In a more complex scenario, use a dictionary keyed by connection ID or similar
active_websocket = None
notification_system = None # Global reference to the notification system instance

async def websocket_handler(websocket, *args): # Changed path to *args to handle potential signature mismatch during call
    """Handles incoming WebSocket connections and messages."""
    global active_websocket
    if active_websocket:
        logger.warning("New WebSocket connection attempt rejected, already connected.")
        await websocket.close(reason="Already connected")
        return

    active_websocket = websocket
    logger.info(f"WebSocket client connected from {websocket.remote_address}")

    try:
        async for message_str in websocket:
            logger.info(f"Received WebSocket message: {message_str}")
            try:
                message = json.loads(message_str)
                if message.get("type") == "followup":
                    task_id = message.get("taskId")
                    question = message.get("question")
                    suggestions = message.get("suggestions")
                    if task_id and question and notification_system:
                        # Forward to the notification system to handle
                        # This method needs to be created in RooCodeNotificationSystem
                        await notification_system.process_incoming_websocket_notification(
                            task_id, question, suggestions
                        )
                    else:
                        logger.warning("Received invalid 'followup' message format.")
                else:
                    logger.warning(f"Received unknown WebSocket message type: {message.get('type')}")

            except json.JSONDecodeError:
                logger.error(f"Failed to decode JSON from WebSocket message: {message_str}")
            except Exception as e:
                logger.error(f"Error processing WebSocket message: {e}", exc_info=True)

    except websockets.exceptions.ConnectionClosedOK:
        logger.info(f"WebSocket client {websocket.remote_address} disconnected normally.")
    except websockets.exceptions.ConnectionClosedError as e:
        logger.error(f"WebSocket client {websocket.remote_address} disconnected with error: {e}")
    except Exception as e:
        logger.error(f"Unexpected error in WebSocket handler: {e}", exc_info=True)
    finally:
        logger.info(f"WebSocket connection closed for {websocket.remote_address}")
        if active_websocket == websocket:
            active_websocket = None # Clear the active connection
 
async def send_websocket_message(message_str: str):
    """Safely sends a message string over the active WebSocket connection."""
    global active_websocket
    if active_websocket:
        try:
            # Attempt to send the message
            await active_websocket.send(message_str)
            logger.debug(f"Sent WebSocket message: {message_str}")
        except (websockets.exceptions.ConnectionClosedOK,
                websockets.exceptions.ConnectionClosedError,
                websockets.exceptions.ConnectionClosed) as e:
            # Handle specific connection closed exceptions
            logger.error(f"Failed to send WebSocket message: Connection closed ({type(e).__name__}).")
            # Consider clearing active_websocket here if appropriate
            # active_websocket = None
        except Exception as e:
            # Catch other potential errors during send
            logger.error(f"Error sending WebSocket message: {e}", exc_info=True)
    else:
        # Log if there's no active connection to send to
        logger.error("Failed to send WebSocket message: No active WebSocket connection.")

async def main():
    global notification_system, active_websocket # Allow modification
    # Configure logging
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    # Logger is already configured globally now

    try:
        # # Initialize IPC Manager # Removed
        # ipc_manager = IPCManager(base_dir=IPC_BASE_DIR)
        # logger.info("IPC Manager initialized")

        # Initialize Telegram Notification System
        # It will need access to the active_websocket to send replies back
        # We'll modify its __init__ later to accept/store this reference
        # Pass the logger and the send function to the notification system
        notification_system = RooCodeNotificationSystem(
            telegram_token=TELEGRAM_BOT_TOKEN,
            logger=logger, # Pass the logger instance
            websocket_send_func=send_websocket_message # Pass the send function
        )
        logger.info("Telegram Notification System initialized")

        # Start the WebSocket server as a background task
        logger.info(f"Signature of websocket_handler before serve: {inspect.signature(websocket_handler)}") # Debug signature
        server = await websockets.serve(websocket_handler, WEBSOCKET_HOST, WEBSOCKET_PORT)
        logger.info(f"WebSocket server started on ws://{WEBSOCKET_HOST}:{WEBSOCKET_PORT}")
        # Keep a reference to the server task if needed for graceful shutdown, though serve() handles it
        # server_task = asyncio.create_task(server.wait_closed())
 
        # Start the Telegram bot services (runs polling in background)
        await notification_system.start_services()
        logger.info("Telegram bot services started.")
 
        # Keep the main coroutine alive indefinitely
        logger.info("WebSocket Server and Telegram Bot running. Press Ctrl+C to stop.")
        await asyncio.Future() # This will wait forever

    except websockets.exceptions.WebSocketException as e:
         logger.error(f"WebSocket server error: {e}", exc_info=True)
         sys.exit(1)
    except Exception as e:
        logger.error(f"Error in main application: {e}", exc_info=True)
        sys.exit(1)
    except KeyboardInterrupt:
        logger.info("Shutdown requested.")
        # Optional: Add cleanup code here if needed (e.g., close websocket gracefully)
        if active_websocket:
            await active_websocket.close(reason="Server shutdown")
        sys.exit(0)


if __name__ == '__main__':
    # Handle potential RuntimeErrors on Windows when stopping with Ctrl+C
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nServer stopped.")
    except RuntimeError as e:
        # This handles a common issue on Windows with asyncio cleanup on Ctrl+C
        if "Event loop is closed" in str(e):
            print("Event loop closed forcefully.")
        else:
            # Re-raise other runtime errors
            logger.error(f"Runtime error during shutdown: {e}", exc_info=True)
            raise e
    except Exception as e:
        logger.error(f"Unhandled exception: {e}", exc_info=True)
        sys.exit(1)