# Changelog

All notable changes to the JustLend CLI are documented here.

## [Unreleased]

### Added

- Added public payer history under `energy purchase history` for in-progress and settled direct-purchase orders.

### Fixed

- Applied the mainnet-only production-host guard to the `buy` path, including dry runs and explicit production URL overrides.
- Kept replayable payment recovery state until public history confirms tokenless idempotent orders, and documented the exact signed-request persistence boundary.

## [1.0.1] - 2026-08-19

### Added

- Versioned JSON success/error envelopes with `schemaVersion`, stable `code`, and explicit `retryable` fields.
- Published JSON Schema at `schemas/output-v1.schema.json` for agent and CI validation.
- Process-level regression tests for successful commands, unknown commands, and invalid option values.

### Fixed

- Detect `--json` before Commander parsing so usage errors emit one valid JSON object instead of human text or multiple fragments.
- Route daemon and placeholder JSON paths through the shared success envelope.

## [1.0.0]

- Initial source release covering JustLend V1/V2 reads and writes, staking, energy rental, governance, mining, dry-run simulation, and TronLink signing.
