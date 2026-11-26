# Privacy

Effective: July 28, 2026

YouTube Digest is a GitHub-only, bring-your-own-key Chrome extension. It has no YouTube Digest account, developer-operated backend, analytics, advertising, or telemetry.

## Data the extension handles

Depending on the feature you use, YouTube Digest handles:

- the canonical URL and video ID of the active YouTube video;
- transcript text and timestamps;
- video metadata such as title, channel, description, and duration;
- text you select in the transcript and nearby transcript context;
- transcript context around a timestamped note;
- content you ask to translate;
- notes you save;
- Supadata, TokenRouter, and Google Gemini configuration, including API keys; and
- cached transcript, timeline chapter, executive digest, and translation results.

## Where data goes

### Supadata

YouTube Digest sends the canonical YouTube video URL to `https://api.supadata.ai` with your Supadata API key. Supadata returns the transcript and timestamps. A Supadata key is required for transcript retrieval.

### AI Providers (TokenRouter and Google Gemini)

This local build supports two direct AI providers selectable in Settings:

1. **TokenRouter** (`https://tokenrouter.cheap/v1`, default `deepseek-v4.1-flash`, supporting `deepseek-v4.1-flash`, `gemini-3.5-flash`, `gpt-5.5`, `claude-sonnet-5-5`, and `gemini-4-argon`).
2. **Google Gemini API** (`https://generativelanguage.googleapis.com/v1beta`, default `gemini-4-neon`, supporting `gemini-4-neon`, `gemini-4-carbon`, `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-3.8-flash`, and `gemini-3.5-flash`). Compatible with Google AI Studio keys, including keys linked to Google AI Ultra monthly promotional credits. Keys are sent only in the `x-goog-api-key` HTTP header, never in URL query strings.

Depending on the feature you use, the active AI provider receives:

- transcript plus relevant title, channel, description, or duration for an executive digest or timeline chapter outline;
- selected text plus nearby transcript context for an explanation;
- small semantic transcript batches currently needed for progressive Chinese translation, or requested overview, chapter, or note content;
- nearby transcript context and video metadata when polishing a saved note.

Endpoints are fixed to `https://tokenrouter.cheap/v1` and `https://generativelanguage.googleapis.com/v1beta`. To use another provider, you must adapt your own local source copy and its permissions. The Settings page provides a coding-agent prompt for that purpose and warns you never to include an API key in the prompt or chat.

Requests go directly from the extension to Supadata and your selected AI provider (TokenRouter or Google Gemini). They are authenticated with the keys you supply. YouTube Digest's developer does not proxy or receive these requests.

Those services process data under their own terms, privacy policies, retention practices, and account settings. Do not send confidential, personal, or regulated content unless their terms and your obligations permit it.

## Local storage and retention

YouTube Digest uses Chrome's local extension storage, not a YouTube Digest cloud service.

- Supadata and TokenRouter settings and API keys remain on the device in Chrome's extension storage.
- Saved notes remain until you delete them or remove/clear the extension's data. The extension keeps up to 100 notes.
- Recent transcript, digest, and per-segment translation cache entries are stored
  locally. The cache is limited to 20 videos, and entries older than 30 days are
  removed when the side panel opens.

Chrome extension storage is not a password vault. Anyone with sufficient access to your browser profile or device may be able to recover locally stored keys or content. Use scoped keys where providers support them, set spending limits, and rotate or revoke a key if the device or browser profile is compromised.

To remove data:

- delete individual saved notes in YouTube Digest;
- use the Options page to clear cached digests, delete all notes, or reset all extension data;
- remove the extension or clear its stored data from Chrome to delete all local settings, keys, notes, and cache entries; and
- revoke keys in the Supadata or TokenRouter dashboard to stop their future use.

Clearing local data does not delete information already processed or retained by Supadata or TokenRouter. Use each service's controls for service-side requests.

## Permissions

YouTube Digest uses Chrome permissions for these purposes:

- `sidePanel`: display the YouTube Digest interface beside YouTube.
- `storage`: store settings, keys, notes, and cached results locally.
- `tabs`: identify and interact with the active YouTube tab.
- `scripting`: coordinate the extension's YouTube page controls.
- YouTube host access: read the active video's URL and metadata and provide timestamp controls.
- Supadata host access: retrieve transcripts.
- TokenRouter host access: provide AI digests, chapters, explanations, translation, and note polishing through TokenRouter.
- Google Gemini API host access (`generativelanguage.googleapis.com`): provide AI digests, chapters, explanations, translation, and note polishing directly through Google Gemini when selected in Settings.

YouTube Digest does not use these permissions to monitor general browsing activity.

## No sale or advertising use

YouTube Digest does not sell personal information, build advertising profiles, or share data with data brokers. It does not include analytics SDKs.

## Changes

Privacy-relevant changes will be documented in this file and in the repository history. Review updates before installing a new version.

## Questions

This repository does not provide a public support or issue channel. Review this policy, the source code, and each provider's documentation before using the extension. For a vulnerability or accidental secret exposure, follow the private process in [SECURITY.md](SECURITY.md).
