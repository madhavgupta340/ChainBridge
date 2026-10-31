# ChainBridge: briefing for building the hackathon presentation

> **How to use this file:** paste all of it into Claude and say what you need, e.g. "Make a 6-slide pitch deck", "Write the speaker notes" or "Draft a 2.5-minute demo script". Everything below is accurate as of 31 Oct 2026. Please keep the claims as honest as they are written here: the judges can check every transaction link.

---

## 1. Context

- **Event:** TUM Blockchain & AI Hackathon, 30–31 October 2026.
- **Track:** Cardano. The brief: *"Build an agent, service or developer tool that does a useful job and gets paid for it on Cardano."*
- **Project name:** ChainBridge
- **Repository:** https://github.com/madhavgupta340/ChainBridge
- **Network:** Cardano **Preprod**, a public test network. All payments use test ADA (tADA), which has no real value. Say this clearly in the presentation.
- **Built on:** the official Masumi TUM hackathon quickstart (Masumi is Cardano's agent payment network; Sokosumi is its agent marketplace).

## 2. One-line pitch (pick one)

- "ChainBridge lets anyone seal a document so that whoever receives it can check, for free, that it hasn't been changed since."
- "A pay-per-use AI agent on Cardano that reads your documents, seals the facts with a fingerprint, and lets anyone verify them later."
- Short: **"Seal it once. Anyone can check it."**

## 3. The problem

- Documents are easy to fake or quietly edit: a car inspection report with the mileage changed, a supplier certificate with a failed test marked as passed, a spreadsheet edited after the fact.
- The person receiving a document usually has no way to tell whether it's the original.
- Existing options are clumsy. Notaries are slow and expensive. Emailing PDFs proves nothing. Putting the actual data on a blockchain would make private information public forever.
- Documents are also messy (PDFs, photos, screenshots), so the important facts are buried.

## 4. The solution, in plain words

ChainBridge does two things, shown as two tabs in the app.

### Tab 1: "Seal a document" (paid)
Example: a garage seals an inspection report.
1. **Upload** a PDF, photo, screenshot or spreadsheet. Nothing leaves the device yet.
2. **Free price quote**, calculated from simple counts (pages, documents, rows), not by AI. Example: 3.25 tADA.
3. **Authorise payment** with a Cardano wallet. The payment is signed and checked, but **not charged yet**.
4. **AI reads the document** (Meta's AI). It pulls out the facts that matter (VIN, mileage, defects, pass/fail) and shows the exact words each fact came from. It ignores filler and also ignores instructions hidden inside the document (we planted one as a test, and it was ignored). The user ticks, edits and confirms.
5. **Fingerprint:** a 64-character code created on the user's own device. Change even one character of the file and the fingerprint changes completely. The fingerprint reveals nothing about the content.
6. **Publish on Cardano:** the agent writes the fingerprint into a Cardano transaction, like a note on a public notice board that nobody can erase or backdate. Only the code goes on-chain, never the document or the facts.
7. **Only now is the payment charged.** If anything fails before publication, the customer pays nothing.
8. **Package and share:** a ZIP with the facts (CSV), an AI report, a certificate, and a private proof file. Plus **one shareable certificate per original file, with a link and a QR code**.

### Tab 2: "Check a document" (free)
Example: a car buyer receives the report.
1. Add the certificate (file, link or QR code) and their copy of the document.
2. The document's fingerprint is calculated **in their browser**. The file is never uploaded.
3. Three separate checks, each shown as Valid, Not valid or Not checked:
   - **File match:** is this file the one the certificate describes?
   - **Cardano record:** is that fingerprint really on the blockchain?
   - **Issuer signature:** was the certificate signed by the same key that published the record, so it wasn't forged later?
4. Result: **"✓ This file matches the sealed version"** or **"✗ This file is different"**.

## 5. Why it fits the Cardano track

| Track requirement | How ChainBridge meets it |
|---|---|
| An agent that does a useful job | An AI agent reads messy documents, extracts verifiable facts, and seals and publishes them. |
| Gets paid on Cardano | **x402 pay-per-use:** the customer's wallet signs a payment and the agent settles it on Cardano only after delivering. There's also a second, working payment path through Masumi escrow on Sokosumi. |
| Uses Cardano meaningfully | The fingerprint is published as transaction metadata (CIP-20, label 674), and the verifier reads it back from the chain. |
| Honest, safe agent behaviour | Approval before every payment and publication, no charge on failure, no automatic retries of uncertain payments, and no raw data on-chain. |

## 6. Proof it works: real transactions (Cardano Preprod, test tokens)

All links open on the public explorer **preprod.cardanoscan.io**.

**Full document job with a shareable certificate (the newest and best demo):**
- Car inspection report PDF, 29 facts sealed, 3.25 tADA.
- Fingerprint published in block 5356536: https://preprod.cardanoscan.io/transaction/72fef65b59940484c8c9a3e72bdd3a2d450c4ec9ccd077e719727d90af14861d
- Payment settled **after** publication: https://preprod.cardanoscan.io/transaction/71ce80b13b11fcece07e0940b8d73218b1ce7e49615d9eda4e663b409bfa0400
- **The check:**
  - **The original PDF:** all three checks Valid.
  - **A copy with one bit changed:** "✗ This file is different".
  - **The certificate itself:** contains no extracted facts.

**Earlier document job (first test of AI reading a PDF):**
- 30 facts extracted, and the hidden instruction in the PDF was ignored.
- Published in block 5355379: https://preprod.cardanoscan.io/transaction/ae4e8cc3c4096a7048fd3d954dbd3e64e92ad256d8c8875d9297614123cea743
- Paid 3.25 tADA: https://preprod.cardanoscan.io/transaction/304b4968e69c813d76145443123d73a024f87d4351bc966db4201926498c0058

**Spreadsheet job (AI tidy-up of a messy shipment list):**
- Published in block 5355257: https://preprod.cardanoscan.io/transaction/7fefcbba57d7cd1acefee34f38aef39ec230d64f687fb87594c5ce868a231872
- Paid 4.75 tADA: https://preprod.cardanoscan.io/transaction/7e28c4725bb2b179aaff16010e45da4f4cbc323ff0e7166f88f1e8dd7a98e091

**Alternative payment path: Masumi escrow via the Sokosumi marketplace (1 test USDM):**
- Escrow funded: https://preprod.cardanoscan.io/transaction/b786f50dcd8e4500cb0ffd8863fb95646766a683e6858cfce242ef4e3dee0beb
- Result submitted: https://preprod.cardanoscan.io/transaction/60fbe98f1218df429de034093c8688844789779623f7cd5a14252c7db13e943c
- Seller paid out (receipt verified): https://preprod.cardanoscan.io/transaction/c95e9694de418594bc08e7bcf96cd097a5587446777bc1fa589be4e944590fca

**Quality:** 104 automated tests, all passing.

## 7. How it works (one level deeper, for a technical slide)

- **AI:** Meta's Model API (`muse-spark-1.3`).
  - **Documents:** reads PDFs and images and returns structured facts with evidence quotes, privacy labels and confidence.
  - **Spreadsheets:** sees only a masked sample (private columns hidden) and suggests tidy-up steps from a fixed safe list. ChainBridge's own code applies them, not the AI.
- **Fingerprint:** each record and each original file is hashed (SHA-256, with random salts for privacy) and combined into one Merkle root, the "fingerprint". This happens in the browser.
- **Blockchain:** the agent's own wallet publishes the root in a Cardano transaction (metadata label 674). Fee about 0.17 tADA, paid by the agent.
- **Payment, x402:** an HTTP-native "402 Payment Required" protocol. The service names its price, the wallet signs, the Cardano Foundation's facilitator verifies the payment, and the agent settles it only after publishing. There is no escrow and no account.
- **Pricing:** fixed rules, never set by the AI. For example, documents cost 2 tADA plus 0.5 per page plus 0.25 per document, so the price is free to see, predictable and explainable.
- **Shareable verification:** each original file gets its own small proof in the certificate. Anyone holding that file can check it without seeing any other data. The certificate is signed by the agent's key, the same key that published on Cardano.
- **Stack:** Node.js, plain JavaScript with no framework, Cardano Serialization Lib, Blockfrost, `@x402/cardano`, Masumi Payment Service.

## 8. Privacy and safety (judges like this)

- **On-chain:** only a 64-character fingerprint, a record count and a job reference. Never documents, values, names or column names.
- **Your file stays on your device.** The one exception is the AI step for documents, which needs explicit consent first, because a photo or PDF can't be partly hidden.
- **Spreadsheets:** the AI sees only a masked sample, at most 10 rows with private columns hidden.
- **Approval before every payment and publication.**
- **Pay only for delivered work:** the payment is settled only after the fingerprint is on-chain.
- **No automatic retries** of payments or blockchain actions whose outcome is uncertain.
- **Wallet keys:** no seed phrases or private keys are ever asked for. The customer's wallet signs.
- **Prompt-injection resistant:** text inside a document is treated as content, never as instructions.

## 9. Honest limits (say these; they build trust)

- **It proves "unchanged since sealing", not "true".** If a report was false when sealed, the seal only proves nobody changed it afterwards.
- **It doesn't prove real-world identity.** The signature belongs to a demo key labelled as a demo. There's no registry linking keys to real companies yet.
- **Test network only.** Everything runs on Cardano Preprod with test money.
- **Runs locally for now.** Share links work only on a computer running ChainBridge until it's deployed at a public address. Today the certificate file can be sent instead.
- **AI can misread.** That's why every fact is shown with its source words and confirmed by a human before sealing.

## 10. Who would use it (use cases)

- **Used-car sales:** the garage seals the inspection report and the buyer checks it.
- **Supply chains:** suppliers seal quality certificates and buyers verify them.
- **HR and payroll:** seal an export without publishing personal data.
- **Insurance claims:** seal photos and reports at the time of the incident.
- **Any business** that wants to show later that a record wasn't edited.

## 11. What's next (roadmap slide)

1. **Public deployment,** so share links and QR codes work for anyone.
2. **Real issuer identity:** verified business keys, so the check also shows who sealed it.
3. **Browser wallets** (Lace, Eternl) end to end. Today the demo uses a test wallet on the laptop.
4. **Compare versions,** e.g. "the mileage went down since the last sealed report".
5. **Mainnet,** with real payments.

## 12. Suggested deck (6–8 slides)

1. **Title:** ChainBridge, "Seal it once. Anyone can check it." Team names, TUM Blockchain & AI Hackathon, Cardano track.
2. **Problem:** fake or edited documents, with one concrete story (the car mileage).
3. **Solution:** the two tabs, Seal (paid) and Check (free), as a simple two-column graphic.
4. **How it works:** Upload → AI reads → Fingerprint → Cardano → Pay → Share. A flow diagram, with "only the fingerprint goes on-chain" highlighted.
5. **Live demo,** or the recorded video.
6. **Proof:** real Cardano transaction links (section 6), "104 tests", and "pay only after delivery".
7. **Privacy and honest limits:** sections 8 and 9, condensed.
8. **Use cases and what's next:** sections 10 and 11.

## 13. Demo script (about 2.5 minutes)

1. **0:00 Problem.** "A seller can change the mileage on an inspection PDF. The buyer can't tell."
2. **0:15 Seal.** Open ChainBridge and load the sample car inspection report. Show the free price: 3.25 tADA.
3. **0:30 Pay.** "Accept and pay": the overlay shows "Authorised. You're charged only when the fingerprint is published."
4. **0:45 AI.** The reading animation runs, then the extracted facts appear, each with its source words. Point out the hidden instruction the AI ignored.
5. **1:15 Publish.** "Publish on Cardano and pay": the overlay shows "Paid", with both transaction links. Open one on cardanoscan and show the fingerprint in the metadata.
6. **1:45 Share.** The package step shows the certificate with its QR code and link.
7. **2:00 Check.** Switch to the Check tab, add the certificate and the PDF: "✓ matches", all three checks Valid. Then add an edited copy: "✗ This file is different".
8. **2:20 Close.** "Only a fingerprint is public. It proves unchanged, not true. Next: public deployment and verified issuers."

Tip: publishing takes 1–3 minutes on Preprod, so in a live demo either pre-record that part or use the already-published certificate. Its ID is `3254f4bda5c73a14528193503d2f07cf`, and it matches `samples/car-inspection-report.pdf` in the repo.

## 14. Likely judge questions and answers

- **Why blockchain and not just a database?** Nobody, including us, can edit or backdate the record, and anyone can check it without trusting ChainBridge.
- **Isn't putting data on a blockchain a privacy risk?** We never put data on-chain, only a fingerprint that reveals nothing.
- **What if the AI makes a mistake?** Every fact shows its source words and a human confirms it before sealing. The AI only suggests; it never decides the price or what gets published.
- **What stops someone faking a certificate?** The certificate is signed by the key that published the Cardano record, and the checker verifies both. A changed certificate fails the signature check.
- **Why x402 instead of escrow?** It's direct pay-per-use with no account. We protect the customer by settling only after the work is delivered. The escrow path (Masumi) also works and is shown.
- **Who pays the blockchain fee?** The agent pays the publishing fee (about 0.17 tADA) from its own wallet. The customer's wallet pays the small fee on its own payment.
- **Is it live on mainnet?** No. It's on the Preprod test network. Mainnet is on the roadmap.

## 15. Words to use, and words to avoid

- **Say:** "fingerprint", "seal", "public record on Cardano", "check", "unchanged since sealed".
- **Avoid:**
  - "proves it's true" (it doesn't);
  - "verified company" (there's no identity registry yet);
  - "real money" (it's test ADA);
  - "stores your documents on the blockchain" (it never does).
