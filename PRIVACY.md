# Privacy

Codfish is a desktop application that runs entirely on your computer. It does not have a server, a backend, an account system, or any infrastructure that processes your data.

## What Codfish does with your data

**Your media files, transcripts, and project files never leave your machine.** Audio and video files are decoded locally by the bundled ffmpeg, transcribed locally by the bundled WhisperX engine (running on your CPU or GPU), and saved as project files in locations you choose. Codfish does not upload, copy, sync, or transmit any of this data to any remote service.

## What Codfish stores on your machine

- **Project files (`.cod`)** — wherever you save them
- **Recovery snapshots** — auto-saved copies in your OS app-data directory, used to recover your work if Codfish crashes mid-edit
- **Waveform peaks cache** — pre-computed audio waveforms in your OS app-data directory, so timelines load instantly the second time you open a file
- **Logs** — diagnostic logs in your OS app-data directory, used for troubleshooting
- **Transcription engine** — the WhisperX-based sidecar binary, downloaded on first launch into your OS app-data directory

You can delete all Codfish data by uninstalling the app and removing its app-data directory.

## What Codfish sends over the network

Codfish makes a small, fixed set of network calls:

1. **Update check.** On startup, Codfish checks GitHub for a newer version of the app. No personal information is sent; this is the same as visiting the releases page in your browser.
2. **Transcription engine download.** On first launch, and whenever a new engine version is released, Codfish downloads the engine binary from GitHub Releases. No personal information is sent.
3. **Bug reports and feature requests.** *Only when you explicitly click the in-app "Report a bug" or "Request a feature" button and submit the form*, Codfish sends what you typed, plus the app version, plus any log file you chose to attach, to the project's GitHub Issues. Nothing is sent in the background, nothing is sent automatically, and nothing about your project or media files is sent unless you attach a log file yourself.

There are **no analytics**, **no telemetry**, **no crash reporters that auto-submit**, **no usage tracking**, and **no third-party services** of any kind.

## What Codfish does *not* do

- Codfish does not have user accounts.
- Codfish does not collect your name, email, IP address, or any identifying information.
- Codfish does not send your media, transcripts, or project files anywhere.
- Codfish does not contact servers other than GitHub for the three purposes listed above.
- Codfish does not contain advertising, marketing tracking, or analytics SDKs.

## Bug reports filed through the in-app reporter

When you submit a bug report or feature request through Codfish, the resulting GitHub issue is **public** on the project's repository. Do not include sensitive information in bug report descriptions or attached logs. If you need to report something privately, see [SECURITY.md](SECURITY.md).

## Changes to this policy

If Codfish's data handling ever changes, this document will be updated and the change will be called out in the release notes.

## Questions

Open a discussion at https://github.com/jbohlken/codfish/discussions or file an issue.
