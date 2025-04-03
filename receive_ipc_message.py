import sys
import json
import os
import time

# Add the directory containing ipc_communication and config to the Python path
script_dir = os.path.dirname(os.path.abspath(__file__))
if script_dir not in sys.path:
    sys.path.insert(0, script_dir)

try:
    from ipc_communication import IPCManager
    try:
        from config import IPC_BASE_DIR
    except ImportError:
        IPC_BASE_DIR = None
        # Don't print warning here, let IPCManager handle default
except ImportError as e:
    print(f"Error importing IPC modules: {e}. Make sure ipc_communication.py and optionally config.py are accessible.", file=sys.stderr)
    sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: python {os.path.basename(__file__)} <channel_name>", file=sys.stderr)
        sys.exit(1)

    channel_name = sys.argv[1]
    poll_interval = 1 # seconds
    receive_timeout = 0.5 # seconds for the receive_message lock attempt

    try:
        ipc_manager = IPCManager(base_dir=IPC_BASE_DIR)
        # This script runs continuously, polling for a message.
        # It's intended to be spawned once by the VS Code extension.
        # print(f"Polling IPC channel '{channel_name}' every {poll_interval}s...") # Debug print

        while True:
            message_payload = ipc_manager.receive_message(
                channel_name,
                timeout=receive_timeout,
                remove_after_read=True # Consume the message
            )

            if message_payload:
                try:
                    # Print the received JSON payload to stdout for the extension to capture
                    print(json.dumps(message_payload))
                    sys.stdout.flush() # Ensure it's sent immediately
                    # print(f"Received and printed message from '{channel_name}'.") # Debug print
                except Exception as print_err:
                    # If printing fails, log to stderr but continue polling
                    print(f"Error printing received message: {print_err}", file=sys.stderr)

            # Wait before the next poll
            time.sleep(poll_interval)

    except KeyboardInterrupt:
        print("Polling stopped.", file=sys.stderr)
        sys.exit(0)
    except Exception as e:
        print(f"Error during IPC polling: {e}", file=sys.stderr)
        sys.exit(1)