# paperless-ai Image Baseline

## Upstream provenance

| Property | Value |
|---|---|
| **Upstream project** | [clusterzx/paperless-ai](https://github.com/clusterzx/paperless-ai) (MIT license) |
| **Fork point** | `clusterzx/paperless-ai@d2fda69` — "Add maintenance notice to README" (2026-03-31) |
| **Current head** | `mattr7m/paperless-ai@0044a55` — merge commit of `develop` into `main`, tagged `v3.0.9-mattr7m.0044a55` |
| **Fork status** | Upstream `main` has not moved since the fork point (stagnant; upstream author posted maintenance notice on 2026-03-31) |
| **Pin type** | Tag-pinned at fork point (`d2fda69`); no digest pin in the Containerfile |

The fork was cut from upstream after version `v3.0.9` (upstream tag). Upstream is effectively
abandoned — the author noted a rewrite-in-progress and uncertainty about continuing maintenance.
This repo carries all ongoing development on the `develop` branch.

## Delta: customizations over upstream

**15 commits on `develop`**, touching 8 files (459 insertions, 216 deletions). The Containerfile
itself has **not changed** since the fork point — all delta is application code and CI config.

| # | Commit | Area | What + Why |
|---|---|---|---|
| 1 | `eb9679d` | CI | Added `.github/workflows/build-develop.yml` — builds/pushes a `ghcr.io/mattr7m/paperless-ai:develop` image on every push to `develop`. Replaces upstream's nightly cron with branch-triggered builds. |
| 2 | `942ac01` | RAG | Fixed RAG chat failures: added lightweight status checks and reduced `max_tokens` to prevent LLM timeouts during streaming responses. |
| 3 | `88f1a4f` | RAG | Added timing logs to the RAG `askQuestion` flow for performance debugging. |
| 4 | `f5cee09` | RAG | Skips full document fetch in RAG ask to prevent LLM timeouts — reads only the summary/prompt instead of fetching the entire document content from Paperless-ngx API. |
| 5 | `2303d44` | RAG | Added streaming SSE (Server-Sent Events) support for RAG chat — clients receive tokens incrementally instead of waiting for the full response. |
| 6 | `3820cf8` | RAG | Fixed SSE streaming: disabled proxy buffering and filtered `<think>` blocks from LLM output so they don't leak to clients. |
| 7 | `e37f6d4` | RAG | Fixed think-block handling: streams all tokens (including think blocks) internally but filters them on display; previously think blocks were dropped entirely. |
| 8 | `bfa36e1` | RAG | Added SSE heartbeat to prevent Traefik proxy timeout during long-running LLM responses (keeps the connection alive). |
| 9 | `b78d930` | RAG | Added SSE stream debug banner and console logging for frontend debugging. |
| 10 | `34866fc` | RAG | Fixed SSE keepalive: switched from comment-based keepalive to `data` events (more reliable across proxies), disabled Nagle's algorithm (`TCP_NODELAY`) for lower latency. |
| 11 | `a175bbd` | RAG | Added async job + polling for RAG queries — long-running queries are submitted as background jobs and polled by the client instead of blocking the HTTP connection. |
| 12 | `03644a6` | RAG | Added debug logging comparing async job raw vs. cleaned answer lengths to diagnose truncation issues. |
| 13 | `de6f6f1` | RAG | Improved RAG prompt for OCR document handling — better instructions for the LLM when processing OCR'd text (handles formatting artifacts, improves tag extraction). |
| 14 | `66bf96f` | CI/Release | "Prepare for production release" — merged final develop state into main and cut the release tag. |

**Delta summary**: All 15 custom commits are focused on **RAG chat streaming improvements** —
the upstream repo's RAG feature was functional but had timeout issues, no streaming, and no
async job handling. The mattr7m fork added full SSE streaming, async polling for long queries,
proxy-timeout mitigation (heartbeats, TCP_NODELAY), and prompt improvements for OCR documents.

### Files NOT touched (upstream-unchanged)

`Dockerfile`, `Dockerfile.rag`, `requirements.txt`, `package.json`, `server.js`, `routes/*.js`
(except `rag.js`), `services/*.js` (except those listed above), `views/` (except `rag.ejs`).
The Containerfile and base dependency files are identical to upstream at the fork point.

## Build and publish channel

### Current state

| Trigger | Workflow | Output |
|---|---|---|
| Push to `develop` | `build-develop.yml` | `ghcr.io/mattr7m/paperless-ai:develop` (linux/amd64 only, push=true) |
| Release published | `docker-build-push.yml` | `ghcr.io/mattr7m/paperless-ai:<tag>` + `:latest` (linux/amd64) |
| Manual dispatch | `manualPush.yml` | Docker Hub (`${DOCKER_USERNAME}/paperless-ai`) + GHCR, multiarch (amd64+arm64), custom tag or SHA-based |

**Only one image is built from the Containerfile**: `Dockerfile` (the main Node.js + Python
multi-service image). `Dockerfile.rag` exists as a standalone Python RAG service image but is
not wired into any CI workflow.

### Base image pin

The Containerfile uses `FROM node:22-slim` — **floating tag, not digest-pinned**. This means
every build pulls the latest `node:22-slim` patch, which could change without notice. No OCI
source label (`org.opencontainers.image.source`) is present in the Containerfile.

### Tags today

- Upstream (Docker Hub, `clusterzx/paperless-ai`): `latest`, `nightly`, `3.0.x`… — these are
  **upstream** tags, not mattr7m's.
- mattr7m (GitHub tag only): `v3.0.9-mattr7m.0044a55` (on `main`).
- No candidate/rc tags exist yet; no pre-release channel is established.

## Consumers

The image is consumed by the paperless deployments (`paperless-ngx` prod / `paperless-ngx-dev`)
via image references in `paperless-ngx-ops` Helm values files. The values repo
(`mattr7m/paperless-ngx-ops`) is private and could not be read in this pass.

**Recorded tags from upstream Docker Hub for reference:**
`latest`, `nightly`, `3.0.9`, `3.0.8`, `3.0.7`, `3.0.6`, `3.0.5`, `3.0.4`, `main-702e169`, …

**Consumed reference in prod/dev**: TBD — requires read access to `paperless-ngx-ops` values
files (`helm/paperless-ngx-values.yaml`, `helm/paperless-ngx-dev-values.yaml`). The deployment-maintainer owns this; the image-developer records it here once available.

## Memory profile notes

The image runs **both a Node.js (PM2) service and a Python (FastAPI + torch + chromadb) service**
in the same container. PyTorch alone can consume 1-2 GB at import time; ChromaDB's vector store
grows with document volume. The paperless python workloads previously OOM'd a worker node
(`k3s2-worker3-oom-notready`). No profiling was done in this pass, but the dual-service design
with PyTorch is a known memory pressure factor — any RAG/LLM change that increases model loading
or vector store size warrants re-checking resource budgets with the deployment-maintainer.

## Candidate/release channel proposal

Per `image-maintainer`, propose the following channel shape for this single image:

### Daily pre-release (floating)

- **Trigger**: scheduled daily (cron) + `workflow_dispatch`.
- **Action**: bump nothing (the Containerfile's `node:22-slim` is already floating; a daily run
  answers "does latest node:22-slim still build?"). Build and push to
  `ghcr.io/mattr7m/paperless-ai:daily`.
- **Purpose**: catch base-image breakage early.

### Pinned candidate prerelease (rc)

- **Trigger**: scheduled (e.g. weekly) + `workflow_dispatch`.
- **Action**: 
  1. Pin `node:22-slim` to an exact digest (e.g. `node:22-slim@sha256:…`).
  2. Pin all Python packages to exact versions in a committed `requirements.lock` (generated by
     `pip freeze` from the current install).
  3. Pin `npm` dependencies via an existing `package-lock.json` (already present; verify it's
     committed and up-to-date).
  4. Build, test, push as `ghcr.io/mattr7m/paperless-ai:vX.Y.Z-rc.N`.
  5. Create a lightweight git tag `vX.Y.Z-rc.N` (not a GitHub Release).
- **Purpose**: a fully reproducible, known-good base for the deployment-maintainer to consume.

### Weekly release

- **Trigger**: scheduled weekly + `workflow_dispatch`.
- **Action**: promote the latest green candidate **by digest** (re-tag) to `vX.Y.Z` + `:latest`,
  create a GitHub Release with generated notes + image version manifest section. Skip if already released.

### Feature releases

- If development warrants an ad-hoc release, the developer cuts a feature-release tag
  (`vX.Y.Z-rc.N-<feature>`) per `image-developer`. The maintainer's weekly release process
  promotes it in preference to the latest candidate.

### Branch model

The repo already uses `develop` for integration and `main` for releases — this aligns with the
proposal. CI should build candidates from `main` (after merge from develop) and push rc tags.

## Risks surfaced

1. **Floating base image** — `FROM node:22-slim` is not digest-pinned. Every build may pull a
   different patch of the Node.js 22 runtime. This is the single highest-impact reproducibility
   risk.
2. **No OCI source label** — the Containerfile lacks
   `LABEL org.opencontainers.image.source="https://github.com/mattr7m/paperless-ai"`, so any
   published image won't auto-link to its source repo in GHCR.
3. **Build blocked in pod** — no container runtime (podman/docker daemon) is available in the
   agent pod, so a clean local build could not be verified. The `pull_request` CI build will be
   the required check per `image-developer`.
4. **Consumed reference unknown** — the private `paperless-ngx-ops` repo could not be read; the
   exact image reference deployed in prod/dev is TBD. This blocks confirming which tag the fleet
   actually runs.
5. **Upstream abandoned** — upstream `clusterzx/paperless-ai` main is stagnant at the fork point
   with no indication of future merges. All development is mattr7m-owned; this justifies the
   fork but means there's no automatic security patch flow from upstream. Any upstream movement
   must be manually rebased.
6. **requirements.txt uses `>=` pins** — Python dependencies use minimum-version constraints
   (`>=0.95.0`, `>=2.0.0`), not exact pins. This means pip resolves to whatever is latest at
   build time, which can change the image contents between builds even if the base image stays
   the same.
7. **Dockerfile.rag is orphaned** — a second Containerfile exists but has no CI workflow. It's
   unclear if it's still needed or was superseded by the multi-service `Dockerfile`.
8. **No smoke test in CI** — the `build-develop.yml` workflow only builds and pushes; there is
   no lint, verify-pins, or smoke-test step on the PR path (the workflow triggers on push to
   develop, not on pull_request).

## Build attempt

A clean build could not be performed — no container runtime (podman/docker daemon) is available
in the agent pod. The `pull_request` CI workflow will serve as the required build gate.
Per `image-developer`, this is an expected environment limitation; CI is the authoritative
build check.

## Status log

- **2026-08-05** (task author — agent-maintainer) — created as the image-developer's first pass:
  inventory the owned custom image (upstream ref, delta + why, build/publish channel, consumers,
  pins), verify a clean local build, propose the candidate-channel shape, surface risks. No
  pass run yet.
