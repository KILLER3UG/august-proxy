"""Permission profiles and critical action classification."""
from __future__ import annotations
from typing import Any
CRITICAL_ACTIONS = {'file_write': {'paths': [], 'always_confirm': True}, 'command_execution': {'always_confirm': True}, 'file_delete': {'always_confirm': True}, 'network_access': {'always_confirm': False}}

def isCriticalAction(toolName: str, args: dict[str, Any] | None=None) -> bool:
    """Check if a tool action is critical and requires confirmation."""
    criticalTools = {'write_file', 'run_command', 'bash', 'execute_command', 'delete_file', 'remove_file', 'rm', 'format_disk', 'install_package', 'sudo', 'chmod', 'chown'}
    return toolName in criticalTools

def getPermissionProfile(profileName: str='default') -> dict[str, Any]:
    """Get a permission profile configuration."""
    profiles = {'default': {'allow_file_read': True, 'allow_file_write': True, 'allow_command': True, 'allow_network': True, 'require_approval': ['write', 'delete', 'install', 'sudo']}, 'restricted': {'allow_file_read': True, 'allow_file_write': False, 'allow_command': False, 'allow_network': True, 'require_approval': ['all']}, 'readonly': {'allow_file_read': True, 'allow_file_write': False, 'allow_command': False, 'allow_network': False, 'require_approval': ['all']}}
    return profiles.get(profileName, profiles['default'])