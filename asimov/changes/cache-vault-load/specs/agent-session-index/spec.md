## MODIFIED Requirements

### Requirement: Metadata-only, bounded title preview, no egress

The system SHALL read session metadata (id, cwd, timestamp, model/flags) plus a single title preview. The
title preview is the ONLY transcript-derived value the system touches; because it originates from a user
message it MAY contain sensitive content, so it SHALL be truncated to ≤120 characters and newline-stripped
at read time. The bounded metadata and title preview MAY be cached on the local machine to accelerate
display, provided the cache is written owner-only (file mode `0o600`) under the extension's storage and is
NEVER transmitted off the machine. The system SHALL NOT read message bodies beyond the first preview line,
SHALL NOT persist or cache any transcript content beyond the bounded title preview, and SHALL NOT send any
vault data off the machine.

#### Scenario: Only a bounded preview leaves the reader

- **WHEN** a session file contains full conversation message content
- **THEN** only the listed metadata fields plus one ≤120-char, newline-stripped title preview are extracted;
  no further message body is stored, cached, or sent over IPC
