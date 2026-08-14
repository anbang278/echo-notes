<p align="right">
  English | <a href="./README.zh-CN.md">简体中文</a>
</p>

# Echo Notes

Echo Notes is a personal action capture and AI memory-building plugin for Obsidian. Starting from audio transcription, it turns meetings, ideas, study notes, interviews, and everyday thinking into Markdown text, then uses configurable AI analysis templates to turn raw voice into searchable, linkable, reviewable, and reusable personal knowledge assets.

The goal is not just to turn speech into text. Echo Notes is designed to help your actions, thoughts, and decisions continuously enter your personal knowledge system, so they can eventually become long-term context for a Personal Agent. Every recording captures a real moment of action; every transcript becomes a memory that AI can understand; every structured analysis adds experience to a future AI version of yourself.

The workflow is simple: insert or link an audio file in a Markdown note, run a transcription command, and Echo Notes creates a `.transcript.md` file and inserts a "view transcript" link back into the source note. If AI analysis is enabled, Echo Notes can choose an analysis template from nearby keywords and write structured analysis back into the matching transcript. The experimental Echo Memory workflow can then turn a transcript and its successful analyses into traceable meeting pages, candidate memories, and managed long-term profiles.

> Privacy notice: Echo Notes makes network requests only when you start real-time transcription, transcribe an existing file, trigger AI analysis, or enable automatic Echo Memory extraction. Real-time mode continuously sends microphone PCM to Volcengine AgentPlan. Offline mode sends the selected audio to the configured offline provider. AI analysis sends final transcript text to the configured analysis provider. Memory extraction sends transcript text and the successful analyses selected for that run to a separately configured memory provider. Do not process content that should not be sent to external services.

## Why Echo Notes

### Different recordings need different analysis structures

Most transcription tools produce one generic text output, but different recording scenarios require different reading lenses.

- Work meetings care about decisions, action items, owners, due dates, risks, and open questions.
- Study notes care about core concepts, explanations, structured summaries, examples, and review checklists.
- Product requirement mining cares about user quotes, pain points, motivation, context, feature opportunities, and acceptance criteria.

Echo Notes uses configurable prompt templates so the same transcription workflow can produce documents that fit the actual scenario. You can use the built-in work minutes, study notes, product requirement mining, and role-based work templates, or define your own templates, recognition keywords, and prompts.

### Meeting notes and transcripts should not live outside your knowledge base

Many meeting-minutes and transcription products can generate useful content, but the result often stays in a separate platform instead of becoming part of the Obsidian system you already use every day.

That creates several problems:

- Audio files, transcripts, and meeting notes are scattered across tools, making later lookup expensive.
- Transcripts are not automatically connected to daily notes, project notes, or related topic notes, so context is lost.
- Action items, decisions, and product signals from meetings do not naturally enter the existing knowledge workflow.
- During review, it is hard to move from one note back to the original recording, full transcript, and structured AI analysis.

Echo Notes keeps the original recording, full transcript, and AI analysis inside the current vault, with Markdown links back to the source note. Audio can then connect naturally with daily notes, projects, meetings, learning records, and requirement management.

## Long-Term Vision: Capture Actions and Build an AI Version of Yourself

Echo Notes is not only an audio transcription plugin, and not only a meeting-minutes tool. Its deeper idea is that human thinking, actions, judgment, and reflection should be captured with as little friction as possible, then turned into personal context that AI can understand and use.

Traditional knowledge management usually records conclusions: a note, a document, a meeting summary, or a task list. But what truly shapes a person's ability is often not the isolated conclusion. It is the process behind it: why a judgment was made, what information was available, how people discussed the issue, which assumptions were raised, which actions were taken or abandoned, and whether the final result validated the original thinking.

These processes used to be difficult to preserve because they are scattered across meetings, voice memos, chats, temporary ideas, tasks, project execution, and retrospectives. Echo Notes starts from the most natural input: record the voice, transcribe it into text, structure the text, and let the result become Memory and Context that a personal AI can use over time.

From this perspective, each recording is more than a file. It is evidence of action. Each transcript is more than text. It is a captured thinking scene. Each AI analysis is more than a summary. It compresses human experience into reusable cognitive assets for the future.

Long term, Echo Notes aims to help users build a more complete AI version of themselves: one that knows which projects you worked on, which meetings you attended, and who you discussed problems with; one that understands how you judged requirements, decomposed problems, and made tradeoffs; one that learns your expression style, decision preferences, knowledge structure, and working methods. When a similar problem appears in the future, a Personal Agent can give advice based on your real history, not only generic knowledge.

The real goal is not to help you write a few fewer meeting notes. It is to continuously capture your real-world action trail and turn it into personal context infrastructure that future AI can understand, retrieve, reason over, and collaborate with. This direction should respect user control over data: personal memory should stay in your Obsidian vault whenever possible, and external providers should only be called when you explicitly configure and trigger them.

## Features

- Choose **Real-time transcription** or **Offline transcription** above the Provider setting. Each mode keeps an isolated provider configuration.
- In real-time mode, Echo Notes captures the microphone independently, immediately creates a WebM recording and `.transcript.md`, and progressively writes provisional text, definite utterances, speakers, and time ranges.
- If AgentPlan fails, local recording continues and confirmed text is preserved. After stopping, Task Center offers an explicit **Retry with offline provider** action without automatically creating another paid request.
- Offline mode supports Alibaba Bailian, SiliconFlow, MOSI, Ollama, and LM Studio for audio files already stored in the vault.
- Transcribe the selected audio link in the current note.
- Scan and transcribe all supported audio links in the current note.
- Generate a Markdown transcript file with source metadata.
- Protect user edits and AI analysis during subsequent progress updates or retranscription by replacing only the Echo Notes managed transcript block. Existing legacy transcripts are backed up once before migration to the managed format.
- Insert a transcript link below the source audio reference.
- Skip reusable existing transcripts and insert missing transcript links; reuse requires matching source audio path, size, mtime, transcription provider, model, and `status: done`.
- Avoid transcript filename collisions in a custom output folder by adding a stable source-path hash to generated transcript filenames.
- Show the selected transcription provider's upload mode, endpoint shape, file limit, chunking, language, timestamp, and diarization capabilities in settings.
- Run a local transcription-provider configuration check for API key, Base URL, model, HTTP risk, endpoint shape, and capability-limit warnings without uploading audio.
- Standardize transcription provider errors and redact API keys, authorization headers, Base64 audio payloads, and overlong responses before showing or writing failure messages.
- Use a shared AudioChunkPipeline core for long-audio preparation, chunk progress events, segment transcription, text merging, trace id aggregation, raw segment collection, and releasing completed chunk audio buffers. Completed Alibaba Bailian, SiliconFlow, and MOSI segments are checkpointed inside the managed transcript and reused after a failure or restart when the source audio and Provider configuration still match.
- Open Task Center from the ribbon or command palette to inspect transcription, AI analysis, and memory extraction status, failures, durations, providers, models, and outputs. Safe task summaries persist across restarts; interrupted tasks are marked failed and recover transcription, analysis, memory extraction, or profile-rebuild retry actions without storing content or API keys.
- Each Task Center card can export a diagnostic ZIP for its related chain. The **Automation and logs** settings section and the `Echo Notes: 导出诊断日志包` command export recent records. Diagnostics are enabled by default, retain at most the latest 20 runs for seven days, and stay local.
- Optional manual-upload confirmation that previews provider, base URL, model, file size, and HTTP risks before sending audio; automation skips uploads when this confirmation mode is enabled.
- Markdown-link automation skips source notes marked with Echo Notes privacy frontmatter or private tags.
- In offline mode, enable or disable Obsidian's core Audio recorder and save hotkeys for its commands. Real-time mode does not intercept or depend on the core recorder's private state.
- Analyze transcript Markdown files with a separate AI model using built-in general, learning, product, and role-based work templates.
- Run AI analysis in the background and write the result back into the matching transcript.
- Optionally redact common sensitive fields before sending transcript text to the AI analysis provider.
- Run a local AI analysis configuration check for API key, Base URL, HTTPS, and model before sending transcript text.
- Split long transcripts into configurable chunks, checkpoint each successful chunk in the transcript, and run a final synthesis pass that deduplicates conclusions, actions, risks, and open questions. A retry reuses only a continuous prefix whose transcript text, template, Provider configuration, model, and chunk boundaries still match.
- Manually choose an enabled AI analysis template for the currently open transcript.
- Automatically choose one or more AI analysis templates from source-note frontmatter, tags, or keywords found within three lines above or below the source audio link, with a configurable default template as fallback.
- Configure each analysis template with a role group, name, version, recognition keywords, system prompt, and template task.
- Record Dataview-friendly AI analysis metadata for each generated template result, including template id, template name, template version, provider, model, generated time, and trace id when available. New transcripts keep this technical information in a visible section at the end of the Markdown file so the transcript and AI analysis content stay readable first.
- Track AI analysis lifecycle in transcript frontmatter with `analysis_status`, scheduled template ids, pending/done/failed template ids, provider, model, timestamps, and the latest sanitized analysis error.
- Optionally initialize an Echo Memory workspace and extract evidence-backed candidate memories from a transcript plus the successful analyses included in that run.
- Keep memory Provider, API key, Base URL, model, and long-text settings isolated from transcription and AI analysis configuration. Memory extraction is disabled by default.
- Checkpoint every validated long-text memory chunk in the Echo Memory system directory. A retry reuses only the continuous prefix whose transcript, included analyses, initialized user, Schema/prompt/pipeline versions, Provider configuration, model, language, and chunk boundaries still match.
- Review every candidate in a same-directory `.review.md` sidecar, with per-assertion approval, correction, rejection, reset, and append-only event history.
- Manually confirm conflicts, supplements, supersession, or invalidation between approved assertions for the same subject. Relations live outside immutable candidates, keep structured endpoint metadata, backlinks, and append-only confirmation/revocation history, and can be revoked to restore the previous profile view. Original evidence quotes are read from the currently approved candidate packages for immediate comparison and are not duplicated in the relation JSON.
- Choose between saving reviews only or automatically compiling profiles and cross-record views after a review is saved. Only approved, non-suppressed assertions enter User, person, organization, and project profiles.
- Rebuild managed profiles plus project, people, and timeline aggregations from candidate packages, review sidecars, and approved-memory relations. Each entry keeps transcript, candidate, review, and relation backlinks; rejecting, resetting, superseding, invalidating, or revoking an assertion updates the views without scanning the whole vault or overwriting user-authored content.
- Optional automation for newly added Markdown audio links.
- Optional automation for newly created audio files.
- Markdown audio-link automation deduplicates processed links in the current plugin session using source note, normalized audio path, raw link text, and occurrence order.

## Providers

Real-time transcription:

- Volcengine AgentPlan, fixed to `doubao-seed-asr-2.0` and the official `bigmodel_async` endpoint, with speaker diarization and utterance timestamps. It requires Obsidian desktop and a local filesystem vault.

Offline transcription providers:

- 阿里百炼（Alibaba Bailian） with `qwen3-asr-flash`
- 【免费】硅基流动（SiliconFlow） with official choices `FunAudioLLM/SenseVoiceSmall` and `TeleAI/TeleSpeechASR`, plus custom model IDs
- MOSI with selectable `moss-transcribe` plain transcription or `moss-transcribe-diarize` speaker diarization
- Ollama through its local OpenAI-compatible `/audio/transcriptions` endpoint
- LM Studio through its local OpenAI-compatible `/audio/transcriptions` endpoint

AgentPlan real-time transcription keeps its official `bigmodel_async` Base URL and model read-only. MOSI locks its official Base URL and derives its read-only model from the **Speaker diarization** toggle: enabled uses `moss-transcribe-diarize`, while disabled uses `moss-transcribe`. Other offline-provider defaults remain editable. The settings tab switches language, microphone, and offline-provider fields with the selected mode and shows the relevant endpoint, size, chunking, timestamp, and diarization capabilities.

The settings tab also includes a local "Check transcription configuration" action. It checks API key presence, Base URL format, example URLs, non-local HTTP risks, model hints, endpoint shape, and known capability limits. This check does not upload audio and does not call the provider.

AI analysis supports SiliconFlow, **OpenCode Go**, Alibaba Bailian, DeepSeek, Volcengine AgentPlan, Ollama, LM Studio, and a custom OpenAI-compatible endpoint, in that order. The global default remains Alibaba Bailian `deepseek-v4-pro`; OpenCode Go defaults to `deepseek-v4-flash` when selected, and SiliconFlow defaults to `Qwen/Qwen3.5-4B`. OpenCode Go is available only for AI analysis, keeps its official `https://opencode.ai/zen/go/v1` Base URL read-only, and offers the current documented model snapshot: Grok 4.5, GLM-5.2/5.1, GPT 5.6 Luna, Kimi K3/K2.7 Code/K2.6, MiMo-V2.5/Pro, MiniMax M3/M2.7, Qwen3.8 Max/Qwen3.7 Max/Plus/Qwen3.6 Plus, DeepSeek V4 Pro/Flash, and Hy3. Echo Notes automatically routes these models through their documented Chat Completions, Responses, or Messages endpoint. Availability, subscription limits, and data-retention policies may change; check the [OpenCode Go documentation](https://opencode.ai/docs/zh-cn/go) before sending content. Selecting AgentPlan locks the Base URL to the plan-specific `https://ark.cn-beijing.volces.com/api/plan/v3` endpoint and provides a model picker for the currently documented text models, including Doubao Seed 2.0 Mini/Lite/Pro, Doubao Seed Evolving, DeepSeek V4, MiniMax M2.7/M3, GLM-5.2, and Kimi K2.6/K2.7 Code/K3. Kimi K3 requires Medium or higher, and preview models may be rate-limited during peak traffic. AgentPlan analysis remains isolated from AgentPlan ASR configuration and secrets by purpose.

AgentPlan officially limits its text-generation and embedding benefits to AI-tool scenarios. Before enabling this integration, confirm that your Echo Notes usage complies with the current plan terms. Using the dedicated Base URL and API key outside permitted AI-tool scenarios may lead to subscription suspension or account restrictions.

## Network and Data Use

Echo Notes makes network requests only when transcription, AI analysis, or Echo Memory extraction is triggered.

- SiliconFlow default endpoint: `https://api.siliconflow.cn`
- Alibaba Bailian default endpoint: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- MOSI transcription endpoint: `https://api.mosi.cn/v1/audio/transcriptions`
- Volcengine AgentPlan real-time ASR endpoint: `wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async`
- Volcengine AgentPlan analysis endpoint: `https://ark.cn-beijing.volces.com/api/plan/v3`
- OpenCode Go analysis endpoint: `https://opencode.ai/zen/go/v1` (the selected model determines the documented API path)
- Ollama transcription default endpoint: `http://localhost:11434/v1`
- LM Studio transcription default endpoint: `http://localhost:1234/v1`
- AI analysis default endpoint: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Other AI analysis endpoints use the Base URL configured for the selected analysis provider; OpenCode Go and AgentPlan keep their provider-specific Base URLs locked.
- Echo Memory uses the Base URL configured for its separate memory provider and calls the OpenAI-compatible `/chat/completions` endpoint.

Offline transcription sends the selected audio to the configured offline provider. With MOSI, Echo Notes uploads multipart audio to `api.mosi.cn` through a synchronous non-streaming request. Diarization is optional: enabled mode requests speaker segments and timestamps, while disabled mode requests plain text only. No temporary segment files are created in the vault.

Real-time mode does not create or convert a complete WAV first. Echo Notes runs two local paths in parallel: `MediaRecorder` appends WebM Opus chunks to the vault about once per second, while Web Audio continuously downmixes and resamples the microphone to 16 kHz, 16-bit, mono PCM and sends 200 ms packets over one authenticated optimized bidirectional AgentPlan WebSocket. The recording, transcript, audio embed, and transcript link are created as soon as the session starts. Confirmed second-pass utterances are written progressively; unconfirmed text stays in a temporary region. If AgentPlan disconnects, local recording continues and already persisted audio and text remain available.

Real-time AgentPlan and diarization-enabled MOSI speaker IDs distinguish voices but do not identify real names. MOSI speaker IDs remain local to each independently submitted segment. AI analysis reads only completed final transcript text; selecting AgentPlan sends it to the plan-specific Chat API, while selecting OpenCode Go sends it to the official endpoint for the chosen model. Echo Memory sends the transcript body and successful analyses included in the run to the memory provider. Transcription, analysis, and memory API keys remain isolated by provider and purpose in Obsidian `SecretStorage`. Keys are not written to plugin settings, transcripts, candidate packages, or logs. Recordings, transcripts, AI analysis output, and Echo Memory files remain in the Obsidian vault.

## Diagnostic package

When transcription, analysis, or Echo Memory has a problem that is hard to describe, choose **Export diagnostic package** on the Task Center card or export recent records from **Automation and logs**. ZIP files are created only in `Echo Notes/诊断包/` within the current Vault and are sent by the user; Echo Notes never uploads them automatically. On desktop local-file Vaults, the completion dialog can locate the ZIP in macOS Finder or Windows File Explorer. Clearing diagnostic records does not delete ZIP files already generated.

The fixed package contains a redacted configuration snapshot, task index, request/chunk/retry/recovery lifecycle events, HTTP or WebSocket status, error classification, and Trace IDs. By default it never stores or exports audio, transcript text, prompts, successful response bodies, AI analysis output, Memory candidates, Vault names, file names, raw paths, user or device names, API keys, authorization headers, or SecretStorage identifiers. Base URLs remove usernames, passwords, queries, and fragments; LAN hosts are redacted too.

The export dialog has three independent, opt-in choices: transcript text, AI analysis output, and Memory candidates. They are off by default, read only at export time, and never enter automatic diagnostic retention. Their combined uncompressed size is limited to 10 MB; over the limit, reduce the selection—content is never silently truncated. Audio is never included. Older tasks created before this feature can still export configuration and task snapshots; reproduce once after upgrading for request-level logs.

If "Confirm before manual transcription upload" is enabled in settings, Echo Notes shows a confirmation dialog before manual transcription uploads. The dialog lists the provider, Base URL, model, file size, and HTTP risk warnings. Automation skips uploads while this confirmation mode is enabled so audio is not sent in the background without user confirmation.

If "Redact transcript before AI analysis" is enabled, Echo Notes masks common sensitive values only in the transcript text sent to the analysis provider. The local transcript file is not modified. The current redaction covers labeled customer/contact/company/address fields, email addresses, phone numbers, Chinese ID numbers, long numeric identifiers, amounts, and common Chinese address fragments.

Markdown-link automation also skips source notes marked with Echo Notes privacy flags. Add any of these frontmatter values to a sensitive note:

```yaml
echo_notes_private: true
echo_notes_disable_automation: true
echo_notes_disable_auto_transcribe: true
```

You can also use tags such as `#echo-notes-private`, `#echo-notes-no-auto`, `#echo-notes-disable-automation`, or `#echo-notes-disable-auto-transcribe`. These flags only disable background Markdown-link automation; manual commands still work when you explicitly run them.

## Supported Audio Formats

- `mp3`
- `mp4`
- `mpeg`
- `mpga`
- `m4a`
- `ogg`
- `wav`
- `webm`

Provider limits:

- Volcengine AgentPlan `doubao-seed-asr-2.0`: real-time mode is fixed to `bigmodel_async` and requires Obsidian desktop with a local filesystem vault. Speaker clustering and utterance timestamps are always enabled. A standard Ark API key is not interchangeable with the dedicated AgentPlan API key.
- SiliconFlow: each request must stay within both 50 MB and one hour. Exceeding either limit triggers local decoding into roughly 10-minute 16 kHz mono WAV segments, uploaded sequentially. If media metadata cannot be read, Echo Notes still applies the size rule and attempts the normal request.
- HTTP `500/502/503/504` responses use 1-second and 3-second backoff retries before falling back to chunking. A persistently failing chunk alone is bisected; `413` splits immediately, down to 60 seconds and at most four levels. Authentication, quota, rate-limit, and invalid-model errors are not split.
- Retries and smaller chunks can create extra provider requests, but Echo Notes never changes the selected provider, API key, or model. Completed chunks are not retransmitted; failures keep completed text, trace IDs, and the failed time range.
- See the [SiliconFlow transcription API reference](https://docs.siliconflow.cn/cn/api-reference/audio/create-audio-transcriptions) for the current limits and model list.
- Alibaba Bailian `qwen3-asr-flash`: local files are encoded as Base64 Data URLs. If the full file would exceed the 10 MB Base64 input limit, Echo Notes decodes the file locally, converts it to 16 kHz mono WAV segments, transcribes each segment in order, and writes completed segments back to the same transcript draft.
- MOSI: enabling **Speaker diarization** uses `moss-transcribe-diarize`, version `moss-transcribe-diarize-20260325`, and `diarize=true`; disabling it uses plain `moss-transcribe` with version `moss-transcribe-v1` and omits `diarize`. Both modes use the documented synchronous, non-streaming multipart request. Files longer than three minutes are split locally into roughly three-minute WAV segments and written back progressively. HTTP `500/502/503/504` retries use one- and three-second delays; a persistent server failure, `413`, or an explicit too-long/too-large response shrinks only the failing segment down to 30 seconds and at most four levels. MOSI does not publish a stable file-size limit. See the [MOSI transcription API reference](https://platform.mosi.cn/docs/reference/transcriptions).
- Ollama and LM Studio: files over 25 MB are blocked before upload.

For chunked Alibaba Bailian, SiliconFlow, and MOSI runs, every successful segment is stored in a managed, source-readable checkpoint with the source path/size/mtime, Provider, model, a secret-free configuration fingerprint, time range, text, trace ID, and diarized utterances when available. A retry reuses only a continuous prefix whose identity and segment boundaries still match. Changed audio or configuration, and damaged checkpoint data, safely start a fresh run.

Capability matrix:

| Provider family | Upload mode | Endpoint shape | Limit | Echo Notes chunking | Language parameter | Timestamp | Speaker diarization |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Volcengine AgentPlan real-time `doubao-seed-asr-2.0` | microphone PCM over authenticated optimized bidirectional WebSocket | `/api/v3/plan/sauc/bigmodel_async` | desktop and local filesystem vault only | No; one live session | Chinese or auto | Yes, utterance level | Yes |
| Alibaba Bailian `qwen3-asr-flash` | Base64 Data URL | `/chat/completions` + `input_audio` | 10 MB encoded input | Yes | Yes | No | No |
| SiliconFlow `FunAudioLLM/SenseVoiceSmall` / `TeleAI/TeleSpeechASR` / custom model | multipart | dedicated SiliconFlow endpoint | 50 MB and one hour per request | Yes; ~10-minute chunks with adaptive shrinking | No | No | No |
| MOSI `moss-transcribe` / `moss-transcribe-diarize` | multipart | `/v1/audio/transcriptions` | Determined by MOSI | Yes; ~3-minute chunks with adaptive shrinking | No | Diarization mode only, segment level | Optional |
| Ollama and LM Studio | multipart | `/audio/transcriptions` | 25 MB audio file | No | Yes | No | No |

Long-audio chunking belongs to the offline path and currently applies to Alibaba Bailian `qwen3-asr-flash`, SiliconFlow official or custom transcription models, and MOSI. M4A, MP4, and WebM still require full local decoding and may hit device memory limits; Echo Notes does not install or invoke FFmpeg. A real-time AgentPlan session consumes microphone PCM directly: provisional text is coalesced about every 500 ms, while new definite utterances, stop, completion, and failure force a write. If AgentPlan fails, local recording continues; after stopping, Task Center offers an offline retry but does not upload automatically. Chunked MOSI transcripts retain headings such as `## Segment 01（00:00-03:00）`; diarization-enabled MOSI speaker numbering restarts within each segment while timestamps remain absolute to the original audio. MOSI plain mode keeps the same segment headings but emits no speaker labels.

Default transcription language is sent only to providers that support a language parameter, such as Alibaba Bailian, Ollama, and LM Studio. AgentPlan speaker diarization supports Chinese or an omitted language; selecting another language while AgentPlan is active automatically switches it to `auto`. SiliconFlow and MOSI do not receive a language field from Echo Notes; those providers detect the audio language.

AgentPlan and diarization-enabled MOSI transcripts show speaker labels. MOSI exposes a separate **Speaker diarization** toggle; when it is disabled, the **Speaker label style** setting is hidden and the transcript contains plain text. When labels are enabled, the style setting selects either speaker-only labels or the default speaker-and-time form:

```markdown
**Speaker 1 (00:00-00:12)**

Transcript text.
```

## Configure a Transcription Mode

1. Open the Echo Notes settings tab.
2. Choose **Real-time transcription** or **Offline transcription** above Provider. New installs default to offline mode with Alibaba Bailian.
3. Real-time mode: enter the dedicated AgentPlan API key and choose language, speaker-label style, and microphone. The official Base URL and model are read-only. Microphone permission is requested only when refreshing devices or starting a session.
4. Offline mode: choose Alibaba Bailian, SiliconFlow, MOSI, Ollama, or LM Studio, then confirm the API key and available provider settings. MOSI's official Base URL is read-only; use **Speaker diarization** to switch its derived read-only model.
5. Choose the copy language for inserted links and generated template labels.

Real-time commands:

- `Echo Notes: Start realtime transcription`
- `Echo Notes: Stop realtime transcription`
- `Echo Notes: Open active realtime transcript`

The real-time ribbon is visible in real-time mode; while recording, clicking it stops the session. Switching notes does not move the session: files remain bound to the source note active at start.

Recommended defaults:

| Provider | Base URL | Model | Default language |
| --- | --- | --- | --- |
| Volcengine AgentPlan (real-time) | `wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async` | `doubao-seed-asr-2.0` | `zh` |
| 阿里百炼（Alibaba Bailian） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-asr-flash` | `zh` |
| 【免费】硅基流动（SiliconFlow） | `https://api.siliconflow.cn` | `FunAudioLLM/SenseVoiceSmall` | `auto` |
| MOSI（可选说话人分离） | `https://api.mosi.cn/v1` | `moss-transcribe-diarize` by default; `moss-transcribe` when disabled | `auto` |
| Ollama | `http://localhost:11434/v1` | `whisper-1` | `zh` |
| LM Studio | `http://localhost:1234/v1` | `whisper-1` | `zh` |

## Configure the Obsidian Core Plugin Audio Recorder

Obsidian's `Audio recorder` core plugin is used only by the offline workflow: it saves a complete recording after stop, then Echo Notes transcribes that file with the offline provider. Real-time mode uses Echo Notes' own recorder because the core recorder exposes no stable public live-audio chunk API. The core-plugin controls appear in the offline settings section.

That section can save hotkeys directly to Obsidian's core Audio recorder commands. Echo Notes does not assign default hotkeys, so it will not override common actions such as Save or Undo:

| Action | Command | Hotkey |
| --- | --- | --- |
| Start the Obsidian core plugin audio recorder | `audio-recorder:start` | User configured |
| Stop the Obsidian core plugin audio recorder | `audio-recorder:stop` | User configured |
| Transcribe all audio files in the current note | `Echo Notes: Transcribe all audio files in current note` | User configured |

Echo Notes no longer registers proxy commands for starting or stopping the core recorder. When you click Save, it updates Obsidian's hotkey settings for `audio-recorder:start` or `audio-recorder:stop`; if your Obsidian version does not expose the internal hotkey manager, configure those core commands manually in Obsidian Hotkeys.

## Configure AI Analysis

1. Open the Echo Notes settings tab.
2. Enable AI analysis.
3. Choose SiliconFlow, Alibaba Bailian, DeepSeek, Volcengine AgentPlan, Ollama, LM Studio, or a custom OpenAI-compatible endpoint. Alibaba Bailian remains the default provider.
4. Alibaba Bailian defaults to `https://dashscope.aliyuncs.com/compatible-mode/v1` and `deepseek-v4-pro`; SiliconFlow defaults to `https://api.siliconflow.cn/v1` and `Qwen/Qwen3.5-4B`. AgentPlan locks its plan-specific Base URL to `https://ark.cn-beijing.volces.com/api/plan/v3` and defaults to `doubao-seed-2.0-lite`; choose another supported plan model from the dropdown when needed.
5. Enter the separate analysis API key. AgentPlan requires its dedicated plan API key, and Echo Notes does not reuse or overwrite the real-time transcription key.
6. Run "Check analysis configuration" to validate the API key, Base URL, HTTPS, and model locally.
7. Keep long-text chunking enabled for large meetings or interviews. The default chunk size is 24,000 characters and can be adjusted between 4,000 and 100,000.
8. Optionally enable transcript redaction before AI analysis if the transcript may contain sensitive personal, customer, company, address, or amount fields.
9. Choose the default analysis template used when no keyword is found near the audio link.
10. Edit, enable, disable, restore, or add templates in the analysis template settings.

Built-in template groups:

- General scenarios: work minutes and study notes.
- Management and people: manager sync and HR/people minutes.
- Product and delivery: product requirement mining, product manager, and project manager minutes.
- Engineering: engineering/technical minutes.
- Customer and growth: sales, customer success, and operations minutes.
- Custom: user-created templates start here and can be assigned to any group.

The template manager uses a fixed category switcher and shows one group at a time. Switch groups by clicking or with the Left/Right Arrow, Home, and End keys. The selected group remains active when template changes redraw the settings page.

The v2 built-in prompts use role-specific Markdown structures while sharing a neutral evidence policy. They separate facts, decisions, suggestions, and inferences; do not invent owners, dates, budgets, metrics, priorities, or sales stages; and treat transcript content as untrusted data rather than instructions. Action-item templates use a consistent table with item, owner, due date, and acceptance signal/next step.

Custom templates support a role group, name, recognition keywords, system prompt, template task, and enabled switch. Enabled templates participate in keyword matching; disabled templates keep their configuration but are not used automatically. During migration, an untouched v1 built-in preset is upgraded to v2 while preserving its enabled state. Any built-in template whose editable content was changed remains untouched until you explicitly restore its default.

## Configure Echo Memory MVP

Echo Memory is disabled by default. Open the **Memory extraction** stage in Echo Notes settings, then:

1. Choose a vault-relative memory root folder. The default is `Echo Memory`.
2. Run initialization and provide only a display name, current role, and recent goal. Initialization creates the workspace and enables memory extraction. The workspace language follows the UI language selected at initialization time.
3. Select a separate memory Provider, then configure its dedicated API key, Base URL, and model. Memory secrets are stored by Provider in Obsidian `SecretStorage` and are never reused from AI analysis.
4. Choose whether review saves remain candidate-only or automatically recompile managed User/entity profiles and cross-record aggregations.
5. Keep long-text chunking enabled for large inputs. The default chunk size is 24,000 characters with a maximum of 20 chunks. New and legacy candidates start pending; only explicitly approved assertions enter profiles, and their effective values can be corrected during review.

The default Chinese workspace layout is:

```text
Echo Memory/
|-- 00 首页.md
|-- 01 会议/
|-- 02 记忆候选/ (candidate `.md` and review `.review.md` files)
|-- 03 实体/人物, 组织, 项目/
|-- 04 User/SOUL.md and 01-08 profile documents
|-- 05 聚合/项目.md, 人物.md, 时间线.md
|-- 06 上下文包/ (previewable Personal Agent context packages)
`-- 99 系统/echo-memory.json, echo-memory-checkpoints.json, echo-memory-relations.json, and 运行日志/
```

Each candidate package contains a readable Markdown table and plugin-managed JSON and remains unchanged by review. Its same-directory review sidecar stores per-assertion status, effective value, note, review time, and full event history inside an `echo-memory-review:managed` block while preserving manual text outside that block. Its input fingerprint covers the transcript body, included analyses, schema and prompt versions, output language, initialized user, Provider, and model. Repeating the same input reuses the existing candidate without calling the model again. A legacy candidate receives a fully pending sidecar when first reviewed or rebuilt and is never silently approved. Profile compilation consumes approved assertions only, replaces content between `echo-memory:managed` markers, and preserves user-authored text outside those markers.

Memory extraction has a 15-minute limit shared by all chunks. Running and failed memory tasks can be retried from Task Center. Retry first aborts the current wait and waits for the old attempt to exit, so late responses cannot write candidate data. Timeout, failure, and retry events are written to the Echo Memory run log without storing API keys or full model responses.

For a chunked extraction, each successful response is evidence-validated before its structured assertions are written to `99 系统/echo-memory-checkpoints.json` (or `99 System` in an English workspace). Each completed chunk is limited to 24,000 characters of structured result data; the shared store is limited to 25,000,000 characters and 100 unfinished transcripts. It never contains API keys, authorization headers, full requests, or raw Provider responses. A failure retains the current transcript entry for an explicit retry; a successful candidate, review sidecar, manifest record, meeting page, and optional profile compilation remove only that transcript entry while keeping the shared store. These checkpoints contain sensitive derived memory and can be removed or archived manually when recovery is not wanted. Resumed output is still a pending candidate and requires review before it can enter a profile.

Approved-memory relations are stored as readable JSON in `99 系统/echo-memory-relations.json` (or `99 System`). Open a candidate or its review sidecar and run **Manage current memory relations**. Only approved assertions from different candidates for the same normalized subject can be linked. Confirmed conflicts and supplements keep both assertions visible with relation IDs and candidate/review backlinks. Supersession and invalidation remove the target from compiled profiles while preserving its audit backlink on the source; revocation restores it on rebuild. If either review is no longer approved or its effective value changes, the active relation becomes non-applicable and suppresses nothing until the user reconfirms it. The store is limited to 5,000 relations, 100 events per relation, and 10,000,000 characters. It retains structured endpoint metadata, effective values, IDs, timestamps, backlinks, and event history, but does not duplicate `evidenceQuote` source text. The editor reads evidence from the currently approved candidate packages and safely falls back to backlinks when evidence is unavailable. Legacy relation files with optional evidence quotes remain readable and are lazily rewritten without a Schema-version upgrade. Relation operations never rewrite candidate packages.

Every profile rebuild also regenerates three relationship-aware Markdown views under `05 聚合` (or `05 Aggregations`): projects grouped by normalized project, people grouped by normalized person, and a stable chronological timeline across all current approved assertions. Superseded or invalidated targets are omitted, conflicts and supplements remain visible, and every row links back to its transcript, candidate, review, and applicable relation. These files and the home-page navigation use dedicated managed blocks, so manual text outside the blocks is preserved. Existing v1 manifests gain the additive paths on their next rebuild without changing the Schema version.

Run **Create personal agent context package** to preview and generate a local Markdown context package under `06 上下文包` (or `06 Context Packages`). Project and person filters use OR semantics; optional start/end dates filter the assertion `observedAt` day, and the character budget is bounded to 4,000-100,000 characters with a 12,000-character default. Entries are ordered newest-first, preserve evidence plus transcript/candidate/review/relation backlinks, and show how many matching entries were omitted by the budget. Generation uses only approved, relation-resolved memory, updates only the `echo-memory-context:managed` block, preserves manual text outside the block, and makes no network request or external Agent call.

Commands:

- `Echo Notes: Initialize Echo Memory`
- `Echo Notes: Extract memory from current transcript`
- `Echo Notes: Review current memory candidate`
- `Echo Notes: Manage current memory relations`
- `Echo Notes: Open Echo Memory home`
- `Echo Notes: Open Echo Memory timeline`
- `Echo Notes: Create personal agent context package`
- `Echo Notes: Rebuild memory profiles and aggregations from candidates`

The current MVP does not include external Agent CLIs, semantic retrieval, a vector database, cross-vault sync, or automatic calendar and note actions; context packages are local, previewable Markdown only.

## Usage

### Transcribe selected audio

Select an audio reference in the current Markdown note:

```markdown
![[Recording 20260531001942.m4a]]
```

Run the command `Echo Notes: Transcribe selected audio`.

Echo Notes resolves the audio file, calls the configured provider, creates a transcript, and inserts a transcript link below the audio reference.

If AI analysis is enabled, Echo Notes first checks the source note frontmatter for `echo_notes_analysis_template`, `echo_notes_template`, or `analysis_template`. The value can be one or more enabled template ids or template names, either as a comma-separated value, an inline YAML array, or a YAML list. If no enabled frontmatter template is found, Echo Notes checks frontmatter `tags` and inline `#tags` against enabled template ids, names, and recognition keywords. If no tag matches, Echo Notes reads the three lines above and below the audio link and selects every enabled template whose keyword appears in that context. After the transcript link is inserted, AI analysis runs in the background; when each model call returns, the result is written before the transcript section in the same `.transcript.md` file. If no keyword is found, Echo Notes uses the configured default template.

### Transcribe all audio files in the current note

Add one or more audio links to a note:

```markdown
![[Recording 20260531001942.m4a]]
![[Recording 20260531002010.m4a]]
```

Run the command `Echo Notes: Transcribe all audio files in current note`.

If AI analysis is enabled, each audio link is matched independently. Different recordings in the same note can use different templates, or multiple templates, by placing different keywords near each audio link.

### AI analysis generation

AI analysis runs automatically after a transcript is created or reused. Echo Notes inserts the transcript link first and does not wait for the model response. If "skip existing transcript" is enabled, running the transcription command again reuses only a `status: done` transcript whose source audio path, size, mtime, provider, and model still match, then generates or updates AI analysis in the background.

Each AI analysis task has a 15-minute limit shared by chunk extraction and final synthesis. On timeout, Echo Notes marks the task as failed, preserves the error state in the transcript, and keeps the Task Center retry action available. For a chunked run, each successful chunk is immediately stored in a template-isolated hidden Obsidian comment in the same transcript. A retry skips the matching completed prefix and always reruns final synthesis; changed transcript text, redaction mode, template content/version, Provider, Base URL, model, language, chunk settings, or boundaries starts safely from the first chunk.

An unfinished analysis checkpoint may contain up to 12,000 characters of derived model output per completed chunk. It never stores API keys or raw Provider responses and is removed after the final analysis has been written successfully. Because failed work keeps these derived outputs in the vault for recovery, treat the transcript file as sensitive data and remove it manually if you do not want to retain the failed run.

To run analysis manually, open a `.transcript.md` file and run `Echo Notes: Analyze current transcript with selected template`, then choose any enabled template.

Echo Notes writes AI analysis into a controlled block before the transcript section. Running the same template again replaces that template's existing result instead of stacking duplicates; different matched templates are appended inside the same AI analysis block.

For analysis written with the current format, the AI analysis block contains only the template heading and generated content. Dataview inline fields prefixed with `echo_notes_analysis_` and the generated-at, Provider, model, and Trace ID summary are written once at the end of the same `.transcript.md` file under a visible `Echo Notes Technical Info` section. These fields make template id, template name, template version, provider, model, generated time, and trace id queryable without parsing the generated Markdown body. Transcripts generated before this layout change keep their original structure.

Transcript frontmatter also records the current AI analysis lifecycle. While analysis is running, `analysis_status` is `analysis_pending`; once all scheduled templates finish, it becomes `analysis_done`, `analysis_failed`, or `analysis_partial_failed`. The frontmatter keeps `analysis_template_ids`, `analysis_pending_template_ids`, `analysis_done_template_ids`, and `analysis_failed_template_ids` so Dataview can find transcripts that still need review or retry.

Frontmatter template selection applies to the whole source note and has priority over tags and nearby keywords. Tags apply to the whole source note and have priority over nearby keywords. Keywords are matched only against the source note lines around the audio link, not against the transcript body. If multiple templates match the same context, Echo Notes runs all matching enabled templates in settings order.

## Output Example

Input:

```markdown
![[Recording 20260531001942.m4a]]
```

Output:

```markdown
![[Recording 20260531001942.m4a]]
[[Recording 20260531001942/Recording 20260531001942.transcript|查看转写稿]]
```

Generated file:

```text
Recording 20260531001942/Recording 20260531001942.transcript.md
```

Inline AI analysis example:

```markdown
Original recording: ![[Recording 20260531001942.m4a]]
Source note: [[2026-06-05]]

<!-- echo-notes-analysis:start -->
# Analysis Recording 20260531001942

<!-- echo-notes-analysis-item:start work-minutes -->
## Work minutes

### Summary

This is the generated analysis content.
<!-- echo-notes-analysis-item:end work-minutes -->
<!-- echo-notes-analysis:end -->

# Transcribed manuscript Recording 20260531001942

This is the full transcript text.

<!-- echo-notes-transcript-technical:start -->
# Echo Notes Technical Info

<!-- echo-notes-technical-item:start work-minutes -->
## Work minutes

- [echo_notes_analysis_template_id:: work-minutes]
- [echo_notes_analysis_template_name:: Work minutes]
- [echo_notes_analysis_template_version:: 1]
- [echo_notes_analysis_provider:: aliyun-bailian]
- [echo_notes_analysis_model:: deepseek-v4-pro]
- [echo_notes_analysis_generated_at:: 2026-06-01T10:00:00.000Z]

_Generated at: 2026-06-01T10:00:00.000Z; Provider: aliyun-bailian; Model: deepseek-v4-pro_
<!-- echo-notes-technical-item:end work-minutes -->
<!-- echo-notes-transcript-technical:end -->
```

Transcript frontmatter after AI analysis may include:

```yaml
analysis_status: "analysis_done"
analysis_template_ids: [work-minutes, study-notes]
analysis_done_template_ids: [work-minutes, study-notes]
analysis_provider: "aliyun-bailian"
analysis_model: "deepseek-v4-pro"
analysis_started_at: "2026-06-01T10:00:00.000Z"
analysis_updated_at: "2026-06-01T10:03:00.000Z"
analysis_completed_at: "2026-06-01T10:03:00.000Z"
```

## Automation

Echo Notes can optionally watch for Markdown audio links and newly created audio files.

- Markdown audio links: after a Markdown file changes, Echo Notes waits briefly, scans supported audio references outside frontmatter, fenced code blocks, and HTML comments, transcribes missing transcripts, and inserts missing transcript links.
- New audio files: after Obsidian finishes loading the workspace, Echo Notes can transcribe newly created audio files without modifying any source note. Without source-note context, AI analysis uses the default template.
- Transcription-time analysis: when AI analysis is enabled, manual transcription commands choose a template automatically from nearby audio-link keywords and write AI analysis back into the transcript in the background.
- Private source notes: Markdown-link automation skips notes with `echo_notes_private`, `echo_notes_disable_automation`, `echo_notes_disable_auto_transcribe`, or Echo Notes private tags.

All automation options are disabled by default.

## Future Directions

Echo Notes' long-term goal is to evolve from an audio transcription tool into a personal AI Memory Layer. Echo Memory now validates the transcript-to-candidate-to-review-to-relation-to-cross-record-view path. Future work will explore:

- Structured extraction from notes, including tasks, requirements, risks, decisions, action items, acceptance criteria, and retrospective results.
- A searchable personal action database built from meetings, study sessions, interviews, ideas, and work communication.
- Long-term context for Personal Agents, so AI can assist decisions based on the user's real history.
- Broader local model support, so personal memory can stay inside the user's own vault whenever possible.
- Previewable, length-bounded Personal Agent context packages filtered by project, person, time, and evidence status.

## Build

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

Development requires Node.js 22 or newer.

For routine local regression, use the single complete verification entry point:

```bash
npm run verify
```

It checks version consistency across `package.json`, `package-lock.json`, `manifest.json`,
and `versions.json`; then runs all historical automated tests, lint,
typecheck, the production build, the isolated real-Obsidian settings/onboarding UI
regression, staged and unstaged `git diff --check`, and the production dependency
audit. The UI step currently requires macOS with Obsidian Desktop installed. The test
vault must enable `echo-notes` and its `.obsidian/plugins/echo-notes` directory must be
a symlink resolving to this project, rather than a copied build. Override discovery
with `ECHO_NOTES_TEST_VAULT`, `OBSIDIAN_BINARY_PATH`, `OBSIDIAN_DATA_DIR`, or
`OBSIDIAN_ASAR_PATH`; screenshots can be redirected with `ECHO_NOTES_UI_OUTPUT_DIR`.
`npm run package` runs this complete verification automatically before creating release
files, so packaging has the same local UI-environment requirement.

### Release validation

The isolated real-chain gate uses non-private fixtures in the dedicated test vault and removes its temporary Obsidian profile after the run. It validates SiliconFlow `FunAudioLLM/SenseVoiceSmall` transcription followed by Volcengine AgentPlan `doubao-seed-2.0-lite` analysis and Echo Memory extraction. Provide the two keys only through the process environment; the script writes the AgentPlan key into separate analysis and memory `SecretStorage` entries and never prints either value.

```bash
read -s "SILICONFLOW_API_KEY?SiliconFlow API Key: "
export SILICONFLOW_API_KEY
read -s "AGENTPLAN_API_KEY?AgentPlan API Key: "
export AGENTPLAN_API_KEY
npm run verify:real-chain
unset SILICONFLOW_API_KEY AGENTPLAN_API_KEY
```

## Install for Local Testing

1. Use a dedicated test vault.
2. Copy or symlink this folder to `.obsidian/plugins/echo-notes/`. The automated UI verifier requires a symlink to the project root.
3. Run `npm install` and `npm run build`.
4. Enable community plugins in Obsidian.
5. Enable Echo Notes.
6. Configure a provider API key.
7. Insert an audio link and run one of the Echo Notes commands.

## Current Limitations

- Speaker diarization and timestamps are always available for Volcengine AgentPlan real-time transcription, and optional for MOSI offline transcription. They identify speaker numbers, not real names.
- Real-time transcription requires Obsidian desktop and a local filesystem vault.
- The first real-time release supports start and stop only, not pause/resume. A forced exit can lose at most the last short WebM chunk that had not yet been emitted.
- Word-level timestamps are not rendered.
- Universal large-file chunking across all providers is not supported yet. The shared AudioChunkPipeline currently covers Alibaba Bailian `qwen3-asr-flash`, SiliconFlow official or custom transcription models, and MOSI.
- Local Whisper is not supported.
- Long-text analysis uses sequential chunk extraction plus a final synthesis call, so it increases model calls and cost. Matching completed chunks resume after failure or restart, but final synthesis always runs again; whole-text analysis still retries the single request.
- Task Center persists up to 100 safe task summaries and restores retry actions after restart. It is not a background queue and does not provide pause/cancel controls. Segment-level resume is limited to the chunked Alibaba Bailian, SiliconFlow, and MOSI paths; whole-audio requests and other providers restart the request.
- Echo Memory relations require explicit user confirmation and do not automatically detect or resolve conflicts. Cross-record views use explicit subject normalization rather than semantic entity resolution and do not yet provide topic aggregation. Multi-reviewer identity, a vector database, cross-vault sync, external Agent execution, and automatic calendar or note actions are not included yet.

## Contact and Feedback

For questions, feedback, or collaboration, contact the author on WeChat.

- WeChat ID: `ccanbang`

<img src="./assets/wechat-contact.png" alt="WeChat QR code for ccanbang" width="320">
