import { describe, expect, it } from 'vitest';
import { activityIdFromKey, postUrnFromKey } from '../src/lib/adapters/activity-id.ts';

describe('post id from the card key', () => {
  it('decodes the activity id (matches urn:li:comment:(activity:…) on the page)', () => {
    expect(activityIdFromKey('CgsIgMCy4Mbr78fQAQ-replaceableCommentTools')).toBe(
      '7514220442614648832',
    );
    expect(activityIdFromKey('CgsIgoC+nNvD+cbQAQ')).toBe('7513960273423089665');
  });
  it('decodes ugcPost ids too (EgsI keys)', () => {
    expect(postUrnFromKey('EgsIhoCyjL6a4MbQAQ')).toBe('urn:li:ugcPost:7513904589557874691');
  });
  it('ignores anything that does not decode to a plausible post time', () => {
    expect(activityIdFromKey('CgsIAQ')).toBeNull();
    expect(activityIdFromKey('update-card-focus-123')).toBeNull();
    // a time before 2015 is rejected
    expect(activityIdFromKey('CgsIgMCy4Mbr78fQAQ', Date.UTC(2014, 0, 1))).toBeNull();
  });
});
