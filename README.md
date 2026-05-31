<p align="right">
  English | <a href="./README.zh-CN.md">简体中文</a>
</p>

# Echo Notes

Echo Notes is an Obsidian plugin that turns audio files referenced in your vault into readable, searchable, and linkable Markdown transcripts.

The workflow is simple: insert or link an audio file in a Markdown note, run a transcription command, and Echo Notes creates a transcript file and inserts a link back into the original note.

> Privacy notice: Echo Notes uploads the selected audio file to the transcription provider you configure. Do not transcribe audio that you do not want to send to that external service.

## Features

- Configure a transcription provider, API key, base URL, model, and language in Obsidian settings.
- Transcribe the selected audio link in the current note.
- Scan and transcribe all supported audio links in the current note.
- Generate a Markdown transcript file with source metadata.
- Insert a transcript link below the source audio reference.
- Skip existing transcripts and insert missing transcript links.
- Analyze transcript Markdown files with a separate AI model using work minutes, study notes, or product requirement mining templates.
- Generate standalone analysis notes and link them from the transcript.
- Optional automation for newly added Markdown audio links.
- Optional automation for newly created audio files.
- Optional automation for running a default AI analysis after transcription.

## Providers

Implemented providers:

- 硅基流动（SiliconFlow） with `TeleAI/TeleSpeechASR`
- 阿里百炼（Alibaba Bailian） with `qwen3-asr-flash`
- OpenAI（OpenAI） with OpenAI-compatible audio transcription
- Groq（Groq） with OpenAI-compatible audio transcription
- Ollama, Ollama Open WebUI, Google Gemini, OpenRouter, LM Studio, 302.AI, Anthropic, Mistral AI, Together AI, Fireworks AI, Perplexity AI, DeepSeek, xAI, Novita AI, DeepInfra, SambaNova, Cerebras, and Z.AI as OpenAI-compatible transcription presets
- 自定义兼容接口（Custom OpenAI-compatible） for custom `/audio/transcriptions` endpoints

Provider defaults can be changed in settings.

AI analysis uses a separate provider configuration. The default is DeepSeek `deepseek-chat` through an OpenAI-compatible `/chat/completions` endpoint.

## Network and Data Use

Echo Notes makes network requests only when a transcription is triggered.

- SiliconFlow default endpoint: `https://api.siliconflow.cn`
- Alibaba Bailian default endpoint: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- OpenAI default endpoint: `https://api.openai.com/v1`
- Groq default endpoint: `https://api.groq.com/openai/v1`
- AI analysis default endpoint: `https://api.deepseek.com/v1`
- Custom OpenAI-compatible endpoint: user configured

Transcription and analysis API keys are stored separately with Obsidian `SecretStorage`. Transcript and analysis files are written inside your Obsidian vault.

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
- Alibaba Bailian `qwen3-asr-flash`: local files are encoded as Base64 Data URLs, and payloads over 10 MB are blocked before upload.
- OpenAI-compatible providers: files over 25 MB are blocked before upload.

## Configure a Provider

1. Open Obsidian settings.
2. Open the Echo Notes settings tab.
3. Choose a provider.
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

## Configure AI Analysis

1. Open the Echo Notes settings tab.
2. Find the AI analysis section.
3. Keep the default provider as `DeepSeek`, or choose another OpenAI-compatible chat endpoint.
4. Keep Base URL as `https://api.deepseek.com/v1` and Model as `deepseek-chat`, or edit them.
5. Enter the separate analysis API key.
6. Enable automatic analysis after transcription only if you want Echo Notes to create an analysis note after every successful transcript.

Built-in templates:

- Work minutes: Summary, Key decisions, Action items, Risks/Blockers, Open questions.
- Study notes: Core concepts, Key points, Examples, Common confusions, Review checklist.
- Product requirement mining: Users/Scenarios, Pain points, Requirement opportunities, Feature suggestions, Priority, Acceptance criteria, Open questions.

## Usage

### Transcribe selected audio

Select an audio reference in the current Markdown note:

```markdown
![[Recording 20260531001942.m4a]]
```

Run the command `Echo Notes: Transcribe selected audio`.

Echo Notes resolves the audio file, calls the configured provider, creates a transcript, and inserts a transcript link below the audio reference.

### Transcribe all audio files in the current note

Add one or more audio links to a note:

```markdown
![[Recording 20260531001942.m4a]]
![[Recording 20260531002010.m4a]]
```

Run the command `Echo Notes: Transcribe all audio files in current note`.

### Generate AI analysis

Open a `.transcript.md` note, or a note with `type: audio-transcript` in frontmatter, then run one of these commands:

- `Echo Notes: Analyze current transcript as work minutes`
- `Echo Notes: Analyze current transcript as study notes`
- `Echo Notes: Analyze current transcript as product requirement mining`

Echo Notes creates a standalone analysis note and inserts a deduplicated analysis link block at the end of the transcript. Existing analysis files with the same name are overwritten.

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

Analysis link example:

```markdown
<!-- echo-notes-analysis-links:start -->
## AI Analysis

- [[Recording 20260531001942.transcript.analysis.work-minutes|Work minutes]]
<!-- echo-notes-analysis-links:end -->
```

Generated analysis file:

```text
Recording 20260531001942/Recording 20260531001942.transcript.analysis.work-minutes.md
```

## Automation

Echo Notes can optionally watch for Markdown audio links and newly created audio files.

- Markdown audio links: after a Markdown file changes, Echo Notes waits briefly, scans supported audio references, transcribes missing transcripts, and inserts missing transcript links.
- New audio files: after Obsidian finishes loading the workspace, Echo Notes can transcribe newly created audio files without modifying any source note.
- Post-transcription analysis: after a transcript is created, Echo Notes can run the default analysis template and write a standalone analysis note.

All automation options are disabled by default.

## Future Directions

- Custom analysis templates and prompt editing.
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
- AI analysis does not yet support custom templates or long-text chunking.
- There is no advanced task queue UI yet.
