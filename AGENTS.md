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
- Full records never leave the browser. The paid agent receives record fingerprints plus a masked sample (private columns hidden, at most 10 rows, shown to the user before approval); the audit log and AI planner receive hashes, metadata or schema summaries only.
- The agent publishes only the fingerprint, record count and job reference on Cardano (metadata label 674), once per job, from its dedicated Preprod publishing wallet (`.local/publishing-wallet.json`, never committed).
- No payment, task submission or publication without the approval gate in `src/server/tasks.mjs`. Uncertain external writes go to `needs_inspection`; never add automatic retries.
- Task and payment states come from local actions or saved Sokosumi/MPS responses. Never fabricate transaction hashes, receipts or confirmations.
- The main paid flow is x402 (`src/server/x402-*.mjs`): settle the buyer's signed payment only after the fingerprint is published; never settle twice; keep pricing deterministic in `src/core/pricing.mjs` (never priced by AI).
