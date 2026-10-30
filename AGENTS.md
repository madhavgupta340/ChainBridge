# ChainBridge

Built on the Masumi TUM hackathon quickstart (https://github.com/masumi-network/tum-hackathon-quickstart, commit d93783b).
Keep the template's root files and paths (`worker.mjs`, `paid-task.mjs`, `agent-api.mjs`, `payment-registration.mjs`, ...) working; ChainBridge plugs in through `chainbridge-answer.mjs` and `src/`.
Read README.md and the affected source before edits. Keep dependency versions pinned unless the user requests an upgrade.
Run `npm test` after behavior changes.

## Rules carried over from the template
Create fresh dedicated account resources, a payment database, and wallets for each project.
Never copy another project's Coworker, Vendor, wallet, registration, or task identifiers.
Read current `sokosumi skills` and command help before provisioning. Use supported credential interfaces. Never inspect the credential vault.
Keep credentials in private environment files or the supported CLI vault. Keep generated state under ignored paths.
Do not commit `.env`, `.local/`, runtime JSON, private logs, seeds, or credentials.
Require the participant's `AGENT_AUTHOR` before agent registration.
Get user authorization before external writes, resource creation, funds transfers, publishing, or deployment.
Do not claim live execution, registration, or seller payment without measured evidence.

## ChainBridge rules
- Cryptography (`src/core/canonical.mjs`, `merkle.mjs`, `commitment.mjs`, `job.mjs`) never depends on AI output. Changing canonicalization or hashing changes every root: bump the protocol/domain version.
- Raw records never leave the browser. The server, agent job, audit log and AI planner receive hashes, metadata or schema summaries only.
- No payment, task submission or publication without the approval gate in `src/server/tasks.mjs`. Uncertain external writes go to `needs_inspection`; never add automatic retries.
- Task and payment states come from local actions or saved Sokosumi/MPS responses. Never fabricate transaction hashes, receipts or confirmations.
