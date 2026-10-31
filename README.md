# ChainBridge

**A pay-per-use AI agent on Cardano that tidies your data, seals it with a fingerprint, and publishes that fingerprint on the blockchain as public proof.**

A customer uploads any CSV or JSON table and gets a **free price quote** calculated from simple measurements of the file. If they accept, they **pay once with x402**, a direct pay-per-request protocol on Cardano with no escrow and no account. The ChainBridge agent then does the paid work:

1. **AI tidy-up:** Meta AI analyses a masked sample (private columns hidden) and suggests fixes. The customer approves each one.
2. **Fingerprint:** a salted SHA-256 Merkle root of the chosen columns, created in the customer's browser.
3. **Publication on Cardano:** the agent publishes the fingerprint in its own Preprod transaction (metadata label 674).

**The signed payment is only sent after publication succeeds.** If anything fails before that, the customer is not charged. The customer downloads one package: the cleaned data, an AI report, a certificate with the Cardano links, and a private proof file for checking records later. The full file never leaves the customer's device.

Built for the TUM Blockchain & AI Hackathon (Oct 30–31, 2026), Cardano track: *"Build an agent, service or developer tool that does a useful job and gets paid for it on Cardano."* It is built on the official [Masumi TUM quickstart](https://github.com/masumi-network/tum-hackathon-quickstart) (commit `d93783b`); the Sokosumi/Masumi escrow path from the template still works as an alternative.

> **Test network only.** Preprod test tokens have no real value. A fingerprint shows whether data matches what was sealed. It does **not** prove the source data was accurate.

## Track status (honest)

| Requirement | Status | Evidence |
|---|---|---|
| Useful agent/service | **Met** | AI data tidy-up, privacy-aware fingerprinting, publication on Cardano, record verification. 89 automated tests. |
| Gets paid on Cardano | **Met (test network)** | x402 payment of 4.75 tADA, settled on Preprod only after publication (below). Also two Masumi escrow payments via Sokosumi. |
| Does the job on Cardano | **Met (test network)** | Fingerprints published as transaction metadata, read back from the chain. |
| Runs as a Sokosumi Coworker (alternative path) | **Met** | Coworker `01a18d16-b119-7273-8778-92bb94281ffa` completed paid Tasks with verified seller receipts. |

### Evidence log (Cardano Preprod, 2026-10-31; test tokens, no real value)

**Main flow: x402 pay-per-use** (messy shipments sample, 10 records, quoted 4.75 tADA, paid with the demo test wallet, Meta AI tidy-up approved, 8 records sealed):

- Fingerprint `ce6eb2ab3cf389d274da8d94eef15b0444d7ba89d59044a45c5fca01c437d088`
- **Published on Cardano** (block 5355257): [`7fefcbba…231872`](https://preprod.cardanoscan.io/transaction/7fefcbba57d7cd1acefee34f38aef39ec230d64f687fb87594c5ce868a231872)
- **x402 payment settled after publication**, 4.75 tADA to ChainBridge (verified and settled through the Cardano Foundation Preprod facilitator): [`7e28c472…98e091`](https://preprod.cardanoscan.io/transaction/7e28c4725bb2b179aaff16010e45da4f4cbc323ff0e7166f88f1e8dd7a98e091)
- Earlier x402 protocol test (2 tADA, verify then settle): [`711b756a…c2163e`](https://preprod.cardanoscan.io/transaction/711b756a9f59d608cd9e4b3357415c0faa5299b87c3a9c464df0cf0e81c2163e)

**Alternative: Sokosumi task paid through Masumi escrow (1 tUSDM).**

Created from the ChainBridge app (supplier certificates sample, 12 records → Merkle root `a5aa79ed86a085a61fe074bd6b3ed1c7cfe0f701c4c5fa45da260ae26c9e001f`), approved at a quoted 1 tUSDM, run by the ChainBridge worker.

- Coworker ID: `01a18d16-b119-7273-8778-92bb94281ffa` (registered on Masumi as "Cardano to the Moon Invoice Checker", renamed ChainBridge on Sokosumi)
- Completed Sokosumi Task ID: `01a18f19-7fe2-7045-9011-128858636892`
- Agent result: "ChainBridge anchoring certificate: root verified." Result hash `18557fd1d581b7db06ecc3096965023df71aa3c3242a0e9bf50e60904f8315b9`
- Escrow funded (FundsLocked): [`b786f50d…dee0beb`](https://preprod.cardanoscan.io/transaction/b786f50dcd8e4500cb0ffd8863fb95646766a683e6858cfce242ef4e3dee0beb)
- Result submitted (FundsLocked → ResultSubmitted): [`60fbe98f…3e943c`](https://preprod.cardanoscan.io/transaction/60fbe98f1218df429de034093c8688844789779623f7cd5a14252c7db13e943c)
- Seller payout (ResultSubmitted → Withdrawn), seller net +1 tUSDM: [`c95e9694…590fca`](https://preprod.cardanoscan.io/transaction/c95e9694de418594bc08e7bcf96cd097a5587446777bc1fa589be4e944590fca)
- Sokosumi `runtime receipt`: `settled: true`, same txHash `c95e9694…590fca`
- Follow-up comment and agent reply: _not yet recorded_

**Full paid service ("certify": AI analysis + fingerprint check + publication on Cardano)**, messy shipments sample tidied in the app, 8 records → root `a33b2f4ecdca49d833293fb00c6ef385cc602359ecfbd780684aeea7137aaaa9`:

- Sokosumi Task ID: `01a18f6e-d6f2-726f-a43a-90516ba16289` (paid 1 tUSDM via Masumi escrow; completed)
- AI analysis by Meta AI (muse-spark-1.3) on a masked sample: 5 issues found, 6 tidy-up steps suggested
- **Fingerprint published on Cardano Preprod** by the agent's publishing wallet, block 5355170, fee 0.175401 tADA: [`5476b483…3d12da`](https://preprod.cardanoscan.io/transaction/5476b4830038e3fe0c6e850d371988eaaf5e6b96fc54680b1534df958d3d12da)
- Read back from the chain (metadata label 674): `["ChainBridge data fingerprint v1","sha-256 merkle root:","a33b2f4e…7aaaa9","records: 8","salted: true","job: cb-693bad795f216e282f5f83ae"]`

## Quick start

Prerequisites: Node.js 24+, Git, and a free [Blockfrost](https://blockfrost.io/) **Preprod** key. A [Meta Model API](https://dev.meta.ai/) key is needed for the AI analysis.

```sh
git clone https://github.com/madhavgupta340/ChainBridge.git
cd ChainBridge
npm ci
cp .env.example .env && chmod 600 .env   # add BLOCKFROST_API_KEY_PREPROD and MODEL_API_KEY
npm run publish-wallet                    # the agent's publishing wallet: fund it from the Preprod faucet
npm run demo-wallet                       # optional: a test buyer wallet for demos without a browser wallet
npm run app
```

ChainBridge's receiving address comes from `docs/payment-state.json` (`sellerAddress`), or set `X402_PAY_TO` in `.env`. Fund wallets with test ADA from the [Cardano faucet](https://docs.cardano.org/cardano-testnets/tools/faucet) (network: Preprod).

Open http://127.0.0.1:8787:

1. **Upload data:** e.g. **Messy shipment list (needs tidying)**.
2. **Review data:** check the privacy labels. Private columns are always hidden from the AI.
3. **Price & payment:** **Get my price** sends only four counts (records, columns, private columns, tidy-up problems) and shows the price with a breakdown. Accept and pay with a **browser wallet** (Lace or Eternl, set to Preprod; you approve in the wallet) or the **demo test wallet**. The payment is signed and checked, not yet sent.
4. **AI tidy-up (paid):** **Run the AI analysis**, untick anything you disagree with, apply.
5. **Choose what to publish (paid):** columns to cover, extra secret value, duplicates.
6. **Fingerprint & publish (paid):** **Create my fingerprint**, then **Publish on Cardano and pay**. That's about a minute: publication, confirmation, then settlement of your payment.
7. **Your package:** **Download package (.zip)**.

**Verify a record** works at any time after the fingerprint exists: change a value and the check fails.

`npm test` runs all checks.

## How payment works (x402)

[x402](https://developers.cardano.org/x402/) is HTTP-native payment: the service answers **402 Payment Required** with its price, the client pays and retries with proof. ChainBridge uses the `exact` scheme on `cardano:preprod` with direct payment (no escrow), through the official `@x402/cardano` and `@x402/core` libraries (2.26.0) and the Cardano Foundation's hosted Preprod facilitator.

- `GET /x402/session/:id` answers **402** with a `PAYMENT-REQUIRED` header for the quoted price. `POST` with a `PAYMENT-SIGNATURE` header pays.
- The buyer's wallet **signs** the payment transaction (one output of exactly the price to ChainBridge). The facilitator **verifies** it; nothing is broadcast yet.
- After the fingerprint is published and confirmed, ChainBridge **settles**: the facilitator broadcasts the signed payment. If publication fails, the payment is never broadcast and the customer is not charged.
- The signed payment is valid for 30 minutes. Sessions are journalled before every external step; interrupted steps are flagged for inspection, never retried blindly.
- Trade-off of direct payment: there is no escrow refund. ChainBridge protects the customer by settling only after delivery.

**Pricing** lives in `src/core/pricing.mjs` (placeholder values): base 2 tADA, +0.5 per 1,000 records, +0.25 per private column, +0.25 per tidy-up problem, +0.1 per column beyond 10, between 2 and 20 tADA. It is computed from counts, never by the AI, so it's free, reproducible and explainable. The customer's wallet adds the Cardano network fee (about 0.17 tADA); the agent pays the publication fee from its own wallet.

## AI organizer (Meta)

The paid **AI tidy-up** step uses an AI model to analyse a table and suggest a *recipe* of tidy-up steps. The AI never edits the data. ChainBridge validates each suggested step against a fixed list (rename, trim, lowercase, yes/no → true/false, dates → YYYY-MM-DD, numbers, remove column, remove empty/duplicate rows, sort, change a privacy label). Anything else is ignored. The user ticks which steps to keep, and ChainBridge applies them with its own deterministic code. The approved recipe is saved in the private proof file, so *original file + recipe* always rebuilds the same records and fingerprint.

**Setup:** put a Meta Model API key in `.env` as `MODEL_API_KEY` (from https://dev.meta.ai/). The defaults are `MODEL_API_BASE_URL=https://api.meta.ai/v1` (OpenAI-compatible Chat Completions) and `MODEL_API_MODEL=muse-spark-1.3`. Without a key, the template's `ZAI_*` settings are used if present; otherwise only the built-in rules run. The same key powers the optional plan suggestion in step 4.

**What the AI sees** (the user chooses each time, and can view the exact payload first):
- **Masked sample (default):** column names, labels, value formats, and up to 10 rows, with values of columns labelled personal/confidential replaced by `[personal]`/`[confidential]`.
- **Column names only:** no values or formats.
- **Unmasked sample:** up to 10 rows exactly as in the file. Needs a second, explicit confirmation.

Masking uses the automatic privacy labels. A personal column the rules don't recognise would be sent unmasked, so check the payload preview or choose "column names only" for sensitive files.

## Alternative: Sokosumi task with Masumi escrow

The template path still works: a Sokosumi task paid through Masumi escrow (1 tUSDM), handled by `worker.mjs` with the `certify` job.


The customer pays the ChainBridge agent (1 tUSDM on Preprod, through Masumi escrow) for the full job, called `certify` in `src/core/job.mjs`:

1. **AI analysis:** the agent runs its AI provider (Meta) on a **masked sample**: column names and labels, value formats, and up to 10 rows, with columns labelled personal or confidential hidden. It returns a data-quality report and suggested tidy-up steps. Advisory only.
2. **Fingerprint check:** it recomputes the Merkle root from the record fingerprints and compares it with the customer's.
3. **Publication on Cardano:** only if the check passes, the agent publishes the fingerprint in its own Preprod transaction (metadata label 674), paying the fee from its dedicated publishing wallet (`npm run publish-wallet` creates it in `.local/publishing-wallet.json`; fund it from the Preprod faucet). Once per job, never retried after an uncertain submission (`src/server/cardano-anchor.mjs`).
4. **Certificate:** the result contains the report, the check, and the transaction hash and explorer link. Masumi then records the hash of this result in the escrow and releases the payment.

The full file never leaves the customer's device. The app shows exactly what the agent receives before approval.

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

## Prices, fees and costs on the Sokosumi path (kept separate)

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
               pricing.mjs (quote model)
               plan.mjs (planner + validation)
               canonical.mjs · merkle.mjs · commitment.mjs · job.mjs (paid service job) · limits.mjs
src/server/    main.mjs (HTTP + static) · tasks.mjs (quote/approval/execution) · states.mjs
               x402-pay.mjs · x402-service.mjs · x402-routes.mjs (x402 payments) · cardano-anchor.mjs (publication)
               config.mjs (mode, price) · sokosumi.mjs (CLI + worker journal) · ai-config.mjs (Meta) · ai-organizer.mjs
               ai-planner.mjs · audit.mjs · store.mjs
public/        index.html · app.js · ui.js · wallet.js (CIP-30) · zip.js (package) · styles.css
chainbridge-answer.mjs   plugs the ChainBridge job into the template worker and MIP-003 API
worker.mjs, paid-task.mjs, agent-api.mjs, payment-registration.mjs, settlement.mjs …   Masumi template (lightly adapted)
test/          ChainBridge tests     *.test.mjs   template tests
```

Extension points: new connectors (databases, APIs) only need to produce `{sourceRow, values}` records for `buildCommitment`. Other anchoring backends would sit beside `src/server/sokosumi.mjs`.

## Tests

`npm test` runs 89 tests: the template's 29 plus ChainBridge's 60. They cover x402 sessions (no charge before publication, single settlement, oversized or wrong fingerprints refused, invalid payments rejected), pricing, the package ZIP, Cardano publication (idempotent, no blind retries), the AI organizer the AI organizer (step whitelist, masking, consent, deterministic re-application), parsing (malformed input, limits), canonicalization and hash vectors, sensitivity heuristics and overrides, Merkle proofs, the odd-node rule, empty and duplicate data, modified-record verification, plan validation, AI output sanitization, job input validation, approval gates, duplicate prevention, uncertain outcomes, state transitions, audit privacy, and the HTTP API. These are local tests. A live Sokosumi/Masumi run is still required for track evidence.

## Demo video outline (≤ 2.5 min)

1. 0:00 Problem: companies can't prove their spreadsheets weren't edited later, and don't want to publish the data.
2. 0:15 Upload the messy shipment list, show the privacy labels, then **Get my price**: 4.75 tADA with a breakdown.
3. 0:40 Accept and pay with a wallet: signed, checked, *not yet charged*.
4. 1:00 AI tidy-up: Meta's report, before/after, apply. Choose columns, create the fingerprint.
5. 1:30 **Publish on Cardano and pay**: show the publication and payment transactions on cardanoscan.
6. 2:00 Download the package, then verify a record and show a tampered value failing. Close on the limits.
