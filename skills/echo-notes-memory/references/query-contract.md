# Reader protocol 1

Commands include vault list, setup, doctor, projects list, meetings list, search, read, context and export. All business-data query commands are read-only.

JSON output is written to stdout. Diagnostics use stderr. An unsuccessful command sets a nonzero exit code and returns an error envelope. `--format markdown` on export returns the self-contained Markdown on success.

## Query JSON

```json
{
  "protocolVersion": 1,
  "question": "Why did the reminder strategy change?",
  "keywords": ["reminder"],
  "exactPhrases": [],
  "filters": {
    "projectIds": [],
    "meetingIds": [],
    "timezone": "UTC",
    "sourceKinds": ["transcript", "approved_memory"]
  },
  "includeHistoricalMemory": true,
  "retrievalMode": "lexical",
  "maxCharacters": 12000,
  "contextBefore": 1,
  "contextAfter": 1,
  "pinnedEvidenceIds": [],
  "excludedEvidenceIds": []
}
```

Use actual stable project/meeting IDs returned by the reader. Optional fromDate and toDateInclusive are YYYY-MM-DD meeting dates. Same-dimension selections use OR, distinct dimensions use AND. Search is explicit local lexical retrieval. It does not silently invoke semantic search or a model.

maxCharacters counts Unicode code points in selected materials, independently of final metadata overhead. Fixed items over budget require an explicit query adjustment. A frozen snapshot renders deterministically.

## Response

protocolVersion, command, vaultId, generationId, status, checkedAt, freshness, data, warnings and errors form the stable outer envelope. status is ok, partial or error. freshness separately identifies snapshot coverage, returned-item checks and generatedAt.

Search/list pagination uses limit from 1 through 500, a numeric nextCursor and totalMatched. Invalid pagination is INVALID_QUERY. An empty success has an empty items array. No credentials or absolute home-directory paths appear in exported material references.

Relevant errors include VAULT_NOT_CONFIGURED, VAULT_UNREACHABLE, EXPORT_DISABLED, SCHEMA_UNSUPPORTED, INDEX_INCOMPLETE, SOURCE_CHANGED, AUTHORITY_UNVERIFIED, IDENTITY_CONFLICT, ACCESS_DENIED, DATA_UPDATING and ITEM_NOT_FOUND.

Current permission is the intersection of plugin policy, local setup and this request. A request only narrows permission. Policy absence, disablement or incompatibility fails closed even when an older valid generation is present.
