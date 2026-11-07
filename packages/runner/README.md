# Runner

Profile hashing and capability-based runner selection are implemented and tested. No sandbox adapter is implemented yet; running local, Railway, or Not Organic workloads is unverified.

Railway documents its TypeScript SDK as [`railway`](https://www.npmjs.com/package/railway) and its [sandbox lifecycle](https://docs.railway.com/sandboxes). ISOLATED permits internet egress and therefore cannot satisfy a no-network profile.
