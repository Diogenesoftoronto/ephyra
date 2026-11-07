# @ephyra/journal

Git plumbing-backed trail records, immutable revision and proof refs, trailers, bundles, refspec configuration and a custom-ref dry-run probe. The caller supplies a Git directory and clock. CompanionJournal uses the same API with a separately provisioned bare repository.

Local tests exercise CAS, persistence, transport and checkout isolation. Remote forge replication, permissions and companion repository provisioning are unverified. A dry-run probe reports unknown when it cannot establish support; it does not prove actual replication.
