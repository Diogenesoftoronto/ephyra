# Runner

Profile hashing, capability selection with rejection reasons, and a SHA-256 content-addressed artifact store are implemented and tested locally. The store verifies content on retrieval.

| Capability | Status |
| --- | --- |
| Profile hashing, selection and CAS | Verified by local tests |
| Local runner | Unverified; not implemented |
| Railway runner | Unverified; not implemented |
| Not Organic runner | Unverified; not implemented |

Railway documents the TypeScript SDK as `railway` and its [sandbox lifecycle](https://docs.railway.com/sandboxes) and [code-execution guide](https://docs.railway.com/guides/code-execution-sandboxes). ISOLATED permits internet egress and cannot satisfy a no-network profile.
