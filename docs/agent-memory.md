# Agent memory reader

Echo Notes publishes an explicitly enabled local read snapshot. A standalone Node.js reader and standard Skill reuse the same transcript parsing, evidence search, memory authority and Markdown rendering code as the plugin. The Node bundle is isolated from the mobile plugin entry.

## Connection

Enable Agent export in the plugin, choose material kinds and allowed roots, and publish. Copy the setup command containing the actual Vault path and policy path. setup stores only a device-local connection registry. It requires an existing enabled policy and a complete readable generation.

The CLI supports vault list, doctor, projects list, meetings list, search, read, context and export. Query operations do not modify meetings, sources, Candidate or Review files. export writes stdout by default and an explicit out file only when that new path is available.

The effective scope is plugin current policy ∩ device setup ∩ request. Disabling export, narrowing scope or moving the policy cannot fall back to an older generation's permissions. A root relocation must revoke the old policy before registering the new path.

## Data and consistency

policy.json is separate from generations. A publisher writes a unique generation, verifies hash/byte length, writes a completion marker and switches current.json last. The reader checks the complete generation and detects competing publication branches. Current Candidate/Review and relationship dependencies are re-read from bounded registered directories, including changes to the file set. Sources, authority, policy and pointer are checked before and after the read with limited retries.

The reader works from saved files with Obsidian closed. Unsaved editor buffers are outside its scope. Source versions use normalized full-document SHA-256 and exact formal-body UTF-16 ranges. Old approval history remains intact when source provenance becomes unavailable.

Changed source revisions stop transcript reads, searches and exports until Echo Notes refreshes the catalog and publishes a new snapshot. This includes title and frontmatter edits or a different source replacing the same path. Meeting and project metadata carry revisions from the same Markdown used to build the catalog. Changes to their dates, membership, titles or names also require refresh and republication. Missing metadata files must be restored and republished before queries resume. Only metadata inside the current intersected allowed roots participates in these checks. Older snapshots without metadata revisions require republication.

Memory-only context and exports include the public evidence-memory fields. Candidate evidence quotations and internal Review objects stay outside those responses.

## Distribution and acceptance

Run `node scripts/build-memory-reader.mjs` to build the self-contained skills/echo-notes-memory/scripts/echo-memory.mjs. Copy the complete Skill directory to the chosen host location and verify it away from the repository with no development node_modules.

A release must test a pinned installer version and an actually published Echo source tag before advertising a remote one-line install command. Until that publication exists, acceptance uses the frozen local Skill directory. Public fixed-version installation remains a separate post-publication check.

Host acceptance includes actual Codex and the explicitly selected Hermes profile, search → read → source, an Obsidian-closed read, changed sources, revoked Review/relations, policy disablement, canonical path protection and business-file hash equality. Platform claims are limited to recorded tests.
