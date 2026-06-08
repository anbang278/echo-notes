<p align="right">
  English | <a href="./README.zh-CN.md">简体中文</a>
</p>

# Echo Notes

Echo Notes is a personal action capture and AI memory-building plugin for Obsidian. Starting from audio transcription, it turns meetings, ideas, study notes, interviews, and everyday thinking into Markdown text, then uses configurable AI analysis templates to turn raw voice into searchable, linkable, reviewable, and reusable personal knowledge assets.

The goal is not just to turn speech into text. Echo Notes is designed to help your actions, thoughts, and decisions continuously enter your personal knowledge system, so they can eventually become long-term context for a Personal Agent. Every recording captures a real moment of action; every transcript becomes a memory that AI can understand; every structured analysis adds experience to a future AI version of yourself.

The workflow is simple: insert or link an audio file in a Markdown note, run a transcription command, and Echo Notes creates a `.transcript.md` file and inserts a "view transcript" link back into the source note. If AI analysis is enabled, Echo Notes can choose an analysis template from nearby keywords and write structured analysis back into the matching transcript.

> Privacy notice: Echo Notes makes network requests only when transcription or AI analysis is triggered. Transcription uploads the selected audio file to the configured transcription provider. AI analysis uploads the transcript text to the configured analysis provider. Do not process content that should not be sent to external services.

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

- Configure a transcription provider, API key, base URL, model, and language in Obsidian settings.
- Transcribe the selected audio link in the current note.
- Scan and transcribe all supported audio links in the current note.
- Generate a Markdown transcript file with source metadata.
- Insert a transcript link below the source audio reference.
- Skip reusable existing transcripts and insert missing transcript links; reuse requires matching source audio path, size, mtime, transcription provider, model, and `status: done`.
- Avoid transcript filename collisions in a custom output folder by adding a stable source-path hash to generated transcript filenames.
- Show the selected transcription provider's upload mode, endpoint shape, file limit, chunking, language, timestamp, and diarization capabilities in settings.
- Run a local transcription-provider configuration check for API key, Base URL, model, HTTP risk, endpoint shape, and capability-limit warnings without uploading audio.
- Standardize transcription provider errors and redact API keys, authorization headers, Base64 audio payloads, and overlong responses before showing or writing failure messages.
- Use a shared AudioChunkPipeline core for long-audio preparation, chunk progress events, segment transcription, text merging, trace id aggregation, raw segment collection, and releasing completed chunk audio buffers.
- Open an in-memory Task Center from the ribbon or command palette to inspect transcription and AI analysis status, failures, durations, providers, models, outputs, and retry failed tasks.
- Optional manual-upload confirmation that previews provider, base URL, model, file size, and HTTP risks before sending audio; automation skips uploads when this confirmation mode is enabled.
- Enable or disable Obsidian's core plugin Audio recorder from Echo Notes settings, with configurable default hotkeys for recorder proxy commands.
- Analyze transcript Markdown files with a separate AI model using built-in general, learning, product, and role-based work templates.
- Run AI analysis in the background and write the result back into the matching transcript.
- Automatically choose an AI analysis template from source-note frontmatter, tags, or keywords found within three lines above or below the source audio link, with a configurable default template as fallback.
- Configure each analysis template with a name, recognition keywords, system prompt, and custom prompt.
- Optional automation for newly added Markdown audio links.
- Optional automation for newly created audio files.
- Markdown audio-link automation deduplicates processed links in the current plugin session using source note, normalized audio path, raw link text, and occurrence order.

## Providers

Implemented transcription providers:

- 硅基流动（SiliconFlow） with `TeleAI/TeleSpeechASR`
- 阿里百炼（Alibaba Bailian） with `qwen3-asr-flash`
- OpenAI（OpenAI） with OpenAI-compatible audio transcription
- Groq（Groq） with OpenAI-compatible audio transcription
- Ollama, Ollama Open WebUI, Google Gemini, OpenRouter, LM Studio, 302.AI, Anthropic, Mistral AI, Together AI, Fireworks AI, Perplexity AI, DeepSeek, xAI, Novita AI, DeepInfra, SambaNova, Cerebras, and Z.AI as OpenAI-compatible transcription presets
- 自定义兼容接口（Custom OpenAI-compatible） for custom `/audio/transcriptions` endpoints

Provider defaults can be changed in settings. The settings tab also shows a capability summary for the selected transcription provider, including upload mode, endpoint shape, size limit, chunking support, language parameter support, timestamp support, and speaker diarization support.

The settings tab also includes a local "Check transcription configuration" action. It checks API key presence, Base URL format, example URLs, non-local HTTP risks, model hints, endpoint shape, and known capability limits. This check does not upload audio and does not call the provider.

AI analysis uses a separate provider configuration. The default is Alibaba Bailian `deepseek-v4-pro` through an OpenAI-compatible `/chat/completions` endpoint. The analysis provider list mirrors the transcription provider list; optional chat presets must support `{Base URL}/chat/completions`.

## Network and Data Use

Echo Notes makes network requests only when a transcription or AI analysis is triggered.

- SiliconFlow default endpoint: `https://api.siliconflow.cn`
- Alibaba Bailian default endpoint: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- OpenAI default endpoint: `https://api.openai.com/v1`
- Groq default endpoint: `https://api.groq.com/openai/v1`
- AI analysis default endpoint: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Custom OpenAI-compatible endpoint: user configured

Transcription uploads the selected audio file to the configured transcription provider. AI analysis uploads the transcript text to the configured analysis provider. Transcription and analysis API keys are stored separately with Obsidian `SecretStorage`. Transcript files and inline AI analysis results are written inside your Obsidian vault.

If "Confirm before manual transcription upload" is enabled in settings, Echo Notes shows a confirmation dialog before manual transcription uploads. The dialog lists the provider, Base URL, model, file size, and HTTP risk warnings. Automation skips uploads while this confirmation mode is enabled so audio is not sent in the background without user confirmation.

## Supported Audio Formats

- `mp3`
- `mp4`
- `mpeg`
- `mpga`
- `m4a`
- `wav`
- `webm`

Provider limits:

- SiliconFlow: files over 50 MB are blocked before upload.
- Alibaba Bailian `qwen3-asr-flash`: local files are encoded as Base64 Data URLs. If the full file would exceed the 10 MB Base64 input limit, Echo Notes decodes the file locally, converts it to 16 kHz mono WAV segments, transcribes each segment in order, and writes completed segments back to the same transcript draft.
- OpenAI-compatible providers: files over 25 MB are blocked before upload.

Capability matrix:

| Provider family | Upload mode | Endpoint shape | Limit | Echo Notes chunking | Language parameter | Timestamp | Speaker diarization |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Alibaba Bailian `qwen3-asr-flash` | Base64 Data URL | `/chat/completions` + `input_audio` | 10 MB encoded input | Yes | Yes | No | No |
| SiliconFlow `TeleAI/TeleSpeechASR` | multipart | dedicated SiliconFlow endpoint | 50 MB audio file | No | No | No | No |
| OpenAI-compatible presets and custom endpoints | multipart | `/audio/transcriptions` | 25 MB audio file | No | Yes | No | No |

Long-audio chunking currently applies only to Alibaba Bailian `qwen3-asr-flash`. Chunked transcripts include segment headings such as `### Segment 01（00:00-03:00）` so you can match text back to the original recording. If local browser audio decoding fails, Echo Notes writes a failed transcript with the reason.

## Configure a Transcription Provider

1. Open Obsidian settings.
2. Open the Echo Notes settings tab.
3. Choose a transcription provider.
4. Confirm or edit Base URL and Model.
5. Enter the provider API key.
6. Keep Language as `auto`, or set a provider-supported language code.
7. Choose the copy language for inserted links and generated template labels.

Recommended defaults:

| Provider | Base URL | Model |
| --- | --- | --- |
| 硅基流动（SiliconFlow） | `https://api.siliconflow.cn` | `TeleAI/TeleSpeechASR` |
| 阿里百炼（Alibaba Bailian） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-asr-flash` |
| OpenAI（OpenAI） | `https://api.openai.com/v1` | `whisper-1` |
| Groq（Groq） | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` |
| 自定义兼容接口（Custom OpenAI-compatible） | your endpoint | `whisper-1` |

## Configure the Obsidian Core Plugin Audio Recorder

Echo Notes relies on Obsidian's `Audio recorder` core plugin to create recording files. You can enable or disable that core plugin from the "Obsidian core plugin audio recorder" section at the top of Echo Notes settings.

That section also registers Echo Notes proxy commands with configurable default hotkeys:

| Action | Command | Default hotkey |
| --- | --- | --- |
| Start the Obsidian core plugin audio recorder | `Echo Notes: Start Obsidian core plugin audio recorder` | `Ctrl+L` |
| Stop the Obsidian core plugin audio recorder | `Echo Notes: Stop Obsidian core plugin audio recorder` | `Ctrl+S` |
| Transcribe all audio files in the current note | `Echo Notes: Transcribe all audio files in current note` | `Ctrl+Z` |

These hotkeys belong to Echo Notes commands. Echo Notes does not directly rewrite user hotkeys for Obsidian core plugin commands `audio-recorder:start` or `audio-recorder:stop`. If you manually override the matching Echo Notes commands in Obsidian Hotkeys, Obsidian uses your manual hotkey settings first.

## Configure AI Analysis

1. Open the Echo Notes settings tab.
2. Enable AI analysis.
3. Keep the default provider as `Alibaba Bailian`, or choose another provider that supports OpenAI-compatible Chat Completions.
4. Keep Base URL as `https://dashscope.aliyuncs.com/compatible-mode/v1` and Model as `deepseek-v4-pro`, or edit them. Switching providers fills that provider's editable default Base URL and model.
5. Enter the separate analysis API key.
6. Choose the default analysis template used when no keyword is found near the audio link.
7. Edit, enable, disable, restore, or add templates in the analysis template settings.

Built-in templates:

- Work minutes: Summary, Key decisions, Action items, Risks/Blockers, Open questions.
- Study notes: Core concepts, Key points, Examples, Common confusions, Review checklist.
- Product requirement mining: Users/Scenarios, Pain points, Requirement opportunities, Feature suggestions, Priority, Acceptance criteria, Open questions.
- Role-based work templates are included for managers, product managers, project managers, engineering/technical roles, sales, customer success, operations, and HR. They are disabled by default; enable the ones you need in settings and adjust recognition keywords for your workflow.

Custom templates are supported. Each template has a name, recognition keywords, system prompt, custom prompt, and enabled switch. Enabled templates participate in keyword matching; disabled templates keep their configuration but are not used automatically.

## Usage

### Transcribe selected audio

Select an audio reference in the current Markdown note:

```markdown
![[Recording 20260531001942.m4a]]
```

Run the command `Echo Notes: Transcribe selected audio`.

Echo Notes resolves the audio file, calls the configured provider, creates a transcript, and inserts a transcript link below the audio reference.

If AI analysis is enabled, Echo Notes first checks the source note frontmatter for `echo_notes_analysis_template`, `echo_notes_template`, or `analysis_template`. The value can be an enabled template id or template name. If no enabled frontmatter template is found, Echo Notes checks frontmatter `tags` and inline `#tags` against enabled template ids, names, and recognition keywords. If no tag matches, Echo Notes reads the three lines above and below the audio link and chooses an enabled template by recognition keyword. After the transcript link is inserted, AI analysis runs in the background; when the model returns, the result is written before the transcript section in the same `.transcript.md` file. If no keyword is found, Echo Notes uses the configured default template.

### Transcribe all audio files in the current note

Add one or more audio links to a note:

```markdown
![[Recording 20260531001942.m4a]]
![[Recording 20260531002010.m4a]]
```

Run the command `Echo Notes: Transcribe all audio files in current note`.

If AI analysis is enabled, each audio link is matched independently. Different recordings in the same note can use different templates by placing different keywords near each audio link.

### AI analysis generation

AI analysis runs automatically after a transcript is created or reused. Echo Notes inserts the transcript link first and does not wait for the model response. If "skip existing transcript" is enabled, running the transcription command again reuses only a `status: done` transcript whose source audio path, size, mtime, provider, and model still match, then generates or updates AI analysis in the background.

Echo Notes writes AI analysis into a controlled block before the transcript section. Running the same template again replaces that template's existing result instead of stacking duplicates; different templates are appended inside the same AI analysis block.

Frontmatter template selection applies to the whole source note and has priority over tags and nearby keywords. Tags apply to the whole source note and have priority over nearby keywords. Keywords are matched only against the source note lines around the audio link, not against the transcript body. If multiple templates match the same context, Echo Notes uses the first enabled template in settings order.

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

_Generated at: 2026-06-01T10:00:00.000Z; Provider: aliyun-bailian; Model: deepseek-v4-pro_

### Summary

This is the generated analysis content.
<!-- echo-notes-analysis-item:end work-minutes -->
<!-- echo-notes-analysis:end -->

# Transcribed manuscript Recording 20260531001942

This is the full transcript text.
```

## Automation

Echo Notes can optionally watch for Markdown audio links and newly created audio files.

- Markdown audio links: after a Markdown file changes, Echo Notes waits briefly, scans supported audio references outside frontmatter, fenced code blocks, and HTML comments, transcribes missing transcripts, and inserts missing transcript links.
- New audio files: after Obsidian finishes loading the workspace, Echo Notes can transcribe newly created audio files without modifying any source note. Without source-note context, AI analysis uses the default template.
- Transcription-time analysis: when AI analysis is enabled, manual transcription commands choose a template automatically from nearby audio-link keywords and write AI analysis back into the transcript in the background.

All automation options are disabled by default.

## Future Directions

Echo Notes' long-term goal is to evolve from an audio transcription tool into a personal AI Memory Layer. Future work will explore:

- Structured extraction from notes, including tasks, requirements, risks, decisions, action items, acceptance criteria, and retrospective results.
- Batch analysis across multiple transcripts to produce project-level, topic-level, and timeline-level summaries.
- A searchable personal action database built from meetings, study sessions, interviews, ideas, and work communication.
- Long-term context for Personal Agents, so AI can assist decisions based on the user's real history.
- Broader local model support, so personal memory can stay inside the user's own vault whenever possible.
- Long-transcript chunking, merging, review, and multi-pass analysis workflows.

## Build

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

## Install for Local Testing

1. Use a dedicated test vault.
2. Copy or symlink this folder to `.obsidian/plugins/echo-notes/`.
3. Run `npm install` and `npm run build`.
4. Enable community plugins in Obsidian.
5. Enable Echo Notes.
6. Configure a provider API key.
7. Insert an audio link and run one of the Echo Notes commands.

## Current Limitations

- Speaker diarization is not supported.
- Timestamped transcript segments are not supported.
- Universal large-file chunking across all providers is not supported yet. The shared AudioChunkPipeline core exists, but provider coverage currently applies only to Alibaba Bailian `qwen3-asr-flash`.
- Local Whisper is not supported.
- AI analysis does not yet support long-text chunking.
- Task Center is currently an in-memory status panel. Persistent queues, pause/cancel controls, and restart-safe resume are not supported yet.
