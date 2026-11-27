import Link from "next/link";
import { Wordmark } from "@/components/app-shell";
import "./landing.css";

const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL;
const SAMPLE = process.env.NEXT_PUBLIC_SAMPLE_REPORT_PATH;

const RESTATED_FIGURES = [
  { claim: "Total current assets", original: "$1,275,416", corrected: "$670,496", evidence: "10-K/A, as restated", checkedBy: "Financial Verifier, read independently" },
  { claim: "Total current liabilities", original: "$706,384", corrected: "$794,149", evidence: "10-K/A, as restated", checkedBy: "Financial Verifier, read independently" },
  { claim: "Working capital", original: "$569,032", corrected: "−$123,653", evidence: "Recomputed in code", checkedBy: "Financial Verifier, recomputed" },
  { claim: "Current ratio", original: "1.81", corrected: "0.84", evidence: "Recomputed in code", checkedBy: "Financial Verifier, recomputed" },
];

const TIMELINE = [
  { when: "May 15, 2025", what: "Nocera’s Q1 10-Q reports current assets of $1,275,416 and current liabilities of $706,384." },
  { when: "May 20, 2025", what: "A research note publishes those figures and calls liquidity comfortable." },
  { when: "Aug 17, 2026", what: "Form 8-K Item 4.02 says Q1 to Q3 2025 and both fiscal years should no longer be relied upon." },
  { when: "Eleven days", what: "Readers need a warning, but no corrected figures exist yet.", gap: true },
  { when: "Aug 28, 2026", what: "Form 10-K/A No. 2 restates Q1. Current assets are $670,496 and current liabilities $794,149." },
];

const CAPABILITIES = [
  { title: "Which figures each note relies on", body: "Every number in a note is tied to an exact filing row, a calculation over other figures, or marked as plain text. Conclusions record the figures they depend on." },
  { title: "What was public, and when", body: "Filings carry their SEC acceptance time. In a replay, agents only see a filing once the clock reaches it, so nothing is corrected with evidence from the future." },
  { title: "Who proposed a figure and who checked it", body: "One agent proposes, a different agent reads the filing itself, and code re-reads the cited table cell from the stored bytes. Nobody verifies their own work." },
  { title: "Exactly what an editor approved", body: "Approval binds one draft and one evidence revision. New evidence expires it. Reissuing is a separate step that rechecks everything in one transaction." },
  { title: "Every version a reader ever saw", body: "Published text never changes. Old versions stay readable with their warning and a link to the current one, and the notice explains what moved and why." },
  { title: "What the agents actually did", body: "Each agent loop, tool call, challenge and rejected stale result is recorded, with a link to the live session in Mozaik Cloud." },
];

const STEPS = [
  { title: "A non-reliance notice arrives", agents: "Filing Monitor", body: "Reads Item 4.02 and proposes which periods are affected, citing the paragraphs that say so." },
  { title: "Readers are warned", agents: "Financial Verifier", body: "Reads the same notice on its own. Once it agrees, every note citing those periods is flagged on its public page, before corrected figures exist." },
  { title: "The amendment is read twice", agents: "Impact Analyst and Financial Verifier", body: "One proposes restated figures, the other finds each one independently and rejects anything with the wrong period, column or scale. Derived figures are recomputed in code." },
  { title: "An editor approves the exact correction", agents: "Publication Editor", body: "Rewrites the affected passages and the notice. A person approves and reissues. The old version stays on record and recipients get the notice." },
];

export default function LandingPage() {
  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-container lp-nav-inner">
          <Wordmark />
          <nav aria-label="Site" className="lp-nav-links">
            <a href="#problem">Problem</a>
            <a href="#product">Product</a>
            <a href="#how">How it works</a>
            {REPO_URL ? <a href={REPO_URL}>Source</a> : null}
          </nav>
          <Link className="lp-button lp-button-sm" href="/demo">
            Start the demo
          </Link>
        </div>
      </header>

      <main id="main">
        <section className="lp-hero" aria-labelledby="hero-title">
          <div className="lp-container lp-center">
            <h1 id="hero-title" className="lp-display">
              When financial facts change, fix every report that depended on them.
            </h1>
            <p className="lp-lede">
              Errata reads SEC filings for non-reliance notices and restatements, finds the published research that cites the affected figures, warns readers straight away, and prepares a corrected version
              that an editor approves.
            </p>
            <div className="lp-actions">
              <Link className="lp-button" href="/demo">
                Run the Nocera correction
              </Link>
              {SAMPLE ? (
                <a className="lp-button lp-button-outline" href={SAMPLE}>
                  Read a corrected note
                </a>
              ) : (
                <a className="lp-button lp-button-outline" href="#how">
                  See how it works
                </a>
              )}
            </div>
            <p className="lp-fineprint">Uses public SEC filings and a synthetic research note. No sign-up. Not financial advice.</p>
          </div>

          <div className="lp-container lp-hero-panels">
            <div className="lp-panel lp-panel-quiet">
              <ol className="lp-events" aria-label="What the note’s readers were told">
                <li className="lp-event">
                  <span className="lp-event-date">Aug 17, 2026</span>
                  <strong>Readers warned</strong>
                  <span>Nocera filed Form 8-K Item 4.02. Figures in this note rely on statements that should no longer be relied upon.</span>
                </li>
                <li className="lp-event-gap">Eleven days with no corrected figures</li>
                <li className="lp-event">
                  <span className="lp-event-date">Aug 28, 2026</span>
                  <strong>Corrected figures verified</strong>
                  <span>Form 10-K/A No. 2 restates the first quarter. Every affected figure in the note is checked against it.</span>
                </li>
              </ol>
            </div>

            <figure className="lp-panel lp-panel-tint lp-note-stage">
              <article className="lp-note" aria-label="Corrected research note">
                <p className="lp-note-meta">Draft correction. Figures verified, conclusion with the editor.</p>
                <h2 className="lp-note-title">Nocera Q1 2025: liquidity covers near-term obligations</h2>
                <p>
                  Nocera reported total current assets of <span className="lp-fixed">$670,496</span> at March 31, 2025. Total current liabilities were <span className="lp-fixed">$794,149</span> on the same date.
                </p>
                <p>
                  That leaves working capital of <span className="lp-fixed">−$123,653</span> and a current ratio of <span className="lp-fixed">0.84</span>.
                </p>
                <div className="lp-changes">
                  <p className="lp-changes-title">What changed in this version</p>
                  <ul>
                    {RESTATED_FIGURES.map((row) => (
                      <li key={row.claim}>
                        {row.claim} of <span className="lp-was">{row.original}</span> is now <span className="lp-now">{row.corrected}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </article>
              <figcaption className="lp-note-cite">
                Corrected from Form 10-K/A No. 2, accession 0001683168-26-006788, As Restated column. Working capital and the ratio are recomputed in code. Synthetic note. Every figure is from a
                public SEC filing.
              </figcaption>
            </figure>
          </div>
        </section>

        <section id="problem" className="lp-screen" aria-labelledby="problem-title">
          <div className="lp-container">
            <div className="lp-center">
              <h2 id="problem-title" className="lp-heading">
                A restatement updates the data. It does not update the note you sent in May.
              </h2>
              <p className="lp-lede">
                When an issuer says its earlier statements should no longer be relied upon, every note, model and newsletter built on them keeps circulating as if nothing happened. Most teams find them
                by memory and search. Errata works from a record of which figures each note relied on.
              </p>
            </div>
            <ol className="lp-timeline" aria-label="Nocera filing timeline">
              {TIMELINE.map((item) => (
                <li key={item.when} className={item.gap ? "lp-timeline-gap" : undefined}>
                  <span className="lp-timeline-when">{item.when}</span>
                  <span className="lp-timeline-what">{item.what}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="product" className="lp-screen" aria-labelledby="product-title">
          <div className="lp-container">
            <div className="lp-center">
              <h2 id="product-title" className="lp-heading">
                The correction desk
              </h2>
              <p className="lp-lede">Every affected claim, the figure it showed, the figure the amended filing supports, and who checked it.</p>
            </div>
            <div className="lp-panel lp-panel-quiet lp-desk-stage">
              <div className="lp-desk">
                <div className="lp-desk-head">
                  <div>
                    <p className="lp-desk-meta">Nocera, Inc. non-reliance, Form 8-K filed August 17, 2026, evidence revision 2</p>
                    <p className="lp-desk-title">A verified correction is ready for an editor</p>
                  </div>
                  <span className="lp-button lp-button-sm lp-desk-fake" aria-hidden="true">
                    Review correction
                  </span>
                </div>
                <table className="lp-table">
                  <caption className="visually-hidden">Affected claims in the Nocera note and their corrected values</caption>
                  <thead>
                    <tr>
                      <th scope="col">Claim</th>
                      <th scope="col" className="lp-r">
                        Original
                      </th>
                      <th scope="col" className="lp-r">
                        Corrected
                      </th>
                      <th scope="col">Evidence</th>
                      <th scope="col">Checked by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {RESTATED_FIGURES.map((row) => (
                      <tr key={row.claim}>
                        <th scope="row">{row.claim}</th>
                        <td className="lp-r lp-was" data-label="Original">
                          {row.original}
                        </td>
                        <td className="lp-r lp-now" data-label="Corrected">
                          {row.corrected}
                        </td>
                        <td data-label="Evidence">{row.evidence}</td>
                        <td data-label="Checked by">{row.checkedBy}</td>
                      </tr>
                    ))}
                    <tr>
                      <th scope="row">Liquidity conclusion</th>
                      <td className="lp-r lp-was" data-label="Original">
                        Original text
                      </td>
                      <td className="lp-r lp-now" data-label="Corrected">
                        Rewritten
                      </td>
                      <td data-label="Evidence">Publication Editor draft</td>
                      <td data-label="Checked by">Awaiting your approval</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <p className="lp-fineprint lp-center">The figures above come from the filings. In the demo, agents produce every proposal and check live.</p>
          </div>
        </section>

        <section className="lp-screen" aria-labelledby="capabilities-title">
          <div className="lp-container">
            <div className="lp-center">
              <h2 id="capabilities-title" className="lp-heading">
                What Errata keeps track of
              </h2>
              <p className="lp-lede">A correction is only as good as the record behind it. These are the facts Errata holds for every note and every change.</p>
            </div>
            <dl className="lp-capabilities">
              {CAPABILITIES.map((item) => (
                <div key={item.title}>
                  <dt>{item.title}</dt>
                  <dd>{item.body}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section id="how" className="lp-screen" aria-labelledby="how-title">
          <div className="lp-container">
            <div className="lp-center">
              <h2 id="how-title" className="lp-heading">
                How a correction runs
              </h2>
              <p className="lp-lede">Four agents work concurrently on a shared runtime. They react to each other’s results instead of following a fixed script.</p>
            </div>
            <ol className="lp-steps">
              {STEPS.map((step, index) => (
                <li key={step.title}>
                  <span className="lp-step-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <h3>{step.title}</h3>
                  <p className="lp-step-agents">{step.agents}</p>
                  <p>{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="lp-screen lp-final" aria-labelledby="final-title">
          <div className="lp-container">
            <div className="lp-final-panel lp-center">
              <h2 id="final-title" className="lp-heading">
                Watch the Nocera correction run on the real filings.
              </h2>
              <p className="lp-lede">
                The demo opens a private workspace with a synthetic note built on Nocera’s original Q1 2025 report. Release the 8-K, then the 10-K/A, and approve the correction yourself.
              </p>
              <div className="lp-actions">
                <Link className="lp-button lp-button-inverse" href="/demo">
                  Start the demo
                </Link>
                {SAMPLE ? (
                  <a className="lp-button lp-button-outline-inverse" href={SAMPLE}>
                    Read a corrected note
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-container lp-footer-grid">
          <div className="lp-footer-brand">
            <Wordmark />
            <p>Financial research correction desk.</p>
          </div>
          <p className="lp-footer-legal">
            Errata is an editorial correction tool that uses public SEC filings and synthetic research examples. It does not provide investment advice. It cannot revoke copies outside its managed links.
            Publishers, analysts and recipients in the demo are fictional.
          </p>
          <ul className="lp-footer-links">
            <li>
              <Link href="/demo">Demo</Link>
            </li>
            {REPO_URL ? (
              <li>
                <a href={REPO_URL}>Source code</a>
              </li>
            ) : null}
            <li>
              <a href="https://www.sec.gov/search-filings/edgar-application-programming-interfaces">SEC EDGAR data</a>
            </li>
          </ul>
        </div>
      </footer>
    </div>
  );
}
