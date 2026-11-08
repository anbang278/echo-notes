# Explicit local setup

The Skill and its scripts contain no user data. Installing the Skill does not grant access to a Vault.

Enable Agent export in Echo Notes and select allowed material kinds and roots. Publish a complete snapshot, then copy the setup command shown by the plugin. The command supplies a Vault path, an alias and the exact Vault-relative policy.json path. This avoids guessing Chinese or English directory names.

Run the bundled script with `node` from the installed Skill directory. Use `help` for argument syntax. Default setup scope is approved_memory. Add transcript or analysis only after the user explicitly selects that scope and the current plugin policy permits it.

Local connections are stored in `$XDG_CONFIG_HOME/echo-notes-memory/vaults.json`, or `~/.config/echo-notes-memory/vaults.json`. An explicit `ECHO_MEMORY_CONFIG` selects an isolated registry for a test or profile. setup modifies this device-level registry only. It does not initialize, migrate or change Vault business files.

Use distinct aliases for multiple Vaults. Reusing an alias for a different canonical root or Vault ID is rejected. Upgrade or uninstall the Skill independently of Vault data. Remove a local registry entry manually only if the user chooses to disconnect it.

For Hermes, determine the selected profile's actual skill discovery directory and absolute HERMES_HOME before installation. Pass the same environment to installation, discovery and the acceptance call. Do not assume a sticky profile selection is inherited by a separate installer process. Do not modify global Hermes or Codex instructions.

A cloud Agent without access to the configured local path receives VAULT_UNREACHABLE. Ask the user to choose an explicitly available synchronized copy or mount. Never claim that installing the Skill transfers private data to another machine.

After connection, run doctor, one search, read a returned ID, and verify a source ID when transcript permission is enabled. Record the actual host and Node versions. Public pinned installer/source commands are validated at release time. Local package validation does not prove that a future remote tag is already installable.
