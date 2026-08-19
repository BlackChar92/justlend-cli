# Changelog

All notable changes to the JustLend CLI are documented here.

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
