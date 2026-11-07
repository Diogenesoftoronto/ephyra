# @ephyra/policy

Pure rules for autonomy, backend thresholds, triage, proof, and post-landing watch. The package performs no I/O. Tests cover parser errors and overrides, the triage decision table, proof matrix, and watch boundaries. Candidate lists and signal kind must be supplied to triage; absent information takes a conservative path. Callers must enforce `autoLandAllowed` and critical forge-only landing, and provide actual human decisions and evidence. Integrations and production behavior are Unverified.

`renderAutonomy` renders defaults and areas; the parser’s fixed fallback and line-numbered warnings are not serialized. Area prose is normalized to a trailing newline.
