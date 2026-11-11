---
title: Study evidence
summary: How results from persona studies and real respondents reach a proof bundle, for operators who run the server.
---

Riskier user-facing changes need evidence that people can still do what they came to do. That evidence comes from outside Ephyra, and it would be easy to forge, so the route in is narrow and the operator controls it.

> [!NOTE]
> This page is for whoever operates the Ephyra server. Account settings and repository code cannot create the grants described here.

## Two kinds, never interchangeable

A **synthetic persona study** simulates users. A **respondent study** records real people. They are different proof items. A persona study stays marked synthetic and cannot satisfy a requirement for human evidence.

## Two ways a result arrives

| Transport | How evidence arrives |
|---|---|
| **Operator directory** | An operator verifies a completed export and places its receipt in a protected directory. |
| **Signed provider callback** | A granted provider submits an Ed25519-signed receipt to `POST /callbacks/proof`. |

Both need two operator-owned absolute paths: `EPHYRA_PROOF_RECEIPTS_DIR` and `EPHYRA_PROOF_TRUST_FILE`.

## Grant a source

The trust file names each source, the workspaces it may report for, and the kinds of evidence it may supply:

```json
{
  "schema": 1,
  "grants": [
    {
      "sourceId": "study-service",
      "workspaces": ["YOUR_WORKSPACE_ID"],
      "kinds": ["persona_study", "voxq_study", "visual_approval"],
      "transport": "signed",
      "publicKey": "ED25519_SPKI_PEM_PUBLIC_KEY"
    }
  ]
}
```

For directory import, set `"transport": "directory"` and omit `publicKey`. Unsigned directory receipts cannot be submitted over HTTP.

## What a receipt binds

Each completed receipt names the quest, revision, base, head, provider operation and expiry. A receipt that conflicts with another, has expired, or comes from a source without a matching grant is rejected.

These transports import evidence that is already complete. Dispatching a study to respondents automatically additionally needs a host provider integration, a named spend approval, and remaining budget.

<details>
<summary>Receipt envelope and signing</summary>

```json
{
  "receipt": {
    "schema": 1,
    "sourceId": "study-service",
    "workspaceId": "YOUR_WORKSPACE_ID",
    "trailId": "EXACT_TRAIL_UUID",
    "rev": 1,
    "base": "EXACT_BASE_COMMIT",
    "head": "EXACT_HEAD_COMMIT",
    "operationKey": "ACTUAL_PROVIDER_OPERATION",
    "observedAt": "ISO_OBSERVATION_TIME",
    "expiresAt": "ISO_EXPIRY_TIME",
    "items": [
      { "kind": "persona_study", "synthetic": true, "study": "ACTUAL_STUDY_ID", "runId": "ACTUAL_PROVIDER_RUN_ID", "report": "ACTUAL_COMPLETED_REPORT" }
    ]
  },
  "signature": "BASE64URL_ED25519_SIGNATURE"
}
```

Replace every placeholder with a real value. Sign the UTF-8 bytes of `canonicalJson(receipt)`, exported by `@ephyra/core`, with the provider's Ed25519 private key, and encode the signature as unpadded base64url. The private key stays with the provider; the grant holds only the public key.

For directory import, omit `signature`. In a source checkout, `proofReceiptPath(directory, receipt)` from `@ephyra/server` gives the file path. A receipt is immutable for its source, operation and exact revision.

</details>

## Next

- [The proof table these satisfy](./proof)
- [Approving the spend for a respondent study](./reviewing#spend-requests)
