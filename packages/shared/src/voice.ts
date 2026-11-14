import { z } from 'zod';
import { quoteAppears } from './text.ts';
import { usesDuForm } from './validators.ts';

// Jibran's voice profile: samples of his own writing read from LinkedIn, a fingerprint measured in
// code, and the AI's description (quotes verified here). The fingerprint idea follows
// sergebulaev/linkedin-skills (MIT), references/voice-fingerprint.md.

export const VoiceSamples = z.object({
  profile: z.object({
    name: z.string().max(200),
    headline: z.string().max(400).nullable(),
    about: z.string().max(4000).nullable(),
    url: z.string().max(300).nullable().optional(),
    location: z.string().max(200).nullable().optional(),
    followers: z.string().max(60).nullable().optional(),
    connections: z.string().max(60).nullable().optional(),
    experience: z
      .array(
        z.object({
          title: z.string().max(300),
          company: z.string().max(300).nullable(),
          dates: z.string().max(120).nullable(),
          description: z.string().max(1500).nullable().optional(),
        }),
      )
      .max(20),
  }),
  posts: z
    .array(z.object({ text: z.string().max(5000), date: z.string().max(40).nullable() }))
    .max(40),
  comments: z
    .array(
      z.object({
        text: z.string().max(3000),
        on: z.string().max(400).nullable(),
        date: z.string().max(40).nullable(),
      }),
    )
    .max(60),
});
export type VoiceSamples = z.infer<typeof VoiceSamples>;

export interface VoiceFingerprint {
  samples: { posts: number; comments: number; words: number };
  language: { german: number; english: number }; // share of samples
  address: { sie: number; du: number }; // samples using each form
  sentenceWords: { median: number; p90: number };
  postChars: { median: number } | null;
  commentChars: { median: number } | null;
  perSample: {
    emoji: number;
    emDash: number;
    question: number;
    hashtags: number;
    lineBreaks: number;
  };
  topWords: string[];
}

const GERMAN = /\b(und|der|die|das|nicht|ist|mit|für|ich|wir|sie|auf|bei|ein|eine|auch|wie)\b/gi;
const ENGLISH = /\b(and|the|is|not|with|for|we|you|this|that|on|at|a|an|also|how)\b/gi;
const STOP = new Set(
  'und der die das den dem des ein eine einen einem nicht ist sind mit für ich wir sie es auf bei auch wie oder aber als zu von im in an am so dass wenn noch nur mehr man was the and is are to of a an in on for with that this it we you i be as at or not but by from have has'.split(
    ' ',
  ),
);

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};

export function voiceFingerprint(s: VoiceSamples): VoiceFingerprint {
  const texts = [...s.posts.map((p) => p.text), ...s.comments.map((c) => c.text)].filter((t) =>
    t.trim(),
  );
  const n = Math.max(texts.length, 1);
  const sentences = texts.flatMap((t) => t.split(/(?<=[.!?])\s+|\n+/)).filter((x) => x.trim());
  const words =
    texts
      .join(' ')
      .toLowerCase()
      .match(/\p{L}[\p{L}'-]{2,}/gu) ?? [];
  const freq = new Map<string, number>();
  for (const w of words) if (!STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const share = (re: RegExp) =>
    texts.filter((t) => {
      const g = (t.match(GERMAN) ?? []).length;
      const e = (t.match(ENGLISH) ?? []).length;
      return re === GERMAN ? g > e : e >= g;
    }).length / n;
  const per = (re: RegExp) =>
    +(texts.reduce((a, t) => a + (t.match(re) ?? []).length, 0) / n).toFixed(2);
  return {
    samples: { posts: s.posts.length, comments: s.comments.length, words: words.length },
    language: { german: +share(GERMAN).toFixed(2), english: +share(ENGLISH).toFixed(2) },
    address: {
      sie: texts.filter((t) => /\b(Sie|Ihnen|Ihr(e[nmrs]?)?)\b/.test(t)).length,
      du: texts.filter((t) => usesDuForm(t)).length,
    },
    sentenceWords: {
      median: median(sentences.map((x) => x.split(/\s+/).length)),
      p90: pct(
        sentences.map((x) => x.split(/\s+/).length),
        0.9,
      ),
    },
    postChars: s.posts.length ? { median: median(s.posts.map((p) => [...p.text].length)) } : null,
    commentChars: s.comments.length
      ? { median: median(s.comments.map((c) => [...c.text].length)) }
      : null,
    perSample: {
      emoji: per(/\p{Extended_Pictographic}/gu),
      emDash: per(/—/g),
      question: per(/\?/g),
      hashtags: per(/(^|\s)#\p{L}/gu),
      lineBreaks: per(/\n/g),
    },
    topWords: [...freq.entries()]
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([w]) => w),
  };
}

export const VoiceProfile = z.object({
  summary: z.string().max(1500),
  languages: z.string().max(400),
  address_form: z.string().max(400),
  tone: z.string().max(800),
  rhythm: z.string().max(800),
  openers: z.array(z.string().max(300)).max(10),
  closers: z.array(z.string().max(300)).max(10),
  phrases: z.array(z.string().max(200)).max(20),
  avoids: z.array(z.string().max(300)).max(15),
  topics: z.array(z.string().max(200)).max(12),
  signature_lines: z.array(z.string().max(500)).max(8),
  story_bank: z.array(z.object({ fact: z.string().max(400), quote: z.string().max(500) })).max(15),
  comment_style: z.string().max(800),
  coverage_note: z.string().max(400),
  better: z.object({
    keep: z.array(z.string().max(300)).max(10),
    drop: z.array(z.string().max(300)).max(10),
    rules: z.array(z.string().max(300)).max(12),
    rewrite_example: z.object({ before: z.string().max(1500), after: z.string().max(1500) }),
    headline_options: z.array(z.string().max(220)).max(3),
    about_opening: z.string().max(1200),
  }),
});
export type VoiceProfile = z.infer<typeof VoiceProfile>;

// Quotes must be copied from his samples; anything else is dropped (and counted).
export function verifyVoice(
  p: VoiceProfile,
  s: VoiceSamples,
): { profile: VoiceProfile; dropped: number } {
  const corpus = [
    s.profile.headline ?? '',
    s.profile.about ?? '',
    ...s.posts.map((x) => x.text),
    ...s.comments.map((x) => x.text),
  ].join('\n');
  let dropped = 0;
  const keep = <T>(xs: T[], q: (x: T) => string) =>
    xs.filter((x) => (quoteAppears(q(x), corpus) ? true : (dropped++, false)));
  const profile: VoiceProfile = {
    ...p,
    signature_lines: keep(p.signature_lines, (x) => x),
    phrases: keep(p.phrases, (x) => x),
    story_bank: keep(p.story_bank, (x) => x.quote),
    better: {
      ...p.better,
      rewrite_example: quoteAppears(p.better.rewrite_example.before, corpus)
        ? p.better.rewrite_example
        : (dropped++, { before: '', after: '' }),
    },
  };
  return { profile, dropped };
}

// Compact text for drafting prompts (comments, invite notes, messages).
export function voiceForPrompt(p: VoiceProfile | null, f?: VoiceFingerprint | null): string {
  if (!p) return '(no approved voice profile yet)';
  const lines = [
    `Summary: ${p.summary}`,
    `Language: ${p.languages}. Address: ${p.address_form}.`,
    `Tone: ${p.tone}`,
    `Rhythm: ${p.rhythm}`,
    p.phrases.length ? `Phrases he uses: ${p.phrases.join(' | ')}` : '',
    p.avoids.length ? `He avoids: ${p.avoids.join('; ')}` : '',
    `Comment style: ${p.comment_style}`,
    p.signature_lines.length
      ? `Lines in his voice: ${p.signature_lines.map((l) => `"${l}"`).join(' / ')}`
      : '',
    p.story_bank.length
      ? `Facts he has stated publicly (only these may be used): ${p.story_bank.map((x) => x.fact).join('; ')}`
      : '',
    p.better.rules.length ? `Sharper-voice rules: ${p.better.rules.join('; ')}` : '',
    f?.commentChars ? `His comments are typically about ${f.commentChars.median} characters.` : '',
  ];
  return lines.filter(Boolean).join('\n');
}
