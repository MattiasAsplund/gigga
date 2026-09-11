/**
 * Kompileringen av avtalet: typst-källa in, PDF ut.
 *
 * Motorn är en tjänst för sig — `rust-server`, en Rust-tjänst som tar emot en `.typ`-fil
 * som multipart och svarar med PDF:en. Den ligger utanför API:et av samma skäl som
 * Postgres gör det: en typsättningsmotor är inte något ett Fastify-API ska bära i sin
 * egen process, och den som byter motor ska inte behöva röra domänen.
 *
 * Sömmen här är densamma som för mailern och objektlagringen: ett gränssnitt, en
 * HTTP-implementation i drift och en i minnet i testerna.
 */

export interface TypstDiagnostic {
  severity: string;
  message: string;
  location?: string;
  hints?: string[];
}

/** Motorn svarade, men källan gick inte att sätta. Diagnostiken kommer från typst. */
export class TypstCompileError extends Error {
  readonly diagnostics: TypstDiagnostic[];

  constructor(message: string, diagnostics: TypstDiagnostic[] = []) {
    super(message);
    this.name = 'TypstCompileError';
    this.diagnostics = diagnostics;
  }
}

export interface TypstCompiler {
  /** `filename` syns bara i motorns felmeddelanden — PDF:en namnges av anroparen. */
  compile(input: { source: string; filename?: string }): Promise<Uint8Array>;
}

export interface MemoryTypstCompiler extends TypstCompiler {
  /** Varje källa som kompilerats, i ordning. */
  readonly compiled: string[];
  /** Låter nästa kompilering misslyckas — motorn nere, eller källan trasig. */
  failWith(error: Error | null): void;
}

const PDF_PREAMBLE = '%PDF-1.7\n% gigga test-compiler\n';

/**
 * För tester: en "PDF" som bär sin egen källa.
 *
 * Byten är inte ett riktigt dokument, men de börjar som ett och innehåller källan — så
 * ett test kan pröva *vad* som hamnade i lagringen utan att tolka PDF-syntax, och utan
 * att en levande motor behöver vara uppe för att sviten ska gå.
 */
export function createMemoryTypstCompiler(): MemoryTypstCompiler {
  const compiled: string[] = [];
  let failure: Error | null = null;

  return {
    compiled,
    failWith(error) {
      failure = error;
    },
    async compile({ source }) {
      if (failure) throw failure;
      compiled.push(source);
      return new TextEncoder().encode(PDF_PREAMBLE + source);
    },
  };
}

/** Kompileringen får inte hänga kvar när motorn slutat svara mitt i. */
const COMPILE_TIMEOUT_MS = 30_000;

export function createHttpTypstCompiler(baseUrl: string): TypstCompiler {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/v1/compile`;

  return {
    async compile({ source, filename = 'contract.typ' }) {
      const form = new FormData();
      // Ändelsen måste vara .typ — motorn avvisar allt annat innan den läser innehållet.
      form.append('source_file', new Blob([source], { type: 'text/plain' }), filename);

      const res = await fetch(endpoint, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(COMPILE_TIMEOUT_MS),
      });

      if (!res.ok) {
        // Motorns fel är JSON med diagnostik; allt annat är motorn själv som är trasig.
        const body = await res.text();
        let diagnostics: TypstDiagnostic[] = [];
        try {
          diagnostics = (JSON.parse(body) as { diagnostics?: TypstDiagnostic[] }).diagnostics ?? [];
        } catch {
          /* inte JSON — meddelandet nedan bär kroppen som den är */
        }
        throw new TypstCompileError(
          `typst svarade ${res.status}: ${diagnostics.map((d) => d.message).join('; ') || body}`,
          diagnostics,
        );
      }

      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
