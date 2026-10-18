import { join } from "node:path";

export interface SessionIdentity {
  channel: string;
  accountId: string;
  conversationId: string;
}

export function sessionKey(identity: SessionIdentity): string {
  return JSON.stringify([identity.channel, identity.accountId, identity.conversationId]);
}

export function sessionPath(root: string, identity: SessionIdentity): string {
  // Hex avoids path separators and case-only collisions on case-insensitive filesystems.
  return join(root, ...[identity.channel, identity.accountId, identity.conversationId]
    .map((part) => Buffer.from(part).toString("hex")));
}
