# 0003: CI And Cloudflare Deployment Transition

Status: Draft

Date: 2026-06-05

## Context

The repository currently deploys the frontend to GitHub Pages and deploys a
Cloudflare Worker cron pinger. The migration target is Cloudflare Pages plus a
Worker API backed by R2/D1, but the current GitHub Pages and git-backed data
paths must remain available during transition.

## Decision

Run old and new deployment paths in parallel while the storage/API path is
proven:

- Keep the existing GitHub Pages deploy.
- Add a Cloudflare Pages deploy workflow that builds the same static export and
  deploys only when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_PAGES_PROJECT` are
  configured.
- Keep `NEXT_PUBLIC_DATA_SOURCE=static` for Cloudflare Pages until the Worker
  API is seeded and verified.
- Validate Python ingest/analysis, frontend tests/build, and Worker typecheck
  in CI.
- Apply D1 migrations during Worker deploy only when `NEMWEB_D1_DATABASE_NAME`
  is configured.

## Required Configuration

- Repository secret: `CLOUDFLARE_API_TOKEN`
- Repository variable: `CLOUDFLARE_PAGES_PROJECT`
- Repository variable: `NEMWEB_D1_DATABASE_NAME`
- Worker secret: `GH_DISPATCH_TOKEN`

R2 bucket bindings and D1 database bindings still need real Cloudflare resource
names/ids before the storage-backed API can become the default.

## Rollback

- GitHub Pages remains active while Cloudflare Pages is introduced.
- The frontend defaults to static data until `NEXT_PUBLIC_DATA_SOURCE=api` is
  explicitly set.
- The live-data branch and cron pinger remain active until `/api/live` is
  storage-backed and verified.
