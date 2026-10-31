# ChainBridge: Devfolio submission draft

> For the person or agent submitting: this is a draft. Show every field to the team and get an explicit "yes, submit" before sending anything. Fields marked **[TEAM]** need input from the team (names, demo video and so on). Don't invent them.

---

## Project name
ChainBridge

## Tagline (short)
Seal any document once with AI and Cardano. Anyone can check it later, for free.

## Track
TUM Blockchain & AI Hackathon 2026, **Cardano track**: "Build an agent, service or developer tool that does a useful job and gets paid for it on Cardano."

## The problem it solves
Business documents are easy to fake or quietly edit:
- a steel test certificate with a failed value marked "OK";
- a vehicle inspection report with the mileage changed;
- a customs declaration with a different value;
- a spreadsheet edited after the fact.

Whoever receives a document usually has no way to tell whether it's the original. Existing options are slow and expensive (notaries), prove nothing (emailed PDFs), or leak private data (putting the data itself on a blockchain). On top of that, the important facts are buried in messy PDFs, photos, Word files and spreadsheets.

**ChainBridge seals a document so that anyone it's sent to can check, for free, that it hasn't changed since. Only an opaque fingerprint ever goes on-chain.**

## What it does
ChainBridge is a pay-per-use AI agent with three parts.

**1. Seal a document (paid).**
1. Upload a PDF, Word file, XML, photo, screenshot, Excel sheet, CSV or JSON.
2. Get a free price, calculated from simple counts, never by AI.
3. Approve the payment. Your wallet signs it, but nothing is charged yet.
4. AI reads the document (Meta's model). It extracts the facts that matter, shows the exact words each one came from, flags personal and confidential data, and ignores instructions hidden inside documents. You confirm or edit every fact.
5. A fingerprint (a salted SHA-256 Merkle root) is created in your browser, including one fingerprint per original file.
6. The agent publishes the fingerprint in a Cardano transaction. **Only after it's confirmed on-chain is your payment settled.** If anything fails before that, you pay nothing.
7. You get a package (facts, report, certificate, private proof file) plus a shareable certificate with a link and QR code for each original file.

**2. Check a document (free).** The recipient adds the certificate and their copy of the file. The file is checked in their browser and never uploaded. There are four separate checks:
- **File match:** is this the file the certificate describes?
- **Cardano record:** is that fingerprint really on the blockchain?
- **Version link:** does the version information match the Cardano record?
- **Issuer signature:** was the certificate signed by the key that published the record?

Each check is shown as Valid, Not valid or Not checked, never faked.

**3. Certificate versions.** Documents change: a failed inspection is followed by a re-inspection, a contract is amended. A new version is a new certificate whose Cardano transaction links to the previous version. The version history is rebuilt live from the blockchain by following those links backwards. **There's no database:** the chain is the source of truth. Gaps, repeated versions, loops and a different series are all detected.

## How it uses Cardano
- **Payment:** x402 pay-per-request on Cardano (`exact` scheme), verified by the Cardano Foundation's facilitator. The buyer's signed payment is settled only after the work is published on-chain. There's no escrow and no account.
- **Proof:** the fingerprint, record count, job reference and, for versions, the series ID, version number and previous transaction are published as transaction metadata (label 674, CIP-20). No documents, facts or personal data go on-chain.
- **Alternative paid path:** the agent also runs as a Sokosumi Coworker, paid through Masumi escrow. It has completed paid tasks with verified seller payouts.
- **Payment check:** if the payment service times out after publishing, a read-only "Check Cardano for the payment" step finds the signed payment on-chain. It never charges twice and never retries uncertain payments.

## Proof it works (Cardano Preprod, test tokens, real transactions)
**Linked certificate versions** (series `s-02fa028c02586bd3`):
- Version 1, published: https://preprod.cardanoscan.io/transaction/0b75d2946fcf181a3f1df3003da3091091f618a8b84bf54c83556992c292ffc4
- Version 2 (links to version 1), published: https://preprod.cardanoscan.io/transaction/c8fe30fc8162ace5bdb24b766e25be6c7ad2dc6c20d1a7e1260c44fe66e8a165
- Version 2, payment settled after publication: https://preprod.cardanoscan.io/transaction/e22e7bbcab6033894a4ac504f40a4fe9dcc50f2b4ce789f0c42d61c36b2cf92d

**Document job with a shareable certificate** (vehicle inspection PDF):
- Published: https://preprod.cardanoscan.io/transaction/72fef65b59940484c8c9a3e72bdd3a2d450c4ec9ccd077e719727d90af14861d
- Paid after publication: https://preprod.cardanoscan.io/transaction/71ce80b13b11fcece07e0940b8d73218b1ce7e49615d9eda4e663b409bfa0400

**Spreadsheet job** (AI tidy-up):
- Published: https://preprod.cardanoscan.io/transaction/7fefcbba57d7cd1acefee34f38aef39ec230d64f687fb87594c5ce868a231872
- Paid: https://preprod.cardanoscan.io/transaction/7e28c4725bb2b179aaff16010e45da4f4cbc323ff0e7166f88f1e8dd7a98e091

**Masumi escrow path** (Sokosumi task, 1 test USDM):
- Escrow funded: https://preprod.cardanoscan.io/transaction/b786f50dcd8e4500cb0ffd8863fb95646766a683e6858cfce242ef4e3dee0beb
- Seller payout: https://preprod.cardanoscan.io/transaction/c95e9694de418594bc08e7bcf96cd097a5587446777bc1fa589be4e944590fca

**Quality:** 118 automated tests, all passing.

## Built with (technologies)
- **Cardano Preprod:** Cardano Serialization Lib, Blockfrost, transaction metadata (CIP-20, label 674)
- **Payments:** x402 (`@x402/cardano`, `@x402/core`) with the Cardano Foundation facilitator; Masumi Payment Service and Sokosumi (agent marketplace, MIP-003)
- **AI:** Meta Model API (`muse-spark-1.3`), with structured output and evidence quotes
- **Server:** Node.js 24, plain JavaScript (ES modules), no framework
- **Cryptography:** WebCrypto SHA-256 Merkle trees, salted leaves, Ed25519 certificate signatures
- **File reading:** PDF, images, Word (.docx), Excel (.xlsx), XML, CSV and JSON, read with built-in code and no extra libraries
- **Other:** QR codes (qrcode-generator), a custom UI with a strict Content Security Policy

## Privacy and safety
- **On-chain:** only opaque fingerprints and references, never documents, facts or personal data.
- **Files stay on your device.** Spreadsheets reach the AI only as a masked sample. Documents go to the AI only after explicit consent.
- **Approval before every payment and publication.** Payment is settled only after delivery, and uncertain payments are never retried automatically.
- **No seed phrases or private keys** are requested or stored.
- **Prompt-injection resistant:** two sample files contain planted instructions, and the AI ignored both.

## Challenges we ran into
- **Making verification work for someone without the uploader's private data.** We added a separately salted fingerprint per original file, so a single file can be proven without revealing any other record.
- **Certificate versions without a database.** Versions are linked on-chain and rebuilt by following previous-transaction links backwards. The trade-off: an older certificate can't reveal newer versions without an indexer, which we state openly.
- **Honest payment states.** The facilitator's settlement call timed out twice on Preprod after publication. Instead of guessing, we added a read-only on-chain check that finds the buyer's signed payment by its own transaction ID.
- **Reading many file formats** (Word, Excel, XML) in the browser and on the server, without heavy libraries and with limits against malicious files.

## Honest limits
- **It proves "unchanged since sealed", not "true".** The AI can misread, which is why every fact is shown with its source words and confirmed by a person.
- **Issuer identity:** the certificate signature belongs to a demo key on a test network. It proves control of a key, not who a company is.
- **Test network only** (Cardano Preprod, test ADA).
- **Runs locally:** share links work on computers running ChainBridge until it's deployed publicly. Certificate files can be sent today.
- **Versions work backwards only:** newer versions can't be found from an older certificate.

## What's next
1. Public deployment, so share links and QR codes work for anyone, with a check-only public mode.
2. Verified issuer identity, linking a signing key to a real company.
3. Browser wallets (Lace, Eternl) end to end; the demo currently uses a test wallet.
4. Mainnet.

## Links
- **GitHub:** https://github.com/madhavgupta340/ChainBridge
- **Demo video:** **[TEAM]**
- **Presentation / slides:** **[TEAM]**
- **Live demo:** none (runs locally; see the README quick start)

## Team
**[TEAM]** names, roles and Devfolio handles.
