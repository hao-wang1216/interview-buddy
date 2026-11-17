# Interview Buddy · 面试搭子

Interview Buddy is a standalone Windows desktop app for candidates preparing for interviews. It combines a local knowledge library and application tracker with a DeepSeek interview coach and an optional live transcription overlay.

## Features

- **Interview consultation** offers résumé and job-description matching, STAR story coaching, technical follow-up questions, and answer feedback. DeepSeek can call the tools automatically. The conversation shows the tools used and their results.
- **Local knowledge library** imports TXT, Markdown, and text-based PDFs up to 50 MB per file. You can verify extracted facts against their source before the coach uses them. PDF imports support up to 120 pages and 240,000 extracted characters.
- **Web search** uses DeepSeek Search for current public information and preserves source links in the conversation history.
- **Application tracker** records companies, roles, interview dates, rounds, statuses, and notes.
- **Live overlay** transcribes system audio and the default microphone separately with Whisper Small. Move and resize the overlay, select a transcript line to ask for a reference answer, or toggle whether the overlay is included in supported Windows screen sharing.

## Quick start

Requires Windows x64, Git and [Node.js](https://nodejs.org/) 24 or newer. Live transcription also requires [64-bit Python 3.12](https://www.python.org/downloads/windows/) on your PATH and about 1 GB of free space for its dependencies and model.

```powershell
git clone https://github.com/hao-wang1216/interview-buddy.git
cd interview-buddy
npm ci
npm run start
```

After the first build, reopen the app with `Start-InterviewBuddy.cmd`. Open **配置 DeepSeek** to save and test your DeepSeek API key. The library and application tracker are available without a key. Consultation, reference answers and web search use your DeepSeek account.

### Enable live transcription

From the repository directory:

```powershell
python .\tools\provision-speech.py
```

The script installs faster-whisper in a project-local environment and downloads the multilingual [Whisper Small model](https://huggingface.co/Systran/faster-whisper-small) into `.runtime/speech`. Transcription then runs offline. In the app, click **开始实时面试**, select the audio sources, and click **开始监听**.

The overlay starts in **共享时隐藏** mode. Windows 10 version 2004 or newer can exclude protected windows from capture through supported APIs. Use your meeting app's sharing preview to check what it displays.

## Data and tests

Documents, confirmed facts, transcripts, tool summaries, and the application tracker are stored in local SQLite. Electron uses Windows system encryption for the saved API key. Cloud answers send the current question, recent conversation context, and relevant retrieved material to DeepSeek as needed. The web search tool sends search terms to DeepSeek Search, which is billed separately under [DeepSeek's search terms](https://api-docs.deepseek.com/guides/search/). Transcription audio is processed locally and the app saves text.

`npm test` checks persistence, PDF text extraction, citations, mock DeepSeek responses and tool calling. `npm run test:desktop` exercises the Windows app with a temporary profile. To additionally check system playback, Mandarin transcription and capture protection, set `BUDDY_TEST_WAV` to a local Mandarin WAV containing “水下目标”.

## Third-party projects

Runtime dependencies include [Electron](https://github.com/electron/electron), [PDF.js](https://github.com/mozilla/pdf.js), [faster-whisper](https://github.com/SYSTRAN/faster-whisper), and [Whisper Small for CTranslate2](https://huggingface.co/Systran/faster-whisper-small). Their releases retain their upstream licenses. Model weights and third-party binaries are fetched separately.

The interview tools draw on the preparation approaches described by [interview-skill](https://github.com/shengxuan-create/interview-skill), [interview-my-project](https://github.com/WarlCang/interview-my-project), and [Tech Interview Handbook](https://github.com/yangshun/tech-interview-handbook).

## License

Interview Buddy source code is released under the [MIT License](LICENSE).
