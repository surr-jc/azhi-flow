# Source of this skill

Written for Azhi Flow (Apache-2.0, see `LICENSE`); no text was copied from another project. It follows the
file layouts, requirement and scenario formats, delta operations and lifecycle of OpenSpec
(https://github.com/Fission-AI/OpenSpec, MIT licensed; docs/concepts.md, docs/writing-specs.md and the
spec-driven schema, read 2026-11-04).

Why written rather than adapted: OpenSpec is a CLI with slash commands that run interactively in a
developer's checkout. Here each step is an agent with a fixed role, and the proposal check and the archive
check are scripts in this package (scripts/spec_check.py) that work on the files a step returns.
