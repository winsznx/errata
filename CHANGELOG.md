# Changelog

## 0.1.0, 27 November 2026

First public version, built for the JigJoy Black Friday AI Hackathon (Agents in Finance).

- Correction desk for financial research: claim-level dependency graph from published notes to SEC filing figures.
- Four concurrent Mozaik agents (Filing Monitor, Impact Analyst, Financial Verifier, Publication Editor) on `@mozaik-ai/core` 4.2.0, one runtime per workspace.
- Historical replay of real filings for Nocera, The Joint Corp. and Xencor, plus a live EDGAR monitor.
- Independent verification of every replacement figure, challenges between agents, interception of work on outdated evidence.
- Human approval of one exact draft, versioned reissue, correction notices, simulated delivery, PDF, DOCX and Markdown exports.
- Read-only recorded run, evaluation against hand-written ground truth, and workspace export and import.
