<p align="right">
  English | <a href="./README.zh-CN.md">简体中文</a>
</p>

# Echo Notes

Echo Notes is an Obsidian plugin for audio transcription and knowledge capture. It extends the natural recording workflow in Obsidian by turning audio files in your vault into Markdown transcripts, then using configurable prompt templates to generate scenario-specific AI analysis inside the same vault.

The goal is not just to turn speech into text. Echo Notes is designed to help recordings enter your personal knowledge management workflow. Meeting recordings, voice memos, study notes, and user interviews can become readable, searchable, linkable, reviewable, and reusable Markdown knowledge assets.

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

## Features

- Configure a transcription provider, API key, base URL, model, and language in Obsidian settings.
- Transcribe the selected audio link in the current note.
- Scan and transcribe all supported audio links in the current note.
- Generate a Markdown transcript file with source metadata.
- Insert a transcript link below the source audio reference.
- Skip existing transcripts and insert missing transcript links.
- Enable or disable Obsidian's core plugin Audio recorder from Echo Notes settings, with configurable default hotkeys for recorder proxy commands.
- Analyze transcript Markdown files with a separate AI model using built-in general, learning, product, and role-based work templates.
- Run AI analysis in the background and write the result back into the matching transcript.
- Automatically choose an AI analysis template from keywords found within three lines above or below the source audio link, with a configurable default template as fallback.
- Configure each analysis template with a name, recognition keywords, system prompt, and custom prompt.
- Optional automation for newly added Markdown audio links.
- Optional automation for newly created audio files.

## Providers

Implemented transcription providers:

- 硅基流动（SiliconFlow） with `TeleAI/TeleSpeechASR`
- 阿里百炼（Alibaba Bailian） with `qwen3-asr-flash`
- OpenAI（OpenAI） with OpenAI-compatible audio transcription
- Groq（Groq） with OpenAI-compatible audio transcription
- Ollama, Ollama Open WebUI, Google Gemini, OpenRouter, LM Studio, 302.AI, Anthropic, Mistral AI, Together AI, Fireworks AI, Perplexity AI, DeepSeek, xAI, Novita AI, DeepInfra, SambaNova, Cerebras, and Z.AI as OpenAI-compatible transcription presets
- 自定义兼容接口（Custom OpenAI-compatible） for custom `/audio/transcriptions` endpoints

Provider defaults can be changed in settings.

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

If AI analysis is enabled, Echo Notes reads the three lines above and below the audio link and chooses an enabled template by recognition keyword. After the transcript link is inserted, AI analysis runs in the background; when the model returns, the result is written before the transcript section in the same `.transcript.md` file. If no keyword is found, Echo Notes uses the configured default template.

### Transcribe all audio files in the current note

Add one or more audio links to a note:

```markdown
![[Recording 20260531001942.m4a]]
![[Recording 20260531002010.m4a]]
```

Run the command `Echo Notes: Transcribe all audio files in current note`.

If AI analysis is enabled, each audio link is matched independently. Different recordings in the same note can use different templates by placing different keywords near each audio link.

### AI analysis generation

AI analysis runs automatically after a transcript is created or reused. Echo Notes inserts the transcript link first and does not wait for the model response. If a transcript already exists and "skip existing transcript" is enabled, running the transcription command again reuses the transcript and generates or updates AI analysis in the background.

Echo Notes writes AI analysis into a controlled block before the transcript section. Running the same template again replaces that template's existing result instead of stacking duplicates; different templates are appended inside the same AI analysis block.

Keywords are matched only against the source note lines around the audio link, not against the transcript body. If multiple templates match the same context, Echo Notes uses the first enabled template in settings order.

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
<!-- echo-notes-analysis:start -->
## AI Analysis

<!-- echo-notes-analysis-item:start work-minutes -->
### Work minutes

_Generated at: 2026-06-01T10:00:00.000Z; Provider: aliyun-bailian; Model: deepseek-v4-pro_

## Summary

This is the generated analysis content.
<!-- echo-notes-analysis-item:end work-minutes -->
<!-- echo-notes-analysis:end -->
```

## Automation

Echo Notes can optionally watch for Markdown audio links and newly created audio files.

- Markdown audio links: after a Markdown file changes, Echo Notes waits briefly, scans supported audio references, transcribes missing transcripts, and inserts missing transcript links.
- New audio files: after Obsidian finishes loading the workspace, Echo Notes can transcribe newly created audio files without modifying any source note. Without source-note context, AI analysis uses the default template.
- Transcription-time analysis: when AI analysis is enabled, manual transcription commands choose a template automatically from nearby audio-link keywords and write AI analysis back into the transcript in the background.

All automation options are disabled by default.

## Future Directions

- Batch analysis across multiple transcripts.
- Structured extraction for tasks, requirements, risks, and acceptance criteria.
- Long-transcript chunking, merge, and review workflows.
- Broader local model support.

## Build

```bash
npm install
npm run build
```

Run smoke tests:

```bash
npm test
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
- Large-file chunking is not supported.
- Local Whisper is not supported.
- AI analysis does not yet support long-text chunking.
- There is no advanced task queue UI yet.
