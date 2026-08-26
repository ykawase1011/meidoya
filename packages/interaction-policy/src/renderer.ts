import type {
  MessageTone,
  RenderedMessage,
  RenderedMessageSection,
} from "@meidoya/chat-core";

export type MessageTemplateKind =
  | "question"
  | "plan"
  | "review"
  | "approval"
  | "attention"
  | "reply"
  | "result"
  | "failure"
  | "schedule";

/**
 * Structured input for rendering. Only whitelisted, already-structured fields
 * reach here; raw LLM output and raw logs have no field to travel in.
 */
export type RenderInput = {
  kind: MessageTemplateKind;
  title?: string;
  summary?: string;
  bullets?: readonly string[];
  sections?: ReadonlyArray<{ title: string; bullets: readonly string[] }>;
  choices?: readonly string[];
  links?: ReadonlyArray<{ label: string; url: string }>;
};

export type RendererOptions = {
  /** Per-platform character limit for one message. */
  maxChars: number;
};

const REDACTED = "[redacted]";
const PATH_PLACEHOLDER = "[path]";
const ID_PLACEHOLDER = "[id]";

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:sk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  /\b(?:password|passwd|secret|api[_-]?key|token|authorization)\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

// Absolute POSIX paths (incl. ~/...) and Windows drive paths.
const PATH_PATTERNS: ReadonlyArray<RegExp> = [
  // Lookbehind keeps URLs (".../a/b") and mid-word slashes out of the match.
  /(?<![A-Za-z0-9:_@.\-/])~?\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g,
  /\b[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s\\]+/g,
];

// Internal control-plane identifiers and bare UUIDs.
const INTERNAL_ID_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:task|cp|ws|env|conv|run|step|art|sched|node|evt|proj)_[A-Za-z0-9]{2,}/g,
  /\b(?:task|cp|ws|env|conv|run|step|art|sched|node|evt|proj)-[A-Za-z0-9][A-Za-z0-9-]{11,}\b/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
];

export function scrub(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  for (const re of PATH_PATTERNS) out = out.replace(re, PATH_PLACEHOLDER);
  for (const re of INTERNAL_ID_PATTERNS) out = out.replace(re, ID_PLACEHOLDER);
  return out;
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const ellipsis = "…";
  const head = Math.max(0, maxChars - ellipsis.length);
  return `${text.slice(0, head)}${ellipsis}`;
}

const HEADINGS: Readonly<Record<MessageTemplateKind, string>> = {
  question: "確認事項",
  plan: "計画の確認",
  review: "レビューの確認",
  approval: "承認が必要です",
  attention: "対応が必要です",
  reply: "Meidoya",
  result: "完了",
  failure: "失敗",
  schedule: "定期実行",
};

const ICONS: Readonly<Record<MessageTemplateKind, string>> = {
  question: "❓",
  plan: "📝",
  review: "🔎",
  approval: "⛔",
  attention: "⚠️",
  reply: "",
  result: "✅",
  failure: "❌",
  schedule: "🗓️",
};

const TONES: Readonly<Record<MessageTemplateKind, MessageTone>> = {
  question: "info",
  plan: "info",
  review: "info",
  approval: "warning",
  attention: "warning",
  reply: "info",
  result: "success",
  failure: "danger",
  schedule: "info",
};

function cleanList(items: readonly string[] | undefined): readonly string[] | undefined {
  if (items === undefined) return undefined;
  const cleaned = items.map(scrub).filter((item) => item.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

function cleanSections(
  sections: RenderInput["sections"],
): readonly RenderedMessageSection[] | undefined {
  if (sections === undefined) return undefined;
  const cleaned = sections.flatMap((section) => {
    const title = scrub(section.title);
    const bullets = cleanList(section.bullets);
    return title.length === 0 || bullets === undefined ? [] : [{ title, bullets }];
  });
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Applies the template, scrubs, then truncates. Never posts raw output. */
export function render(input: RenderInput, options: RendererOptions): RenderedMessage {
  const title =
    input.kind === "reply" && input.title === undefined
      ? undefined
      : scrub(input.title ?? HEADINGS[input.kind]);
  const summary = input.summary === undefined ? undefined : scrub(input.summary);
  const bullets = cleanList(input.bullets);
  const sections = cleanSections(input.sections);
  const choices = cleanList(input.choices);
  const lines: string[] = [];
  if (title !== undefined) lines.push(`${ICONS[input.kind]} ${title}`.trim());
  if (summary !== undefined) lines.push("", summary);
  if (bullets !== undefined) {
    lines.push("");
    for (const bullet of bullets) lines.push(`- ${bullet}`);
  }
  for (const section of sections ?? []) {
    lines.push("", section.title);
    for (const bullet of section.bullets) lines.push(`- ${bullet}`);
  }
  if (choices !== undefined) {
    lines.push("");
    for (const choice of choices) lines.push(`[${choice}]`);
  }

  const text = truncate(lines.join("\n").trimStart(), options.maxChars);
  const links = (input.links ?? []).map((l) => ({
    label: scrub(l.label),
    url: l.url,
  }));
  return {
    text,
    ...(title === undefined ? {} : { title }),
    tone: TONES[input.kind],
    ...(summary === undefined ? {} : { summary }),
    ...(bullets === undefined ? {} : { bullets }),
    ...(sections === undefined ? {} : { sections }),
    ...(choices === undefined ? {} : { choices }),
    ...(links.length === 0 ? {} : { links }),
  };
}
