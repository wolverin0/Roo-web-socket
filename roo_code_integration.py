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