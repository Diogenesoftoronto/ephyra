---
title: What is stored in Git
summary: Each quest's history is a set of refs in your own repository. How they are laid out, and how to read them with plain git.
---

Your repair history should not be locked inside a vendor's database. Ephyra stores each quest as Git objects in the repository it works on, under a ref namespace of its own. You can fetch it, inspect it and back it up with tools you already have, and it still makes sense if Ephyra is gone.

## The refs

| Ref | Holds |
|---|---|
| `refs/ephyra/trails/<quest-id>/journal` | The quest's journal: its current record, every event, and its files. Appended with compare-and-swap. |
| `refs/ephyra/trails/<quest-id>/revisions/NNNN` | The patch tip for revision NNNN. Immutable. |
| `refs/ephyra/trails/<quest-id>/proofs/NNNN` | The proof manifest commit for revision NNNN. Immutable. |
| `refs/ephyra/policy/<draft-id>` | A published policy draft. |
| `refs/ephyra/policy/active` | The policy currently in effect. |
| `refs/ephyra/setup/current`, `refs/ephyra/setup/runs/<id>` | Recorded setup runs. |
| `refs/ephyra/probes/regression/<quest-id>/<revision>` | The reproduction kept as a regression probe after a clean close. |
| `refs/heads/ephyra/<quest-id>` | The branch a quest-ref landing writes. This one is an ordinary branch. |

Everything under `refs/ephyra/` is outside `refs/heads/`, so it never shows up as a branch, and writing it uses a temporary index that leaves your checkout untouched.

## Getting them onto your machine

Git does not fetch custom refs by default. `ephyra init` adds the refspec for you:

```sh
ephyra init
git fetch origin
```

Or by hand:

```sh
git config --add remote.origin.fetch '+refs/ephyra/*:refs/ephyra/*'
git config --add remote.origin.push  '+refs/ephyra/*:refs/ephyra/*'
git fetch origin
```

`ephyra doctor` reports whether the refspec is in place.

> [!NOTE]
> Whether a forge keeps and replicates custom refs varies. Ephyra can probe a remote by pushing and removing a throwaway ref, but a successful probe does not establish replication, and forge replication of these refs is not verified.

## What is inside a journal

```text
trail.json               the quest's current record
events/<event-id>.json   one file per event, in order
hypothesis.md            written by research
plan.md                  written by planning
intent.md                what the area is supposed to do
evidence/index.json      the sources a checkpoint rests on
proof/manifest.json      the proof bundle
decisions/latest-A.json  the most recent decision at each checkpoint
artefacts/<kind>/<name>  logs, recordings, screenshots
outbox/pending.json      effects the last transition asked for
```

## Reading it with git

```sh
# Which quests does this repository have?
git for-each-ref --format='%(refname)' 'refs/ephyra/trails/*/journal'

# One quest's record and its hypothesis
git show refs/ephyra/trails/<quest-id>/journal:trail.json
git show refs/ephyra/trails/<quest-id>/journal:hypothesis.md

# Its history: one commit per transition
git log --oneline refs/ephyra/trails/<quest-id>/journal

# The exact patch that was proven at revision 1, against your main branch
git diff main refs/ephyra/trails/<quest-id>/revisions/0001
```

`ephyra file <quest> <path>` reads the same files through the server.

## Why it is trustworthy

- **Compare-and-swap appends.** Two writers cannot both extend the same journal; the second one fails and has to look again.
- **Immutable pins.** Once a revision or proof ref is written it is never moved, so "the proof I approved" names one object forever.
- **Canonical JSON.** Records are serialized canonically, and proof digests are computed over those bytes, so the same content always has the same digest.
- **The outbox travels with the transition.** A transition and the effects it asked for are committed together, so a crash between deciding and acting loses nothing.

## What is not in Git

Signals, the inbox, the job queue, the operation ledger and the audit log live in the durable store, not the repository. Credentials are in neither.

Journal contents written by agents or taken from logs are untrusted text. Tools that display them should treat them as data.

## Next

- [The trust rules these records follow](./trust)
- [How landing writes a branch](./landing-watch)
