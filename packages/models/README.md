# Models

Registry and injected transports for extraction and decision models. Configure a purpose to an explicit alias; missing aliases fail closed. Expected identities are checked on each validated response. Supply credentials and a stable operation key at the edge; the Not Organic access token must be bound to the supplied DPoP key. The default token provider throws `Unverified` until Ephyra product registration exists. BYOK requests go directly to their vendor.

| Adapter | Contract status | Live status |
| --- | --- | --- |
| NotOrganicDecide / NotOrganicExtract | Verified against local provider contracts and SDK | Unverified |
| TypeSafeDecide | Verified from [OpenAPI](https://api.typesafe.ai/openapi.json) for text questions | Unverified |
| WorkersAiClairicExtract | Verified from [Cloudflare docs](https://developers.cloudflare.com/workers-ai/models/clairic/) | Unverified |
| NotOrganicForecast / WorkersAiClairicForecast | Clairic `forecast` fields (horizon 1–64, interval) verified against the Not Organic extraction contract v1 fixture, including both answer forms and its invalid cases | Unverified |
| SystemOneHttpDecide | Verified against local pplx deployment contract for text questions | Unverified for each deployment and model |
| ParserExtract | Local deterministic regex parser; no model inference | Local tests only |

System One image mapping and fallback are Unverified. Retry is limited to explicit 429, 503, or 529 responses carrying a bounded Retry-After; a network failure or timeout requires reconciliation. Usage is reported only from returned values; unavailable token counts and costs are null. `HttpError.retryAfterSeconds` carries the provider's own Retry-After when one was sent and is undefined otherwise. Forecast adapters do not record usage themselves: the caller owns one ledger entry per forecast operation. No live inference has been performed.
