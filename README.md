# Echo Notes

Echo Notes is an Obsidian plugin that turns audio files referenced in your vault into readable, searchable, and linkable Markdown transcripts.

The plugin is designed for a common note-taking workflow: insert or link an audio file in a Markdown note, run a transcription command, and Echo Notes creates a transcript file and inserts a link back into the original note.

> Privacy notice: Echo Notes uploads the selected audio file to the transcription provider you configure. Do not transcribe audio that you do not want to send to that external service.

## Features

- Configure a transcription provider, API key, base URL, model, and language in Obsidian settings.
- Supports SiliconFlow with `TeleAI/TeleSpeechASR`.
- Supports Alibaba Bailian / DashScope with `qwen3-asr-flash`.
- Transcribe the selected audio link in the current note.
- Scan and transcribe all supported audio links in the current note.
- Generate a Markdown transcript file with source metadata.
- Insert a transcript link below the source audio reference.
- Skip existing transcripts and insert missing transcript links.
- Optional automation for newly added Markdown audio links.
- Optional automation for newly created audio files.

## Network and Data Use

Echo Notes makes network requests only when a transcription is triggered.

- SiliconFlow provider: sends audio to `https://api.siliconflow.cn` by default.
- Alibaba Bailian provider: sends audio to `https://dashscope.aliyuncs.com/compatible-mode/v1` by default.
- The API key is stored with Obsidian `SecretStorage`.
- Transcript files are written inside your Obsidian vault.

You can change the provider base URL in settings. If you use a custom endpoint, audio is sent to that endpoint instead.

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

## Configure SiliconFlow

1. Open Obsidian settings.
2. Open the Echo Notes settings tab.
3. Set:
   - Provider: `SiliconFlow`
   - API Key: your SiliconFlow API key
   - Base URL: `https://api.siliconflow.cn`
   - Model: `TeleAI/TeleSpeechASR`
   - Language: `auto`

## Configure Alibaba Bailian

1. Open Obsidian settings.
2. Open the Echo Notes settings tab.
3. Set:
   - Provider: `阿里百炼`
   - API Key: your DashScope API key
   - Base URL: `https://dashscope.aliyuncs.com/compatible-mode/v1`
   - Model: `qwen3-asr-flash`
   - Language: `auto`

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

- Only SiliconFlow and Alibaba Bailian providers are implemented.
- Speaker diarization is not supported.
- Timestamped transcript segments are not supported.
- Large-file chunking is not supported.
- Local Whisper is not supported.
- There is no advanced task queue UI yet.

## 中文说明

Echo Notes 是一个 Obsidian 音频转写与知识沉淀插件。它可以识别 Vault 中笔记引用的音频文件，调用你配置的 Provider 生成 Markdown 转写稿，并在原始音频引用下方插入转写稿链接。

隐私提醒：Echo Notes 只在触发转写时发起网络请求，但会把所选音频上传到你配置的转写服务。请确认音频内容适合发送到该外部服务。

常用命令：

- `Echo Notes: Transcribe selected audio`：转写当前选中的音频链接。
- `Echo Notes: Transcribe all audio files in current note`：扫描并转写当前笔记中的所有支持音频。
