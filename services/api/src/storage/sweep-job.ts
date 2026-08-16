import type { SQL } from 'bun';
import type { ObjectStore } from './object-store.ts';
import type { Mailer } from '../mail/mailer.ts';
import { storageAlertEmail } from '../mail/storage-alert-email.ts';
import { sweepOrphanedObjects, type SweepOptions, type SweepResult } from './sweeper.ts';

export interface SweepJobInput extends SweepOptions {
  sql: SQL;
  objects: ObjectStore;
  mailer: Mailer;
  /** Tom adress stänger av larmen. Städningen körs ändå. */
  alertEmail: string;
}

export interface SweepJobResult extends SweepResult {
  alertSent: boolean;
  /** Sant när larmet inte gick fram. Städningen är ändå gjord. */
  alertFailed: boolean;
}

/**
 * Städningen plus larmet.
 *
 * Ligger som egen modul och inte i `index.ts`, så att larmet går att pröva utan att
 * starta en process med en timer i.
 */
export async function runStorageSweep(input: SweepJobInput): Promise<SweepJobResult> {
  const { sql, objects, mailer, alertEmail, ...options } = input;

  const result = await sweepOrphanedObjects(sql, objects, options);

  if (result.markedMissing === 0 || alertEmail === '') {
    return { ...result, alertSent: false, alertFailed: false };
  }

  try {
    await mailer.send(
      storageAlertEmail({
        to: alertEmail,
        marked: result.marked,
        total: result.markedMissing,
      }),
    );
    return { ...result, alertSent: true, alertFailed: false };
  } catch {
    // Markeringen är gjord och står kvar i databasen. Att posten inte gick fram får
    // inte se ut som att städningen misslyckades — anroparen loggar `alertFailed`.
    return { ...result, alertSent: false, alertFailed: true };
  }
}
