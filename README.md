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
- Optional automation for newly added Markdown audio links.
- Optional automation for newly created audio files.

## Providers

Implemented providers:

- 硅基流动（SiliconFlow） with `TeleAI/TeleSpeechASR`
- 阿里百炼（Alibaba Bailian） with `qwen3-asr-flash`
- OpenAI（OpenAI） with OpenAI-compatible audio transcription
- Groq（Groq） with OpenAI-compatible audio transcription
- 自定义兼容接口（Custom OpenAI-compatible） for custom `/audio/transcriptions` endpoints

Provider defaults can be changed in settings.

## Network and Data Use

Echo Notes makes network requests only when a transcription is triggered.

- SiliconFlow default endpoint: `https://api.siliconflow.cn`
- Alibaba Bailian default endpoint: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- OpenAI default endpoint: `https://api.openai.com/v1`
- Groq default endpoint: `https://api.groq.com/openai/v1`
- Custom OpenAI-compatible endpoint: user configured

The API key is stored with Obsidian `SecretStorage`. Transcript files are written inside your Obsidian vault.

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

Recommended defaults:

| Provider | Base URL | Model |
| --- | --- | --- |
| 硅基流动（SiliconFlow） | `https://api.siliconflow.cn` | `TeleAI/TeleSpeechASR` |
| 阿里百炼（Alibaba Bailian） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-asr-flash` |
| OpenAI（OpenAI） | `https://api.openai.com/v1` | `whisper-1` |
| Groq（Groq） | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` |
| 自定义兼容接口（Custom OpenAI-compatible） | your endpoint | `whisper-1` |

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

## Automation

Echo Notes can optionally watch for Markdown audio links and newly created audio files.

- Markdown audio links: after a Markdown file changes, Echo Notes waits briefly, scans supported audio references, transcribes missing transcripts, and inserts missing transcript links.
- New audio files: after Obsidian finishes loading the workspace, Echo Notes can transcribe newly created audio files without modifying any source note.

Both automation options are disabled by default.

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
- There is no advanced task queue UI yet.
