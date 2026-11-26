import Link from "next/link";
import { Wordmark } from "@/components/app-shell";

const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL;
const SAMPLE = process.env.NEXT_PUBLIC_SAMPLE_REPORT_PATH;

function Proof({ from, to }: { from: string; to: string }) {
  return (
    <span className="proof">
      <span className="proof-old">{from}</span>
      <span className="proof-caret" aria-hidden="true">
        ‸
      </span>
      <span className="proof-new">{to}</span>
      <span className="visually-hidden">
        , corrected from {from} to {to}
      </span>
    </span>
  );
}

export default function LandingPage() {
  return (
    <div className="landing">
      <header className="site-nav">
        <Wordmark />
        <nav aria-label="Site">
          <ul className="site-links">
            <li>
              <a href="#problem">Problem</a>
            </li>
            <li>
              <a href="#product">Product</a>
            </li>
            <li>
              <a href="#how">How it works</a>
            </li>
            {REPO_URL ? (
              <li>
                <a href={REPO_URL}>Source</a>
              </li>
            ) : null}
          </ul>
        </nav>
        <Link className="btn btn-primary" href="/demo">
          Start the demo
        </Link>
      </header>

      <main id="main">
        <section className="hero">
          <div className="hero-copy">
            <h1>When financial facts change, fix every report that depended on them.</h1>
            <p className="lede">Errata reads SEC filings for non-reliance notices and restatements, finds the published research that cites the affected figures, warns readers straight away, and prepares a corrected version that an editor approves.</p>
            <div className="row">
              <Link className="btn btn-primary btn-lg" href="/demo">
                Run the Nocera correction
              </Link>
              {SAMPLE ? (
                <a className="btn btn-lg" href={SAMPLE}>
                  Read a corrected note
                </a>
              ) : null}
            </div>
            <p className="small muted">Uses public SEC filings and a synthetic research note. No sign-up. Not financial advice.</p>
          </div>

          <figure className="erratum" aria-label="Example correction to a research note">
            <div className="erratum-flag">
              <strong>Figures in this note rely on statements the issuer says should no longer be relied upon</strong>
              <span>Nocera, Inc. Form 8-K, Item 4.02, filed August 17, 2026</span>
            </div>
            <div className="erratum-body">
              <p className="erratum-title">Nocera Q1 2025: liquidity covers near-term obligations</p>
              <p>
                Nocera reported total current assets of <Proof from="$1,275,416" to="$670,496" /> at March 31, 2025. Total current liabilities were <Proof from="$706,384" to="$794,149" /> on the same date.
              </p>
              <p>
                That leaves working capital of <Proof from="$569,032" to="-$123,653" /> and a current ratio of <Proof from="1.81" to="0.84" />.
              </p>
            </div>
            <figcaption className="erratum-cite">
              <span>Corrected from Form 10-K/A No. 2, accession 0001683168-26-006788, As Restated column. Working capital and the ratio are recomputed in code.</span>
              <span className="faint">Synthetic note. Every figure is from a public SEC filing.</span>
            </figcaption>
          </figure>
        </section>

        <section id="problem" className="band">
          <div className="band-inner two-col">
            <div className="stack">
              <h2>A restatement updates the data. It does not update the note you sent in May.</h2>
              <p>When an issuer says its earlier statements should no longer be relied upon, every note, model and newsletter built on those statements keeps circulating as if nothing happened. Someone has to find them, warn readers, wait for corrected figures, redo the arithmetic, rewrite the conclusions and tell everyone who received the original.</p>
              <p>Most teams do this by memory and search. Errata does it from a record of which figures each note relied on.</p>
            </div>
            <ol className="filing-timeline" aria-label="Nocera filing timeline">
              <li>
                <span className="ft-date">May 15, 2025</span>
                <span className="ft-what">Q1 10-Q reports current assets of $1,275,416 and current liabilities of $706,384</span>
              </li>
              <li>
                <span className="ft-date">May 20, 2025</span>
                <span className="ft-what">A research note publishes those figures and calls liquidity comfortable</span>
              </li>
              <li className="ft-bad">
                <span className="ft-date">Aug 17, 2026</span>
                <span className="ft-what">8-K Item 4.02: Q1 to Q3 2025 and both fiscal years should no longer be relied upon</span>
              </li>
              <li className="ft-gap">
                <span className="ft-date">Eleven days</span>
                <span className="ft-what">Readers need a warning, but no corrected figures exist yet</span>
              </li>
              <li className="ft-ok">
                <span className="ft-date">Aug 28, 2026</span>
                <span className="ft-what">10-K/A No. 2 restates Q1: current assets $670,496, current liabilities $794,149</span>
              </li>
            </ol>
          </div>
        </section>

        <section id="product" className="band band-plain">
          <div className="band-inner stack">
            <h2>The correction desk</h2>
            <p className="band-lede">Every affected claim, the figure it showed, the figure the amended filing supports, and who checked it.</p>
            <div className="desk-preview" role="img" aria-label="Correction desk showing four affected figures in the Nocera note">
              <div className="desk-preview-head">
                <div className="stack-sm">
                  <span className="small muted">Nocera, Inc. non-reliance (8-K, filed 2026-08-17), evidence revision 2</span>
                  <strong className="serif" style={{ fontSize: 21 }}>
                    A verified correction is ready for an editor
                  </strong>
                </div>
                <span className="btn btn-primary" aria-hidden="true">
                  Review correction
                </span>
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Claim</th>
                    <th className="r">Original</th>
                    <th className="r">Corrected</th>
                    <th>Evidence</th>
                    <th>Checked by</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Total current assets</td>
                    <td className="r num proof-old">$1,275,416</td>
                    <td className="r num">
                      <strong className="proof-new" style={{ marginLeft: 0 }}>
                        $670,496
                      </strong>
                    </td>
                    <td className="small">10-K/A, as restated</td>
                    <td className="small">Financial Verifier, read independently</td>
                  </tr>
                  <tr>
                    <td>Total current liabilities</td>
                    <td className="r num proof-old">$706,384</td>
                    <td className="r num">
                      <strong className="proof-new" style={{ marginLeft: 0 }}>
                        $794,149
                      </strong>
                    </td>
                    <td className="small">10-K/A, as restated</td>
                    <td className="small">Financial Verifier, read independently</td>
                  </tr>
                  <tr>
                    <td>Working capital</td>
                    <td className="r num proof-old">$569,032</td>
                    <td className="r num">
                      <strong className="proof-new" style={{ marginLeft: 0 }}>
                        -$123,653
                      </strong>
                    </td>
                    <td className="small">Recomputed in code</td>
                    <td className="small">Financial Verifier, recomputed</td>
                  </tr>
                  <tr>
                    <td>Liquidity conclusion</td>
                    <td className="r muted">Text</td>
                    <td className="r muted">Rewritten</td>
                    <td className="small">Publication Editor draft</td>
                    <td className="small">Awaiting your approval</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="small muted">The figures above come from the filings. In the demo, agents produce every proposal and check live.</p>
          </div>
        </section>

        <section className="band">
          <div className="band-inner">
            <h2>What Errata keeps track of</h2>
            <dl className="capabilities">
              <div>
                <dt>Which figures each note relies on</dt>
                <dd>Every number in a note is tied to an exact filing row, a calculation over other figures, or marked as plain text. Conclusions record the figures they depend on.</dd>
              </div>
              <div>
                <dt>What was public, and when</dt>
                <dd>Filings carry their SEC acceptance time. In a historical replay, agents only see a filing after the replay clock reaches it, so nothing is corrected with evidence from the future.</dd>
              </div>
              <div>
                <dt>Who proposed a figure and who checked it</dt>
                <dd>One agent proposes, a different agent reads the filing itself, and code re-reads the cited table cell from the stored bytes. Nobody verifies their own work.</dd>
              </div>
              <div>
                <dt>Exactly what an editor approved</dt>
                <dd>Approval binds one draft and one evidence revision. New evidence expires it. Reissuing is a separate step that rechecks everything in one transaction.</dd>
              </div>
              <div>
                <dt>Every version a reader ever saw</dt>
                <dd>Published text never changes. Old versions stay readable with their warning and a link to the current one, and the correction notice explains what moved and why.</dd>
              </div>
              <div>
                <dt>What the agents actually did</dt>
                <dd>Each agent loop, tool call, challenge and rejected stale result is recorded, with a link to the live session in Mozaik Cloud.</dd>
              </div>
            </dl>
          </div>
        </section>

        <section id="how" className="band band-plain">
          <div className="band-inner">
            <h2>How a correction runs</h2>
            <p className="band-lede">Four agents work concurrently on a shared runtime. They react to each other&apos;s results instead of following a fixed script.</p>
            <ol className="steps">
              <li>
                <h3>A non-reliance notice arrives</h3>
                <p>The Filing Monitor reads Item 4.02 and proposes which periods are affected, citing the paragraphs that say so.</p>
              </li>
              <li>
                <h3>The scope is checked and readers are warned</h3>
                <p>The Financial Verifier reads the same notice on its own. Once it agrees, every note citing those periods is flagged on its public page, before corrected figures exist.</p>
              </li>
              <li>
                <h3>The amendment is read twice</h3>
                <p>The Impact Analyst proposes restated figures from the amended filing. The verifier finds each one independently and rejects anything with the wrong period, column or scale. Derived figures are recomputed in code.</p>
              </li>
              <li>
                <h3>An editor approves the exact correction</h3>
                <p>The Publication Editor rewrites the affected passages and the notice. A person approves it and reissues; the old version stays on record and recipients get the notice in a simulated inbox.</p>
              </li>
            </ol>
          </div>
        </section>

        <section className="band band-cta">
          <div className="band-inner cta">
            <h2>Watch the Nocera correction run on the real filings.</h2>
            <p>The demo opens a private workspace with a synthetic note built on Nocera&apos;s original Q1 2025 report. Release the 8-K, then the 10-K/A, and approve the correction yourself.</p>
            <Link className="btn btn-primary btn-lg" href="/demo">
              Start the demo
            </Link>
          </div>
        </section>
      </main>

      <footer className="site-foot">
        <div className="band-inner foot-grid">
          <div className="stack-sm">
            <Wordmark />
            <p className="small muted">Financial research correction desk.</p>
          </div>
          <p className="small muted">Errata is an editorial correction tool that uses public SEC filings and synthetic research examples. It does not provide investment advice. It cannot revoke copies outside its managed links. Publishers, analysts and recipients in the demo are fictional.</p>
          <ul className="plain-list small">
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
