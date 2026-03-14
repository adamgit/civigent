export const sampleDocTree = [
  {
    name: "ops",
    path: "ops",
    type: "directory" as const,
    children: [
      { name: "strategy.md", path: "ops/strategy.md", type: "file" as const, children: [] },
    ],
  },
  {
    name: "eng",
    path: "eng",
    type: "directory" as const,
    children: [
      { name: "architecture.md", path: "eng/architecture.md", type: "file" as const, children: [] },
    ],
  },
];

export const sampleProposal = {
  id: "proposal-1",
  writer: { id: "agent-1", type: "agent" as const, displayName: "Test Agent" },
  intent: "Update strategy section",
  status: "committed" as const,
  sections: [
    {
      doc_path: "ops/strategy.md",
      heading_path: ["Overview"],
      content: "Updated content\n",
    },
  ],
  created_at: "2026-01-01T00:00:00.000Z",
};

export const sampleActivity = [
  {
    sha: "abc123",
    message: "update section Overview in ops/strategy.md",
    author: "Test Agent",
    timestamp: "2026-01-01T00:00:00.000Z",
    doc_path: "ops/strategy.md",
  },
];

export const sampleHeatmapEntry = {
  doc_path: "ops/strategy.md",
  heading_path: ["Overview"],
  humanInvolvement_score: 0.3,
  crdt_session_active: false,
  last_human_commit_sha: null,
  block_reason: null,
};

export const sampleSections = [
  {
    heading_path: [] as string[],
    content: "Document preamble.\n",
    humanInvolvement_score: 0,
    crdt_session_active: false,
    section_length_warning: false,
    word_count: 2,
  },
  {
    heading_path: ["Overview"],
    content: "The overview.\n",
    humanInvolvement_score: 0,
    crdt_session_active: false,
    section_length_warning: false,
    word_count: 2,
  },
];
