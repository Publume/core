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

It runs 18 gate cases and 9 article cases against both sides of the comparison:

- **before:** the former generic `news`, `briefing`, and `analysis` policies,
  mapped to the closest task for each fixture;
- **after:** the nine current publication-task profiles on the same candidates,
  claims, model, and runtime path.

The profile evaluation passes only when every current gate classification,
required article fact, and article rubric passes, with no critical false
positives and no request or contract errors. The after side must not regress any
measured quality dimension and must improve at least one.
The JSON report stores both profile hashes, the fixture hash, per-profile
results, and percentage-point deltas.

## Evidence boundary

This evaluation measures one model configuration against a fixed synthetic dataset. It checks classification and the source-bounded gate/article output contracts, but it does not prove factual truth, exercise article-page retrieval or evaluate report grouping. It is not a substitute for production monitoring, human editorial review, or evaluation across every supported provider and language. Model, dataset hash, timestamps, per-case outputs, failures, and request duration are stored in the optional JSON report so results can be compared without treating one run as universal proof.
