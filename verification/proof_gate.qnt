// Finite abstraction of core lifecycle proof binding, not a model of the LLM.
module proof_gate {
  var phase: str
  var revision: int
  var base: int
  var proofRev: int
  var proofBase: int
  var proofHead: int
  // Observable inputs let the TypeScript bridge replay actual Quint traces.
  var event: str
  var receiptRev: int
  var receiptBase: int
  var receiptHead: int

  action init = all {
    phase' = "proving", revision' = 1, base' = 0,
    proofRev' = 0, proofBase' = 0, proofHead' = 0,
    event' = "init", receiptRev' = 0, receiptBase' = 0, receiptHead' = 0,
  }

  action submit(r, b, h) = {
    val accepted = r == revision and b == base and h == revision
    all {
    phase == "proving",
    phase' = if (accepted) "ready" else phase,
    proofRev' = if (accepted) r else proofRev,
    proofBase' = if (accepted) b else proofBase,
    proofHead' = if (accepted) h else proofHead,
    revision' = revision, base' = base,
    event' = "proof", receiptRev' = r, receiptBase' = b, receiptHead' = h,
    }
  }

  action moveBase = all {
    phase.in(Set("proving", "ready", "landing")),
    phase' = "patching", base' = 1 - base, revision' = revision,
    proofRev' = 0, proofBase' = 0, proofHead' = 0,
    event' = "base", receiptRev' = 0, receiptBase' = 0, receiptHead' = 0,
  }

  action patch = all {
    phase == "patching", revision < 3,
    phase' = "proving", revision' = revision + 1, base' = base,
    proofRev' = 0, proofBase' = 0, proofHead' = 0,
    event' = "patch", receiptRev' = 0, receiptBase' = 0, receiptHead' = 0,
  }

  action advance(from, target, name) = all {
    phase == from, phase' = target,
    revision' = revision, base' = base,
    proofRev' = proofRev, proofBase' = proofBase, proofHead' = proofHead,
    event' = name, receiptRev' = 0, receiptBase' = 0, receiptHead' = 0,
  }

  action step = {
    nondet r = 1.to(3).oneOf()
    nondet b = 0.to(1).oneOf()
    nondet h = 1.to(3).oneOf()
    any {
      submit(r, b, h), moveBase, patch,
      advance("ready", "landing", "approve"),
      advance("landing", "watching", "land"),
      advance("watching", "closed", "watch"),
      advance(phase, phase, "idle"),
    }
  }

  val freshProof = phase.in(Set("ready", "landing", "watching", "closed")) implies
    (proofRev == revision and proofBase == base and proofHead == revision)
  val completed = phase == "closed"

  // A positive-control trace: the controller can complete without human review.
  action completionStep = any {
    submit(revision, base, revision),
    advance("ready", "landing", "approve"),
    advance("landing", "watching", "land"),
    advance("watching", "closed", "watch"),
  }

  run autonomousCompletionTest = init.then(submit(1, 0, 1))
    .then(advance("ready", "landing", "approve"))
    .then(advance("landing", "watching", "land"))
    .then(advance("watching", "closed", "watch"))
    .expect(completed and freshProof)
  run staleReceiptTest = init.then(moveBase).then(patch).then(submit(1, 0, 1))
    .expect(phase == "proving" and freshProof)
}
