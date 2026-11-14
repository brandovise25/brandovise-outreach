import { describe, expect, it } from 'vitest';
import { REPLY_CLASSES, REPLY_HANDLING, replyPattern } from '../src/replies.ts';

describe('replyPattern', () => {
  it('recognises a request not to be contacted again', () => {
    for (const t of [
      'Bitte keine weiteren Nachrichten.',
      'Schreiben Sie mich bitte nicht mehr an',
      'Bitte nicht mehr anschreiben, danke.',
      'Sehen Sie bitte von weiteren Kontaktaufnahmen ab.',
      'Bitte von Ihrer Liste streichen',
      'Lassen Sie mich in Ruhe!',
      "Please don't contact me again",
      'stop messaging me',
    ])
      expect(replyPattern(t)?.kind, t).toBe('opt_out');
  });
  it('sends legal wording to Jibran, before anything else', () => {
    for (const t of [
      'Das geht an meinen Anwalt.',
      'Woher haben Sie meine Daten? DSGVO!',
      'Bitte keine weiteren Nachrichten, sonst folgt eine Abmahnung.',
      'Das ist ein Verstoß gegen das UWG',
    ])
      expect(replyPattern(t)?.kind, t).toBe('escalate');
  });
  it('leaves ordinary answers to the classifier', () => {
    for (const t of [
      'Danke, aktuell kein Bedarf.',
      'Kein Interesse, danke.',
      'Gerne nach dem Jahreswechsel noch einmal.',
      'Was kostet das denn?',
      'Wir haben schon einen Chatbot, schreiben Sie mir gern in einem halben Jahr.',
    ])
      expect(replyPattern(t), t).toBeNull();
  });
  it('never drafts an answer to a no', () => {
    expect(REPLY_HANDLING.not_interested.draft).toBe(false);
    expect(REPLY_HANDLING.wrong_person.draft).toBe(false);
    expect(Object.keys(REPLY_HANDLING).sort()).toEqual([...REPLY_CLASSES].sort());
  });
});
