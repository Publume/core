# Prompt evaluation

Publume Core includes a live, repeatable evaluation for the publication gate and article-generation prompts. It calls the same `createEditorial` and OpenAI-compatible client used by the production pipeline; it does not collect sources, run report consolidation, publish content, or access GitHub.

The dataset contains 30 synthetic but production-shaped cases:

- 24 gate decisions covering material updates, authoritative single sources, duplicate events with and without a material development, promotion, rumors, unsupported claims, stale coverage, fixtures, internal logs, and sparse evidence.
- 6 article generations covering fact preservation, uncertainty, attribution, non-clickbait structure, source-set integrity, and avoiding padding when the source is sparse.

All built-in system prompts are English. `legacy-core` and `reference-baseline` are comparison baselines; only `current-core` determines the command exit status.

## Run

Use the configured provider key without placing it in an argument or report:

```bash
export DEEPSEEK_API_KEY=...
bun run eval:prompt -- --compare --output=/tmp/publume-prompt-eval.json
```

The default live configuration is `deepseek-v4-flash` through `https://api.deepseek.com/v1`. Override it with the normal `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL`, and `AI_API_KEY` environment variables. Set `--concurrency=1..20` or `PROMPT_EVAL_CONCURRENCY` to control request concurrency.

Run only the production prompt with:

```bash
bun run eval:prompt -- --variant=current-core
```

## Required thresholds

`current-core` passes only when all conditions hold:

- gate classification accuracy is at least 90%;
- expected machine-readable risk tags are present in at least 75% of applicable rejections;
- no critical unsafe fixture, rumor, anonymous security claim, unsupported medical claim, or internal log is published;
- at least 80% of generated articles satisfy the deterministic article rubric;
- no model request or output-contract error occurs.

The command exits non-zero when the production prompt misses a threshold. Baseline failures remain visible in the report but do not fail the command.

## Editorial profile comparison

Profile prompts have a separate paired evaluation:

```bash
bun run eval:profiles -- --output=/tmp/publume-profile-prompt-eval.json
```

Generate and score Simplified Chinese output with the same fixtures and runtime path:

```bash
bun run eval:profiles -- --language=zh-CN --output=/tmp/publume-profile-prompt-eval-zh-CN.json
```

It runs 18 gate cases and 9 article cases against both sides of the comparison:

- **before:** the former generic `news`, `briefing`, and `analysis` policies,
  mapped to the closest task for each fixture;
- **after:** the nine current publication-task profiles on the same candidates,
  claims, model, and runtime path.

The 9 article fixtures contain 42 independently scored facts. Generation is
non-deterministic, so exact fact and article scores are diagnostics rather than
universal 100% gates. A single article passes with at least 75% of its required
facts when its style, structure, summary distinctness, and forbidden-claim
checks also pass.

The aggregate thresholds are:

- gate accuracy and fact recall: at least 90%;
- style and summary distinctness: at least 85%;
- complete-article pass rate: at least 80%;
- fixed Story Block structure: 100%;
- critical false positives, forbidden claims, request errors, and output-contract errors: zero.

Each profile must also retain at least 70% of its required facts, classify at
least one of its two gate fixtures correctly, preserve its fixed structure, and
have no hard failure. Relative to the legacy prompts, a soft metric may move by
at most 12 percentage points while structure conformance must improve by at
least 50 points. This prevents small model variance from failing the run without
letting aggregate scores hide a broken profile or weakening source boundaries.

The JSON report stores both profile hashes, the fixture hash, per-profile
results, full generated articles, raw model responses, and percentage-point
deltas. Report schema version 3 also stores the evaluated language and the exact
thresholds used for the pass decision.

## Evidence boundary

This evaluation measures one model configuration against a fixed synthetic dataset. It checks classification, source-bounded gate/article output contracts, deterministic profile structure, and direct summary repetition. It does not prove factual truth, measure broader semantic or stylistic quality, exercise article-page retrieval, or evaluate report grouping. One Chinese run does not establish quality across topics, providers, or repeated model samples. Production monitoring and human editorial review remain necessary. Model, language, dataset hash, timestamps, per-case outputs, failures, and request duration are stored in the optional JSON report so results can be compared without treating one run as universal proof.
