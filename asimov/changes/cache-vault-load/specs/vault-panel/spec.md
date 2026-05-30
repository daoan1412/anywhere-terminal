## MODIFIED Requirements

### Requirement: Refresh on open

The panel SHALL re-request the session index from the host each time it is opened/focused. The host MAY
serve a persisted cache immediately for instant display, but SHALL always follow with a refresh that
re-reads the agents' on-disk stores (the source of truth) and sends the reconciled list. The host SHALL
treat the persisted cache as a non-authoritative accelerator only: it is rebuilt from the on-disk stores on
every open and discarded when missing, unreadable, or of an unrecognized version.
