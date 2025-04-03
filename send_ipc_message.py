import sys
import json
import os

# Add the directory containing ipc_communication and config to the Python path
# Assuming send_ipc_message.py is in the same directory as the other scripts
script_dir = os.path.dirname(os.path.abspath(__file__))
if script_dir not in sys.path:
    sys.path.insert(0, script_dir)

try:
    from ipc_communication import IPCManager
    # Use IPC_BASE_DIR from config if available, otherwise use IPCManager's default
    try:
        from config import IPC_BASE_DIR
    except ImportError:
        IPC_BASE_DIR = None
        print("Warning: config.py not found or IPC_BASE_DIR not defined. Using default IPC directory.")
except ImportError as e:
    print(f"Error importing IPC modules: {e}. Make sure ipc_communication.py and optionally config.py are accessible.")
    sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: python {os.path.basename(__file__)} <channel_name> <json_payload_string>")
        sys.exit(1)

    channel_name = sys.argv[1]
    payload_str = sys.argv[2]

    try:
        payload = json.loads(payload_str)
    except json.JSONDecodeError as e:
        print(f"Error decoding JSON payload: {e}")
        # Optionally print the problematic string: print(f"Payload string: {payload_str}")
        sys.exit(1)

    try:
        ipc_manager = IPCManager(base_dir=IPC_BASE_DIR)
        # Use a relatively short timeout for sending from the extension side
        success = ipc_manager.send_message(channel_name, payload, timeout=5)

        if success:
            # Output confirmation to stdout (optional, good for debugging)
            print(f"IPC message sent successfully to channel '{channel_name}'.")
            sys.exit(0)
        else:
            # Output error to stderr
            print(f"Error: Failed to send IPC message to channel '{channel_name}' (timeout or lock issue).", file=sys.stderr)
            sys.exit(1)
    except Exception as e:
        # Output error to stderr
        print(f"Error sending IPC message: {e}", file=sys.stderr)
        sys.exit(1)