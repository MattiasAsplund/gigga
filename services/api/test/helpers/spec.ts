import type { SQL } from 'bun';
import { createDraftSpec } from '../../src/db/request-specs.ts';

/**
 * Ger förfrågan en publicerad kravspec — förutsättningen för att kunna lämna anbud (F6.9).
 *
 * Genvägen förbi intervjun är avsiktlig: här räcker det att lydelsen *finns*, och de
 * sviter som behöver den handlar om anbud, avtal och dokument. Själva intervjun — svaren,
 * godkännandena och publiceringskontrollen — har sina egna testfall i I.\* och KS.\*.
 */
export async function publishSpecFor(
  sql: SQL,
  requestId: string,
  typeKeys: string[] = ['other'],
): Promise<string> {
  const spec = await createDraftSpec(sql, { requestId, typeKeys });

  await sql`
    UPDATE request_spec_versions
    SET status = 'published', published_at = now()
    WHERE id = ${spec.version.id}
  `;

  return spec.version.id;
}
