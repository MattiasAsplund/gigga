export type ContractStatus = 'pending_signatures' | 'active' | 'void';
export type SignerRole = 'buyer' | 'seller';

export interface SignatureState {
  status: ContractStatus;
  buyerSignedAt: Date | null;
  sellerSignedAt: Date | null;
}

/**
 * Avtalets tillståndsmaskin som ren funktion — ingen databas, ingen klocka.
 *
 * Reglerna:
 * - En part som redan signerat ändrar ingenting, inte heller sin tidsstämpel. Att signera
 *   igen är alltså ofarligt, vilket är vad som gör API:et idempotent (S7.6).
 * - Avtalet blir `active` först när båda signaturerna finns. Ordningen spelar ingen roll.
 * - Ett `void` avtal går inte att signera.
 *
 * Anroparen ansvarar för att det som följer av `active` — förfrågan tilldelad, övriga
 * anbud avslagna — sker i samma transaktion.
 */
export function applySignature(
  state: SignatureState,
  role: SignerRole,
  now: Date,
): SignatureState {
  if (state.status === 'void') {
    throw new Error('Ett void avtal går inte att signera.');
  }

  const alreadySigned =
    role === 'buyer' ? state.buyerSignedAt !== null : state.sellerSignedAt !== null;
  if (alreadySigned) return { ...state };

  const next: SignatureState = {
    ...state,
    buyerSignedAt: role === 'buyer' ? now : state.buyerSignedAt,
    sellerSignedAt: role === 'seller' ? now : state.sellerSignedAt,
  };

  const bothSigned = next.buyerSignedAt !== null && next.sellerSignedAt !== null;
  return { ...next, status: bothSigned ? 'active' : next.status };
}

export const isActive = (state: SignatureState): boolean => state.status === 'active';
