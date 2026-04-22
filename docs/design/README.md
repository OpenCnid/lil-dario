# Design docs

These files are the durable write-up for preserve-tools work in `lil-dario`.

What belongs here:
- stable rationale
- profile behavior and contracts
- validation outcomes worth preserving
- references to upstream repos or repo-relative files

What does **not** belong here as a canonical reference:
- workspace-specific scratch paths like `/home/.../.tmp/...`
- one-off local capture file paths under `/tmp`
- temporary study clones that only existed during investigation

Rule of thumb:
- keep the conclusion in the repo
- keep the transient artifact out of the repo
- if an ephemeral artifact mattered, summarize what it proved instead of treating its local path as documentation
