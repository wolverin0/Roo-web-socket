import os
import json
import time
import msvcrt
import logging # Import logging
from typing import Dict, Any, Optional

class IPCManager:
    """
    Inter-Process Communication Manager for Roo Code Instances
    Uses file-based communication with Windows file locking
    """
    def __init__(self, base_dir: str = None):
        """
        Initialize IPC Manager
        
        :param base_dir: Base directory for IPC files
        """
        # Use a platform-specific default if not provided
        if base_dir is None:
            base_dir = os.path.join(
                os.getenv('TEMP', os.path.join(os.path.expanduser('~'), 'AppData', 'Local', 'Temp')), 
                'roocode_ipc'
            )
        
        self.base_dir = base_dir
        os.makedirs(base_dir, exist_ok=True)
        logging.info(f"[IPCManager] Initialized with Base Dir: {self.base_dir}") # Use logging
    
    def _get_lock_path(self, instance_name: str) -> str:
        """
        Get the lock file path for a specific instance
        
        :param instance_name: Name of the Roo code instance
        :return: Path to the lock file
        """
        return os.path.join(self.base_dir, f"{instance_name}.lock")
    
    def _get_message_path(self, instance_name: str) -> str:
        """
        Get the message file path for a specific instance
        
        :param instance_name: Name of the Roo code instance
        :return: Path to the message file
        """
        return os.path.join(self.base_dir, f"{instance_name}_message.json")
    
    def send_message(self, 
                     instance_name: str, 
                     message: Dict[str, Any], 
                     timeout: int = 10) -> bool:
        """
        Send a message to a specific Roo code instance
        
        :param instance_name: Target instance name
        :param message: Message to send
        :param timeout: Timeout for acquiring lock
        :return: Whether message was sent successfully
        """
        lock_path = self._get_lock_path(instance_name)
        message_path = self._get_message_path(instance_name)
        
        start_time = time.time()
        while time.time() - start_time < timeout:
            try:
                # Open lock file with exclusive access
                with open(lock_path, 'w') as lock_file:
                    # Try to acquire an exclusive lock
                    try:
                        msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
                        
                        # Write the message
                        with open(message_path, 'w') as msg_file:
                            json.dump({
                                'timestamp': time.time(),
                                'payload': message
                            }, msg_file)
                        
                        # Release the lock
                        msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
                        
                        return True
                    except IOError:
                        # Could not acquire lock
                        time.sleep(0.1)
                        continue
            except Exception:
                time.sleep(0.1)
        
        return False
    
    def receive_message(self, 
                        instance_name: str, 
                        timeout: int = 10,
                        remove_after_read: bool = True) -> Optional[Dict[str, Any]]:
        """
        Receive a message for a specific Roo code instance
        
        :param instance_name: Source instance name
        :param timeout: Timeout for acquiring lock
        :param remove_after_read: Whether to delete the message after reading
        :return: Received message or None
        """
        lock_path = self._get_lock_path(instance_name)
        message_path = self._get_message_path(instance_name)
        
        start_time = time.time()
        while time.time() - start_time < timeout:
            try:
                # Open lock file with exclusive access
                with open(lock_path, 'w') as lock_file:
                    # Try to acquire an exclusive lock
                    try:
                        msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
                        
                        # Check if message file exists
                        if not os.path.exists(message_path):
                            msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
                            return None
                        
                        # Read the message
                        with open(message_path, 'r') as msg_file:
                            message = json.load(msg_file)
                        
                        # Remove the message if requested
                        if remove_after_read:
                            os.remove(message_path)
                        
                        # Release the lock
                        msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
                        
                        return message['payload']
                    except IOError:
                        # Could not acquire lock
                        time.sleep(0.1)
                        continue
            except Exception:
                time.sleep(0.1)
        
        return None

# Demonstration function
def demo():
    # Create an instance of IPCManager
    ipc_manager = IPCManager()
    
    # Send a message
    project_name = 'test_project'
    message = {
        'step': 'preprocessing',
        'status': 'completed',
        'details': 'Data is ready for next stage'
    }
    
    # Send the message
    send_result = ipc_manager.send_message(project_name, message)
    print(f"Message sent: {send_result}")
    
    # Receive the message
    received_message = ipc_manager.receive_message(project_name)
    print(f"Received message: {received_message}")

if __name__ == '__main__':
    demo()