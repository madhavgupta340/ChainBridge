# ChainBridge

**Prepare data from traditional systems for blockchain verification, and buy the agent service on Cardano.**

A team loads any CSV or JSON table. An AI model (Meta, optional) suggests how to tidy and sort it, the user approves each change, and ChainBridge applies them deterministically. ChainBridge then flags sensitive fields, recommends a privacy-aware anchoring plan, and computes a cryptographic commitment (a salted Merkle root) in the browser. Raw records stay off-chain and on the user's machine. A ChainBridge agent, running as a Sokosumi Coworker and paid through the Masumi Payment Service on **Cardano Preprod**, independently recomputes the root from leaf hashes and returns an anchoring certificate. In paid mode, the hash of that certificate is submitted to the Masumi escrow contract.

Built for the TUM Blockchain & AI Hackathon (Oct 30–31, 2026), Cardano track: *"Build an agent, service or developer tool that does a useful job and gets paid for it on Cardano."* It is built on the official [Masumi TUM quickstart](https://github.com/masumi-network/tum-hackathon-quickstart) (commit `d93783b`), keeping its worker, payment adapter, registration and safety checks.

> **Test network only.** Preprod test tokens have no real value. A commitment shows whether data matches what was anchored. It does **not** prove the source data is accurate, and paying for the service does not change that.

## Track status (honest)

| Requirement | Status | Evidence |
|---|---|---|
| Useful agent/service | **Met** | AI-assisted data organizing, privacy-aware commitments, Merkle anchoring certificate, proof verification. 78 automated tests. |
| Runs as a Sokosumi Coworker | **Met** | Coworker `01a18d16-b119-7273-8778-92bb94281ffa` ("ChainBridge", vendor "Cardano to the Moon") completed Task `01a18f19-7fe2-7045-9011-128858636892` on Sokosumi Preprod. |
| Gets paid on Cardano (Masumi, Preprod) | **Met (test network)** | Masumi registration confirmed; paid Task settled with 1 tUSDM (test token). |
| Completed paid task + seller receipt | **Met (test network)** | Sokosumi receipt `settled: true`; seller net receipt of 1 tUSDM verified on-chain via Blockfrost. |

### Evidence log (Cardano Preprod, 2026-10-31; test tokens, no real value)

Created from the ChainBridge app (supplier certificates sample, 12 records → Merkle root `a5aa79ed86a085a61fe074bd6b3ed1c7cfe0f701c4c5fa45da260ae26c9e001f`), approved at a quoted 1 tUSDM, run by the ChainBridge worker.

- Coworker ID: `01a18d16-b119-7273-8778-92bb94281ffa` (registered on Masumi as "Cardano to the Moon Invoice Checker", renamed ChainBridge on Sokosumi)
- Completed Sokosumi Task ID: `01a18f19-7fe2-7045-9011-128858636892`
- Agent result: "ChainBridge anchoring certificate: root verified." Result hash `18557fd1d581b7db06ecc3096965023df71aa3c3242a0e9bf50e60904f8315b9`
- Escrow funded (FundsLocked): [`b786f50d…dee0beb`](https://preprod.cardanoscan.io/transaction/b786f50dcd8e4500cb0ffd8863fb95646766a683e6858cfce242ef4e3dee0beb)
- Result submitted (FundsLocked → ResultSubmitted): [`60fbe98f…3e943c`](https://preprod.cardanoscan.io/transaction/60fbe98f1218df429de034093c8688844789779623f7cd5a14252c7db13e943c)
- Seller payout (ResultSubmitted → Withdrawn), seller net +1 tUSDM: [`c95e9694…590fca`](https://preprod.cardanoscan.io/transaction/c95e9694de418594bc08e7bcf96cd097a5587446777bc1fa589be4e944590fca)
- Sokosumi `runtime receipt`: `settled: true`, same txHash `c95e9694…590fca`
- Follow-up comment and agent reply: _not yet recorded_

## Quick start (demo mode, about 2 minutes)

Prerequisites: Node.js 24+ and Git. No accounts are needed for demo mode.

```sh
git clone https://github.com/madhavgupta340/ChainBridge.git
cd ChainBridge
npm ci
npm run app
```

Open http://127.0.0.1:8787. The app is a guided flow showing one step at a time, with a **Continue** button. A strip at the top always shows where your data is, whether a fingerprint exists, whether anything is published, and any payment. Technical detail sits under **Details for technical users** on each step.

1. **Upload data.** Click **Messy shipment list (needs tidying)**, or **Payroll export** to focus on privacy.
2. **Organize data.** Click **Suggest with rules** (no AI), or **Suggest with AI** if a Meta key is set. Review the suggested steps (rename columns, fix dates, yes/no values, spaces, duplicates, sort), untick any you don't want, check the before/after preview, and apply. You can skip this step.
3. **Review data.** A short preview plus a privacy check: `full_name`/`email` are flagged *Personal*, and `iban`/`gross_salary` *Confidential*, each with a reason. You can change any label. All columns and record selection are behind expandable sections.
4. **Choose what to publish.** Safe defaults are pre-selected: confidential columns are left out and an extra secret value (salt) is added. "Things to know" lists the privacy limits in plain words.
5. **Create proof.** Compare *Stays on your device* with *Could be published to Cardano*. Click **Create proof** to get one fingerprint (the Merkle root), then download the proof file.
6. **Verify a record.** **Check this record** gives ✓ Match. Change any value (e.g. add a space) and check again for ✗ No match.

Optionally, open **Paid task — Cardano Preprod test**. Click **Get a price**, review the price, fees and what is sent, tick the approval box, and approve. In demo mode the check runs locally and is labeled *local demo*.

`npm test` runs all checks.

## AI organizer (Meta)

The **Organize data** step uses an AI model to analyse a table and suggest a *recipe* of tidy-up steps. The AI never edits the data. ChainBridge validates each suggested step against a fixed list (rename, trim, lowercase, yes/no → true/false, dates → YYYY-MM-DD, numbers, remove column, remove empty/duplicate rows, sort, change a privacy label). Anything else is ignored. The user ticks which steps to keep, and ChainBridge applies them with its own deterministic code. The approved recipe is saved in the private proof file, so *original file + recipe* always rebuilds the same records and fingerprint.

**Setup:** put a Meta Model API key in `.env` as `MODEL_API_KEY` (from https://dev.meta.ai/). The defaults are `MODEL_API_BASE_URL=https://api.meta.ai/v1` (OpenAI-compatible Chat Completions) and `MODEL_API_MODEL=muse-spark-1.3`. Without a key, the template's `ZAI_*` settings are used if present; otherwise only the built-in rules run. The same key powers the optional plan suggestion in step 4.

**What the AI sees** (the user chooses each time, and can view the exact payload first):
- **Masked sample (default):** column names, labels, value formats, and up to 10 rows, with values of columns labelled personal/confidential replaced by `[personal]`/`[confidential]`.
- **Column names only:** no values or formats.
- **Unmasked sample:** up to 10 rows exactly as in the file. Needs a second, explicit confirmation.

Masking uses the automatic privacy labels. A personal column the rules don't recognise would be sent unmasked, so check the payload preview or choose "column names only" for sensitive files.

## How the agent task flow works

```
Browser (records stay here)          ChainBridge app (127.0.0.1)          Sokosumi / Masumi (Preprod)
parse → classify → plan → hash   →   quote (price, fees, payload)
                                     user approves exact quote   →   tasks create (CLI)
                                                                    worker.mjs picks up task
                                                                    validate input (reject = no charge)
                                                                    MPS payment request → buyer funds escrow (FundsLocked)
                                                                    ChainBridge job (deterministic) → submit-result hash
                                     status from worker journal  ←   ResultSubmitted → COMPLETED → seller withdrawal
```

- **Job input** (task description) is JSON with leaf hashes and the public payload. It never contains records. See `src/core/job.mjs`. Max 200 leaves (template limit: 16,000 characters).
- **Job output** is a certificate with the recomputed root, match status and public payload. It is deterministic, so the Masumi result hash covers an exact, reproducible text.
- **Malformed input** is rejected by the worker *before* any payment request, and the task is completed with an explanation and no charge.
- **Status** shown in the app is read from the template worker's private journal (`.local/<taskId>.json`). Transaction hashes appear only when the payment service returned them. A seller receipt is shown only after the template's `verifySettlement` matched it on-chain through Blockfrost.
- **Follow-up comments** on a Sokosumi task are answered by the Eve model agent (`agent/instructions.md`), seeded with the delivered result.

### Modes

| Mode | When | Payment |
|---|---|---|
| Demo | `COWORKER_ID` unset or `sokosumi` CLI missing | None. Labeled *Demo mode: unpaid, local* |
| Sokosumi unpaid | Coworker configured, `PAID_TASKS_ENABLED` not `true` | None |
| Paid Preprod | Coworker + `PAID_TASKS_ENABLED=true` + confirmed Masumi registration | 1 tUSDM per task via Masumi escrow |

## Prices, fees and costs (kept separate)

- **Service price (to ChainBridge): 1 tUSDM** (test USDM, unit `16a55b2a…0014df10745553444d`, `1000000` atomic units). This is the amount the official template's signed Masumi quote uses, and `paid-task.mjs` rejects any other quote. The team asked for ADA pricing. Switching to lovelace would mean changing `USDM` / `RequestedFunds` in `paid-task.mjs` and `agent-api.mjs`, which has not been tested with Sokosumi Core, so the documented amount was kept.
- **Cardano network fees:** separate from the service price. Escrow lock, result submission and withdrawal transactions cost test ADA, paid by the respective wallets. ChainBridge does not estimate them, and the UI says "estimate unavailable".
- **AI inference:** the paid result uses no model. Follow-up comments and the optional AI planner use your own model provider, billed by that provider.

## Full setup (Sokosumi and paid Preprod)

Follow the official [TUM setup guide](https://www.masumi.network/tum-hackathon). Commands below are from that guide and the template README.

1. **Private config:** `cp .env.example .env && chmod 600 .env`. Set `ZAI_API_KEY`, `ZAI_BASE_URL`, `ZAI_MODEL` (OpenAI-compatible provider, used by the Eve follow-up agent and the optional planner).
2. **Sokosumi CLI (pinned):** `npm install --global @masumi_network/sokosumi@1.0.4`, then `sokosumi --preprod auth login`.
3. **Vendor and Coworker:** run `vendors create`, `coworkers register --capability tasks --personal`, `coworkers connect`, then import the key with `coworkers api-key … | runtime key-import …`. Do this once; the key stays in the CLI vault. Set `COWORKER_ID` in `.env`.
4. **Run three processes:** `npm start` (Eve agent), `npm run worker` (wait for "Continuous worker running"), `npm run app` (ChainBridge UI). The app now shows *Sokosumi: unpaid tasks*. Approving a quote runs `sokosumi --preprod tasks create --personal --coworker-id … --status READY --json` with the job JSON as description.
5. **Paid tasks (optional, per template):** run your own [Masumi Payment Service](https://github.com/masumi-network/masumi-payment-service) with a dedicated DB and selling wallet funded with test ADA ([dispenser](https://dispenser.masumi.network)). Put `ADMIN_KEY` in `.local/mps.env` (600), and `sourceId`/`walletId`/`sellerAddress` in `docs/payment-state.json`. Set `MPS_URL`, `AGENT_AUTHOR` and `BLOCKFROST_API_KEY_PREPROD`, then run:
   ```sh
   node --env-file=.env --env-file=.local/mps.env payment-registration.mjs key
   node --env-file=.env --env-file=.local/mps.env payment-registration.mjs register
   node --env-file=.env --env-file=.local/mps.env payment-registration.mjs   # repeat until confirmed
   ```
   Complete `docs/registration-state.json`, start `npm run api`, set `PAID_TASKS_ENABLED=true`, and restart the worker and the app. The app badge then shows *Paid Preprod tasks* and quotes 1 tUSDM.
6. **TUM Workspace:** connect the Coworker to the organizer-supplied workspace, check `taskSeatEligible: true` and access `GRANTED`, then set `SOKOSUMI_ORGANIZATION_ID` and `SOKOSUMI_ORGANIZATION_SLUG` together.

Never put seed phrases, private keys or API keys in the repo, the browser, prompts, or screenshots. ChainBridge never asks for them.

## Cryptography

- **Canonicalization (`CB-CANON-1`):** only selected fields are used, and a missing field becomes `null`. Keys and strings are NFC-normalized and keys are sorted by UTF-16 code units. JSON escaping is used with no whitespace. Numbers use the shortest ECMAScript form (`-0`→`0`, NaN/∞ rejected). Values are **not trimmed or coerced**: CSV values stay strings exactly as in the file, and JSON keeps its types. So `"7"` (CSV) and `7` (JSON) hash differently by design.
- **Leaf:** `SHA-256(0x00 ‖ "chainbridge/v1/leaf" ‖ 0x00 ‖ saltHex ‖ 0x00 ‖ canonical)`. The salt is 16 random bytes in hex, or empty.
- **Node:** `SHA-256(0x01 ‖ left ‖ right)` on raw 32-byte digests. The 0x00/0x01 prefixes separate leaves from nodes (RFC 6962 style).
- **Tree:** leaves are in plan order, either sorted by leaf hash (order-independent) or source order. An odd last node is **promoted, not duplicated**. A single leaf's root is the leaf itself. An empty dataset is rejected.
- **Proof:** `{leafIndex, leafCount, siblings:[{side:'left'|'right', hash}]}`, from leaf to root.
- **Duplicates** on the selected fields are counted and either kept (distinct leaves when salted, identical otherwise) or dropped.
- **Implementation:** WebCrypto SHA-256 (browser and Node 24), the same code in the UI, agent and tests (`src/core/`).

## Privacy, security and limitations

- Hashing is **not anonymization**. Unsalted hashes of guessable values (names, emails, low-cardinality fields) can be brute-forced. Per-record salts prevent this but must be kept (in the proof bundle) to verify. Anyone without the salts cannot verify a record.
- Excluded fields are not protected: changes to them go undetected.
- Sensitivity labels come from transparent name and value heuristics and can be wrong. They are not legal or compliance advice.
- The optional AI planner is off by default. It needs an explicit click, shows the exact JSON to be sent (field names, labels, counts, no values), and its output is normalized and validated by code.
- Uploaded content is parsed as data only and rendered via `textContent` under a strict CSP. Limits: 2 MB, 5,000 records, 100 fields, and 10,000 characters per value.
- The local server binds to 127.0.0.1, refuses cross-origin and non-JSON writes, and serves a fixed file allow-list.
- The audit log (`.local/chainbridge/audit.jsonl`) stores an allow-list of fields only: time, task, mode, network, commitment, strategy, count, price, states, and tx references. It never stores records or job text.
- No automatic retries of payment or submission. Uncertain outcomes become `needs_inspection`, and identical active jobs are de-duplicated.
- The paid flow anchors the **hash of the certificate** through Masumi's escrow. A standalone Cardano metadata transaction carrying the root (e.g. a CIP-20/label-674 adapter with a CIP-30 wallet) is a planned extension and is not implemented.

## Architecture

```
src/core/      ingest.mjs (CSV/JSON) · schema.mjs (types, sensitivity) · recipe.mjs (tidy-up steps) · organize.mjs (AI sample, local rules)
               plan.mjs (planner + validation)
               canonical.mjs · merkle.mjs · commitment.mjs · job.mjs (paid service job) · limits.mjs
src/server/    main.mjs (HTTP + static) · tasks.mjs (quote/approval/execution) · states.mjs
               config.mjs (mode, price) · sokosumi.mjs (CLI + worker journal) · ai-config.mjs (Meta) · ai-organizer.mjs
               ai-planner.mjs · audit.mjs · store.mjs
public/        index.html · app.js · ui.js · styles.css
chainbridge-answer.mjs   plugs the ChainBridge job into the template worker and MIP-003 API
worker.mjs, paid-task.mjs, agent-api.mjs, payment-registration.mjs, settlement.mjs …   Masumi template (lightly adapted)
test/          ChainBridge tests     *.test.mjs   template tests
```

Extension points: new connectors (databases, APIs) only need to produce `{sourceRow, values}` records for `buildCommitment`. Other anchoring backends would sit beside `src/server/sokosumi.mjs`.

## Tests

`npm test` runs 78 tests: the template's 29 plus ChainBridge's 49. They cover the AI organizer (step whitelist, masking, consent, deterministic re-application), parsing (malformed input, limits), canonicalization and hash vectors, sensitivity heuristics and overrides, Merkle proofs, the odd-node rule, empty and duplicate data, modified-record verification, plan validation, AI output sanitization, job input validation, approval gates, duplicate prevention, uncertain outcomes, state transitions, audit privacy, and the HTTP API. These are local tests. A live Sokosumi/Masumi run is still required for track evidence.

## Demo video outline (≤ 2.5 min)

1. 0:00 Problem: teams need to prove exported data wasn't altered, without publishing it.
2. 0:20 Load the payroll sample, show flagged fields, then the plan and its rationale.
3. 0:50 Published vs off-chain, compute the root, then show ✓ and a tampered ✗.
4. 1:30 Quote (price vs fees), approve, then show Sokosumi task status, Masumi payment and tx hash (paid run).
5. 2:10 Seller receipt evidence and the follow-up comment, then limits.
