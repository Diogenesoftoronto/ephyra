# @ephyra/journal

Git plumbing stores each trail at `refs/ephyra/trails/<uuid>/journal`, with immutable `revisions/NNNN` and `proofs/NNNN` refs. Journal trees contain `trail.json`, ordered event files, and extra files. A temporary index leaves the application checkout untouched. Appends use compare-and-swap; pins are immutable and proof digests cover canonical JSON.

`GitJournal` accepts a git directory and clock. `CompanionJournal` uses the same API with a separately provisioned bare repository. Bundle transport and refspec helpers support moving refs. The custom-ref probe actually pushes and removes a unique probe ref; an inconclusive push or cleanup reports unknown.

Local tests cover CAS, pins, transport, corruption, trailers and checkout isolation. Forge replication of custom refs and companion repository provisioning remain **Unverified**; a successful probe does not establish replication.
