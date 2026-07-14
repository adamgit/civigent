import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";

const DOCS_URL = "https://github.com/adamgit/civigent/tree/main/docs";

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} style={{ marginBottom: "2.25rem" }}>
      <h2
        style={{
          fontFamily: "var(--font-body)",
          fontSize: 20,
          fontWeight: 500,
          lineHeight: 1.3,
          margin: "0 0 0.85rem",
          paddingBottom: "0.45rem",
          borderBottom: "1px solid var(--color-footer-border)",
        }}
      >
        {title}
      </h2>
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.65,
          color: "var(--color-text-primary)",
          display: "flex",
          flexDirection: "column",
          gap: "0.85rem",
        }}
      >
        {children}
      </div>
    </section>
  );
}

function Subheading({ children }: { children: ReactNode }) {
  return (
    <h3
      style={{
        fontFamily: "var(--font-body)",
        fontSize: 16,
        fontWeight: 500,
        margin: "0.4rem 0 0",
        color: "var(--color-text-primary)",
      }}
    >
      {children}
    </h3>
  );
}

function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code
      style={{
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
        fontSize: "0.9em",
        padding: "0.1em 0.35em",
        borderRadius: 4,
        background: "var(--color-accent-light)",
        color: "var(--color-accent-text)",
      }}
    >
      {children}
    </code>
  );
}

function PromptExample({ children }: { children: string }) {
  return (
    <blockquote
      style={{
        margin: 0,
        padding: "0.9rem 1rem",
        borderLeft: "3px solid var(--color-accent-border)",
        background: "var(--color-accent-light)",
        borderRadius: "0 6px 6px 0",
        fontSize: 13.5,
        lineHeight: 1.6,
        color: "var(--color-text-primary)",
        fontStyle: "italic",
      }}
    >
      {children}
    </blockquote>
  );
}

export function HelpPage() {
  return (
    <>
      <SharedPageHeader title="Help & FAQ" backTo="/" />

      <div className="flex-1 overflow-auto canvas-scroll" style={{ fontFamily: "var(--font-ui)" }}>
        <div style={{ maxWidth: 740, margin: "0 auto", padding: "1.75rem 1.5rem 3rem" }}>
          <p style={{ fontSize: 14, color: "var(--color-text-secondary)", margin: "0 0 1.75rem" }}>
            How to create and edit documents, connect AI agents, and move data in and out of Civigent.
          </p>

          <nav
            aria-label="On this page"
            style={{
              marginBottom: "2rem",
              padding: "0.85rem 1rem",
              borderRadius: 6,
              border: "1px solid var(--color-footer-border)",
              background: "var(--color-accent-light)",
            }}
          >
            <p
              style={{
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--color-text-muted)",
                margin: "0 0 0.5rem",
              }}
            >
              On this page
            </p>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {[
                ["#basics", "Basic usage"],
                ["#standard", "Standard usage"],
                ["#working-with-agents", "Working with your AI agent"],
                ["#admin-docs", "Advanced & administrator docs"],
                ["#recipes", "Import & export"],
              ].map(([href, label]) => (
                <li key={href}>
                  <a
                    href={href}
                    style={{ fontSize: 13, color: "var(--color-accent)", textDecoration: "none" }}
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <Section id="basics" title="Basic usage">
            <Subheading>Creating documents</Subheading>
            <p style={{ margin: 0 }}>
              There are multiple ways to create a new document. Click the plus symbol in the sidebar.
              If you click it while a folder is selected, the new file is created inside that folder.
            </p>

            <Subheading>Editing with Markdown</Subheading>
            <p style={{ margin: 0 }}>
              Use Markdown syntax when editing. For a heading, type a hash, a space, then the heading
              text — it converts immediately into a heading. Use two hashes for a subheading, or three
              for a sub-subheading:
            </p>
            <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
              <li>
                <InlineCode># Heading</InlineCode>
              </li>
              <li>
                <InlineCode>## Subheading</InlineCode>
              </li>
              <li>
                <InlineCode>### Sub-subheading</InlineCode>
              </li>
            </ul>

            <Subheading>Quick navigation</Subheading>
            <p style={{ margin: 0 }}>
              The right-hand quick nav bar lets you jump around within a document. It also shows which
              sections are currently on screen, or being edited by other users or AI agents.
            </p>
            <p style={{ margin: 0 }}>
              Hovering over a section tells you whether it was last edited by a human or an AI, plus
              other small bits of info.
            </p>
          </Section>

          <Section id="standard" title="Standard usage">
            <p style={{ margin: 0 }}>
              Civigent is for editing documents collaboratively between humans and AIs. After you have
              checked that you can find a document, edit it, and write text as expected, the first
              thing to do is connect your own AI agent to the system.
            </p>
            <p style={{ margin: 0 }}>
              All AI agents are supported. The most common ones used are Claude Code, OpenAI Codex, and
              Grok / Cursor.
            </p>
            <p style={{ margin: 0 }}>
              Open the{" "}
              <Link to="/agents-activity" style={{ color: "var(--color-accent)", textDecoration: "none" }}>
                Agents
              </Link>{" "}
              link in the sidebar and click the button to add a new agent. Depending on how your admin
              has configured the system, agents may need no registration at all — meaning you can
              configure and use them with no authentication — through intermediate settings, up to
              requiring every agent to be pre-authenticated with a secret that is specific to you and
              to that agent. The setup page tells you which applies and walks you through adding your
              agent.
            </p>

            <Subheading>Server name</Subheading>
            <p style={{ margin: 0 }}>
              The server name is what you call Civigent when talking to your agent. If you want to call
              it something else — for instance <InlineCode>data-store</InlineCode> — set that as the
              server name. Instructions on the setup page update automatically so that when you copy
              and paste them, your local agent refers to this Civigent instance by that name.
            </p>
            <p style={{ margin: 0 }}>
              This is especially useful if you use multiple Civigent instances (for example a private
              local one and a shared team-wide one on a remote server). You can choose which name your
              AI agent uses for each one.
            </p>
            <p style={{ margin: 0 }}>
              Go to{" "}
              <Link to="/setup" style={{ color: "var(--color-accent)", textDecoration: "none" }}>
                Connect an Agent
              </Link>{" "}
              to configure a connection.
            </p>
          </Section>

          <Section id="working-with-agents" title="Working with your AI agent">
            <p style={{ margin: 0 }}>A typical prompt might be:</p>
            <PromptExample>
              Research the topic of &quot;purchasing a new laptop&quot;, creating new documents in
              Civigent in a folder &apos;research/new-laptop&apos;. Do a competitive analysis of
              different laptops from different brands, searching the web; do a detailed pros and cons
              and summarize reviews you found, creating one file for each major laptop, appropriate
              summary files, and an overall index — along with a document that gives the best
              recommendation of which one I should purchase.
            </PromptExample>
            <p style={{ margin: 0 }}>
              When you run this inside Cursor, Claude Code, Claude Cowork, or OpenAI Codex — if the
              agent is configured correctly — it will research the topic, create folders inside
              Civigent, create the files, and fill them in. You can watch files appear live in the
              sidebar tree view, open them, and see them being written as the agent works.
            </p>
            <p style={{ margin: 0 }}>
              You can edit documents while the agent is working or after it finishes — individual
              sections or whole documents. Then tell the agent to refer to them in your ongoing
              conversation so it adopts the changes you made.
            </p>
          </Section>

          <Section id="admin-docs" title="Advanced & administrator documentation">
            <p style={{ margin: 0 }}>
              The GitHub repository for Civigent has a{" "}
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--color-accent)", textDecoration: "none" }}
              >
                docs
              </a>{" "}
              subfolder with detailed documentation on setup, configuration, and usage aimed at
              admins, developers, and power users.
            </p>
          </Section>

          <Section id="recipes" title="Import & export">
            <Subheading>Import</Subheading>
            <p style={{ margin: 0 }}>
              You can import any Markdown document, set of documents, or folder of Markdown documents
              and subfolders — structure is preserved. The app currently only supports Markdown; other
              files are rejected on import, because details of the Markdown format power several core
              Civigent features.
            </p>
            <p style={{ margin: 0 }}>
              To start an import, choose a folder in the folder tree sidebar and click the up arrow
              next to it to import files into that folder.
            </p>

            <Subheading>Export</Subheading>
            <p style={{ margin: 0 }}>There are three main ways to export data:</p>
            <ol style={{ margin: 0, paddingLeft: "1.25rem" }}>
              <li style={{ marginBottom: "0.55rem" }}>
                Export any folder as a zip of Markdown documents by hovering over the folder in the
                left-hand document tree and clicking the down arrow.
              </li>
              <li style={{ marginBottom: "0.55rem" }}>
                If your admin enables snapshots, a <InlineCode>snapshots</InlineCode> folder on the
                machine serving Civigent is continuously updated with pure Markdown versions of all
                files and folders. You can copy those out and import them into other software.
              </li>
              <li>
                An admin feature lets you export the entire repository — including versions, previous
                edits, and the audit log — to a remote Git server.
              </li>
            </ol>
          </Section>
        </div>
      </div>
    </>
  );
}
