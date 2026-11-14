import { redactDocument, stripScripts } from '../lib/redact.ts';
import { pageKind } from '../lib/page-kind.ts';
import { pageShowsLoggedOut } from '../lib/linkedin-login.ts';
import { readPosts } from '../lib/adapters/posts.ts';
import { scrollFeed } from '../lib/adapters/scroll.ts';
import { commentOnPost } from '../lib/adapters/comment.ts';
import { expandSeeMore } from '../lib/adapters/expand.ts';
import { scrollStep } from '../lib/adapters/scroller.ts';
import { readExperienceDetails, readProfileTop } from '../lib/adapters/profile.ts';
import { pageOwner, readOwnComments } from '../lib/adapters/own-comments.ts';
import { readConnections, readInbox, readSentInvitations } from '../lib/adapters/sync.ts';
import { readSearchResults } from '../lib/adapters/search.ts';
import { loadMoreComments, readPostComments } from '../lib/adapters/post-comments.ts';
import {
  connectWithNote,
  inspectProfile,
  sendMessage,
  takeSnapshot,
  withdrawInvite,
} from '../lib/adapters/send.ts';

// Runs on LinkedIn pages. The app only ever works in its OWN robot tab (comment round,
// posting, sync captures); it never acts in a tab Jibran opened. Reading: capture, posts. Actions,
// each started by Jibran: paced feed scrolling, typing and (live mode) posting one approved comment.
// It never likes, opens a profile or navigates on its own.

export default defineContentScript({
  matches: ['https://www.linkedin.com/*'],
  runAt: 'document_idle',
  main() {
    // Tells the background whether LinkedIn is logged in (grey icon and paused robot when not).
    void browser.runtime
      .sendMessage({
        type: 'linkedinLogin',
        loggedIn: !pageShowsLoggedOut(location.pathname, document),
      })
      .catch(() => {});
    let scrolling: { stopped: boolean; reason?: string } | null = null;
    browser.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
      if (sender.id !== browser.runtime.id) return false;
      const m = msg as { type?: string; raw?: boolean };
      try {
        if (m?.type === 'capture') {
          sendResponse({
            ok: true,
            kind: pageKind(location.pathname),
            lang: (document.documentElement.lang || 'unknown').slice(0, 2),
            html: m.raw ? stripScripts(document) : redactDocument(document),
          });
        } else if (m?.type === 'gentleScroll') {
          scrollStep(300 + Math.round(Math.random() * 200));
          sendResponse({ ok: true });
        } else if (m?.type === 'takeSnapshot') {
          sendResponse({
            ok: true,
            html: takeSnapshot(),
            lang: (document.documentElement.lang || 'en').slice(0, 2),
          });
        } else if (m?.type === 'inspectProfile') {
          sendResponse({ ok: true, ...inspectProfile() });
        } else if (m?.type === 'sendConnect') {
          const c = msg as { note: string; practice: boolean; snapshot?: boolean };
          void connectWithNote(c.note, c.practice !== false, c.snapshot === true).then(
            sendResponse,
          );
          return true;
        } else if (m?.type === 'sendMessage') {
          const c = msg as { body: string; practice: boolean; snapshot?: boolean };
          void sendMessage(c.body, c.practice !== false, c.snapshot === true).then(sendResponse);
          return true;
        } else if (m?.type === 'sendWithdraw') {
          const c = msg as { name: string; practice: boolean };
          void withdrawInvite(c.name, c.practice !== false).then(sendResponse);
          return true;
        } else if (m?.type === 'readSearch') {
          sendResponse({ ok: true, ...readSearchResults(document) });
        } else if (m?.type === 'readConnections') {
          sendResponse({ ok: true, ...readConnections(document) });
        } else if (m?.type === 'readSent') {
          sendResponse({ ok: true, ...readSentInvitations(document) });
        } else if (m?.type === 'readInbox') {
          sendResponse({ ok: true, items: readInbox(document) });
        } else if (m?.type === 'readProfile') {
          sendResponse({ ok: true, path: location.pathname, top: readProfileTop(document) });
        } else if (m?.type === 'readExperience') {
          sendResponse({ ok: true, items: readExperienceDetails(document) });
        } else if (m?.type === 'readOwnComments') {
          const owner = (msg as { owner?: string }).owner ?? pageOwner(document);
          sendResponse({ ok: true, owner, comments: readOwnComments(document, owner) });
        } else if (m?.type === 'readPostComments') {
          const post = readPosts(document)[0] ?? null;
          sendResponse({
            ok: true,
            post: post && { author: post.author, excerpt: [...post.text].slice(0, 1500).join('') },
            comments: readPostComments(document),
          });
        } else if (m?.type === 'loadMoreComments') {
          sendResponse({ ok: true, clicked: loadMoreComments(document) });
        } else if (m?.type === 'expandSeeMore') {
          void expandSeeMore(document).then((opened) => sendResponse({ ok: true, opened }));
          return true;
        } else if (m?.type === 'ping') {
          // Whether the page has content yet, and whether Chrome treats it as hidden (background tab).
          sendResponse({
            ok: true,
            path: location.pathname,
            visible: document.visibilityState,
            nodes: (document.querySelector('main') ?? document.body).getElementsByTagName('*')
              .length,
          });
        } else if (m?.type === 'readPosts') {
          sendResponse({ ok: true, posts: readPosts(document) });
        } else if (m?.type === 'scrollFeed') {
          if (scrolling) {
            sendResponse({ ok: false, error: 'already scrolling' });
            return false;
          }
          scrolling = { stopped: false };
          void scrollFeed({
            // 20-30 posts per round (Jibran, 21.10.2026), so there is enough to choose from.
            targetPosts: 20 + Math.floor(Math.random() * 11),
            maxMs: 8 * 60_000,
            signal: scrolling,
            // In the round's own window nobody else uses the page; on Jibran's tab his input stops it.
            stopOnUserInput: !(msg as { ownWindow?: boolean }).ownWindow,
            onProgress: (posts, steps) =>
              void browser.runtime
                .sendMessage({ type: 'scrollProgress', posts, steps })
                .catch(() => undefined),
          })
            .then((r) => sendResponse({ ok: true, ...r }))
            .catch((err: unknown) =>
              sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
            )
            .finally(() => (scrolling = null));
          return true; // answer comes later
        } else if (m?.type === 'commentOnPost') {
          const c = msg as {
            text: string;
            excerpt: string;
            dryRun: boolean;
            readMs?: number;
            reviewMs?: number;
          };
          const pause = (v: unknown) =>
            typeof v === 'number' ? Math.min(Math.max(v, 0), 120_000) : undefined;
          void commentOnPost({
            text: c.text,
            excerpt: c.excerpt,
            dryRun: c.dryRun !== false,
            readMs: pause(c.readMs),
            reviewMs: pause(c.reviewMs),
          })
            .then(sendResponse)
            .catch((err: unknown) =>
              sendResponse({
                dryRun: true,
                found: false,
                typed: false,
                button: null,
                clicked: false,
                verified: false,
                postedUrl: null,
                note: `Error: ${err instanceof Error ? err.message : String(err)}`,
              }),
            );
          return true;
        } else if (m?.type === 'stopScroll') {
          if (scrolling) {
            scrolling.stopped = true;
            scrolling.reason = 'stop';
          }
          sendResponse({ ok: true });
        } else {
          return false;
        }
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return false;
    });
  },
});
