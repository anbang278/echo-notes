# Provenance and historical state

Transcript evidence describes the saved transcript text. It does not prove that ASR words, speaker attribution or business claims are objectively correct. A revised reading draft is not automatically audio-verified.

Approved memory is an accepted distilled record. approval and authority express user judgment, storedValidity preserves the existing field, and resolvedValidity combines current relations and effective dates. Superseded, invalidated, expired and not_yet_valid records cannot appear as current active memory.

sourceCheck is separate. verified means the returned source version was checked, changed requires refresh, missing requires locating/restoring the source, ambiguous indicates an identity conflict, and unsupported indicates a legacy or unsupported provenance contract. A legacy Candidate fingerprint is not a SHA-256 source revision. Legacy approvals remain sourceCheck unsupported even when snapshotSourceCheck verifies the current saved file. These are separate checks.

Source revisions hash the full saved Markdown after CRLF-to-LF normalization, using UTF-8 SHA-256. Citation ranges use UTF-16 code units within that same full text. Quotes are exact slices contained inside formal reading ranges. A source edit or title/frontmatter change invalidates the old revision. Do not fuzzy-rebind an old quotation to a similar sentence.

SOURCE_CHANGED requires opening Echo Notes, refreshing its catalog and publishing a new Agent snapshot before transcript text can be read, searched or exported. Meeting and project metadata revisions are checked too. Saved date, project membership, title or name changes require republication. Restore missing meeting or project files before refreshing and publishing. Older generations without metadata revisions also require republication.

Current reads recheck Candidate/Review files, the relationship store, effective dates and the authoritative file set. New or removed records can change authority even when the previously listed files are unchanged. Unsupported records stop current-authority claims.

A published generation limits discovery coverage. Current returned dependencies can be verified while new material outside the generation remains undiscovered. Keep these two freshness statements separate when answering.

Exported Markdown contains actual selected text, context, source identity and version, review/effective state, and coverage/omission descriptions. Frozen exports remain historical snapshots. Turning export off affects subsequent official-reader queries and does not retract copies already saved by the user.
