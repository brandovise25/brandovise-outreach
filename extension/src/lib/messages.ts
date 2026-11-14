import { z } from 'zod';

// Messages from extension pages (options, side panel) to the service worker.
export const UiRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status') }),
  z.object({ type: z.literal('login'), email: z.string(), password: z.string() }),
  z.object({ type: z.literal('logout') }),
  z.object({ type: z.literal('aiPing') }),
  z.object({ type: z.literal('setDeviceName'), name: z.string().max(80) }),
  z.object({ type: z.literal('setServer'), url: z.string().max(200) }),
  z.object({ type: z.literal('token') }),
  z.object({ type: z.literal('runJobs') }),
  z.object({ type: z.literal('stopRobot') }),
  z.object({ type: z.literal('showRobot') }),
  z.object({ type: z.literal('commentRoundStatus') }),
  z.object({ type: z.literal('setRoundSchedule'), on: z.boolean() }),
  z.object({ type: z.literal('postStatus') }),
  z.object({ type: z.literal('getShowWindows') }),
  z.object({ type: z.literal('setShowWindows'), on: z.boolean() }),
  z.object({ type: z.literal('getRobotSurface') }),
  z.object({ type: z.literal('setRobotSurface'), surface: z.enum(['tab', 'window']) }),
]);
export type UiRequest = z.infer<typeof UiRequest>;

export interface Status {
  signedIn: boolean;
  apiUrl: string;
  version: string;
  deviceName: string;
  lastHeartbeat: string | null;
  lastError: string | null;
  dryRun: boolean | null;
  paused: boolean | null;
}

export type UiResponse =
  { ok: true; status?: Status; result?: unknown } | { ok: false; error: string };

export async function sendToWorker(req: UiRequest): Promise<UiResponse> {
  return (await browser.runtime.sendMessage(req)) as UiResponse;
}
