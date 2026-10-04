import { createHash } from 'node:crypto';

export async function modelTurn(turn: number, digest: string): Promise<string> {
  return createHash('sha256').update(`${digest}:${turn}`).digest('hex').slice(0, 16);
}
