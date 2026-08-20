import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  CLAUSE_HEADINGS,
  call,
  loadSpec,
  type ClauseKind,
  type Completeness,
  type GigType,
  type RequestSpec as Spec,
  type SpecCriterion,
  type SpecQuestion,
} from '../api.ts';
import { useToken } from '../auth.tsx';
import { Empty, Notice, Status, formatDate, useLoader } from '../components/ui.tsx';

/**
 * Intervjun: kundens väg från "jag vill ha något gjort" till en kravspec någon kan
 * prissätta.
 *
 * Sidan känner inte till en enda uppdragstyp eller fråga. Den renderar det API:et
 * lämnar — `kind` säger vilket fält som ska ritas, `options` vad som går att välja,
 * `visible` om frågan gäller just nu. En ny typmall i katalogen dyker upp här utan att
 * någon rad i den här filen ändras.
 */
export function RequestSpec() {
  const { requestId = '' } = useParams();
  const token = useToken();

  const { data, error, reload } = useLoader(() => loadSpec(requestId, token), [requestId]);
  const [actionError, setActionError] = useState<unknown>(null);

  const fail = (cause: unknown) => setActionError(cause);
  const done = () => {
    setActionError(null);
    reload();
  };

  return (
    <>
      <h1>Kravspec</h1>
      <p className="lede">
        Uppdragstypen avgör vilka frågor som ställs, och svaren blir de acceptanskriterier
        båda parter bockar av. En förfrågan utan fastställd kravspec går inte att lämna
        anbud på.
      </p>

      <Notice error={error} />
      <Notice error={actionError} />

      {data === null && <ChooseTypes requestId={requestId} onDone={done} onError={fail} />}

      {data && (
        <>
          <div className="meta" style={{ marginBottom: '1.5rem' }} data-testid="spec-head">
            <span data-testid="spec-version">
              <span className="eyebrow">Version</span> v{data.version.version}
            </span>
            <Status value={data.version.status} />
            <span>
              <span className="eyebrow">Typ</span>{' '}
              {data.gigTypes.map((type) => type.name).join(', ') || '—'}
            </span>
            <span>
              <span className="eyebrow">Publicerad</span> {formatDate(data.version.publishedAt)}
            </span>
            <Link to={`/requests/${requestId}`}>Till förfrågan</Link>
          </div>

          <Progress completeness={data.completeness} />

          {data.version.status === 'draft' ? (
            <>
              <Questions spec={data} requestId={requestId} onDone={done} onError={fail} />
              <Criteria spec={data} requestId={requestId} onDone={done} onError={fail} />
              <Publish spec={data} requestId={requestId} onDone={done} onError={fail} />
            </>
          ) : (
            <Published spec={data} requestId={requestId} onDone={done} onError={fail} />
          )}
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- steg 1 */

function ChooseTypes({
  requestId,
  onDone,
  onError,
}: {
  requestId: string;
  onDone: () => void;
  onError: (cause: unknown) => void;
}) {
  const token = useToken();
  const { data, error } = useLoader(() => call<{ items: GigType[] }>('/gig-types', { token }));
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const toggle = (key: string) =>
    setChosen((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await call(`/requests/${requestId}/spec`, { token, body: { gigTypes: chosen } });
      onDone();
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <h2>Vilken sorts uppdrag är det?</h2>
      <p>
        Välj en eller flera. Frågorna slås ihop, och en fråga som två typer ställer får du
        bara en gång. Passar ingen mall finns <strong>Övrigt</strong>, som ställer de
        frågor mallarna annars svarar på.
      </p>

      <Notice error={error} />

      <form className="stack" onSubmit={submit}>
        <div className="choices" data-testid="gig-types">
          {data?.items.map((type) => (
            <label className="choice" key={type.key} data-testid="gig-type" data-key={type.key}>
              <input
                type="checkbox"
                checked={chosen.includes(type.key)}
                onChange={() => toggle(type.key)}
              />
              <span>
                <strong>{type.name}</strong>
                {type.summary && <span className="choice__hint">{type.summary}</span>}
                <span className="choice__count mono">
                  {type.questionCount} frågor · {type.criterionCount} kriterierader
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="actions">
          <button type="submit" disabled={busy || chosen.length === 0} data-testid="open-spec">
            Börja intervjun
          </button>
        </div>
      </form>
    </section>
  );
}

/* ---------------------------------------------------------------- indikatorn */

/**
 * Fullständighetsindikatorn. Den drivs av samma räkning som publiceringen gör, så det
 * som står här är precis det som avgör — inte en gissning gränssnittet gör själv.
 */
const BLOCKERS_SHOWN = 4;

function Progress({ completeness }: { completeness: Completeness }) {
  const share =
    completeness.requiredQuestions === 0
      ? 0
      : completeness.answeredRequired / completeness.requiredQuestions;

  return (
    <section className="tally" data-testid="completeness">
      <div className="tally__row">
        <span className="eyebrow">Obligatoriska frågor</span>
        <span className="mono" data-testid="answered-count">
          {completeness.answeredRequired}/{completeness.requiredQuestions}
        </span>
      </div>
      <div className="progress" aria-hidden="true">
        <div className="progress__bar" style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
      <div className="tally__row">
        <span className="eyebrow">Godkända kriterier</span>
        <span className="mono" data-testid="approved-count">
          {completeness.approvedCriteria}/{completeness.criteria}
        </span>
      </div>

      {completeness.blockers.length > 0 && (
        <ul className="plain-list tally__blockers">
          {/*
            Bara de första: i början är varje obesvarad fråga en blockerare, och hela
            listan vore en kopia av intervjun nedanför — en vägg text som skjuter undan
            det man faktiskt ska göra. Räknarna ovanför bär helheten.
          */}
          {completeness.blockers.slice(0, BLOCKERS_SHOWN).map((blocker) => (
            <li key={`${blocker.code}:${blocker.path}`} data-testid="blocker">
              {blocker.detail}
            </li>
          ))}
          {completeness.blockers.length > BLOCKERS_SHOWN && (
            <li data-testid="blockers-rest">
              … och {completeness.blockers.length - BLOCKERS_SHOWN} till.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- frågorna */

/** Svaret som fältet vill ha det: en sträng i inmatningen, rätt typ på vägen ut. */
type Draft = Record<string, unknown>;

function initialDrafts(spec: Spec): Draft {
  const drafts: Draft = {};
  for (const answer of spec.answers) drafts[answer.questionKey] = answer.value;
  return drafts;
}

function Questions({
  spec,
  requestId,
  onDone,
  onError,
}: {
  spec: Spec;
  requestId: string;
  onDone: () => void;
  onError: (cause: unknown) => void;
}) {
  const token = useToken();
  const [drafts, setDrafts] = useState<Draft>(() => initialDrafts(spec));
  const [busy, setBusy] = useState(false);

  const visible = spec.questions.filter((question) => question.visible);
  const groups = [...new Set(visible.map((question) => question.templateKey))];
  const name = (key: string) =>
    key === 'base'
      ? 'Gäller varje gigg'
      : (spec.gigTypes.find((type) => type.key === key)?.name ?? key);

  const set = (key: string, value: unknown) =>
    setDrafts((current) => ({ ...current, [key]: value }));

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Bara det som faktiskt har ett värde skickas: ett tomt fält är en obesvarad fråga,
    // inte ett svar som lyder "".
    const answers = visible
      .filter((question) => filled(drafts[question.key]))
      .map((question) => ({ questionKey: question.key, value: drafts[question.key] }));
    if (answers.length === 0) return;

    setBusy(true);
    try {
      await call(`/requests/${requestId}/spec/answers`, {
        token,
        method: 'PUT',
        body: { answers },
      });
      onDone();
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <h2>Frågorna</h2>
      <p>
        Svaren är underlaget för kriterierna. En fråga kan öppna en följdfråga — spara, så
        dyker den upp.
      </p>

      <form className="stack interview" onSubmit={save}>
        {groups.map((group) => (
          <fieldset className="group" key={group} data-testid="question-group" data-key={group}>
            <legend>{name(group)}</legend>
            {visible
              .filter((question) => question.templateKey === group)
              .map((question) => (
                <Field
                  key={question.key}
                  question={question}
                  value={drafts[question.key]}
                  onChange={(value) => set(question.key, value)}
                />
              ))}
          </fieldset>
        ))}

        <div className="actions">
          <button type="submit" disabled={busy} data-testid="save-answers">
            Spara svaren
          </button>
        </div>
      </form>
    </section>
  );
}

const filled = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '';

const numberIn = (config: Record<string, unknown>, key: string): number | undefined =>
  typeof config[key] === 'number' ? (config[key] as number) : undefined;

/**
 * Ett fält per frågetyp. Det här är hela kopplingen mellan katalogens data och
 * gränssnittet: sju former, oavsett hur många frågor och typer som tillkommer.
 */
function Field({
  question,
  value,
  onChange,
}: {
  question: SpecQuestion;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const testId = `answer-${question.key}`;
  const required = question.required;

  return (
    <label
      className="question"
      data-testid="question"
      data-key={question.key}
      data-kind={question.kind}
      data-answered={question.answered ? 'true' : 'false'}
    >
      <span>
        {question.prompt}
        {!required && <span className="question__optional"> (frivillig)</span>}
      </span>
      {question.helpText && <span className="question__help">{question.helpText}</span>}

      {question.kind === 'longtext' && (
        <textarea
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          data-testid={testId}
        />
      )}

      {question.kind === 'text' && (
        <input
          type="text"
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          data-testid={testId}
        />
      )}

      {question.kind === 'integer' && (
        <input
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          min={numberIn(question.config, 'minimum')}
          max={numberIn(question.config, 'maximum')}
          onChange={(event) =>
            onChange(event.target.value === '' ? '' : Number(event.target.value))
          }
          data-testid={testId}
        />
      )}

      {question.kind === 'date' && (
        <input
          type="date"
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          data-testid={testId}
        />
      )}

      {question.kind === 'bool' && (
        <select
          value={value === undefined ? '' : String(value)}
          onChange={(event) =>
            onChange(event.target.value === '' ? '' : event.target.value === 'true')
          }
          data-testid={testId}
        >
          <option value="">Välj</option>
          <option value="true">Ja</option>
          <option value="false">Nej</option>
        </select>
      )}

      {question.kind === 'choice' && (
        <select
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          data-testid={testId}
        >
          <option value="">Välj</option>
          {question.options.map((option) => (
            <option value={option.key} key={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      )}

      {question.kind === 'multichoice' && (
        <span className="choices choices--tight" data-testid={testId}>
          {question.options.map((option) => {
            const chosen = Array.isArray(value) ? (value as string[]) : [];
            return (
              <label className="choice choice--inline" key={option.key}>
                <input
                  type="checkbox"
                  checked={chosen.includes(option.key)}
                  data-testid={`${testId}-${option.key}`}
                  onChange={() =>
                    onChange(
                      chosen.includes(option.key)
                        ? chosen.filter((key) => key !== option.key)
                        : [...chosen, option.key],
                    )
                  }
                />
                <span>{option.label}</span>
              </label>
            );
          })}
        </span>
      )}
    </label>
  );
}

/* ---------------------------------------------------------------- raderna */

const KINDS: ClauseKind[] = ['criterion', 'minimum', 'exclusion', 'term'];

function Criteria({
  spec,
  requestId,
  onDone,
  onError,
}: {
  spec: Spec;
  requestId: string;
  onDone: () => void;
  onError: (cause: unknown) => void;
}) {
  return (
    <section className="section">
      <h2>Kriterierna</h2>
      <p>
        Ett kriterium duger om någon utomstående kan läsa det och svara ja eller nej. Du
        godkänner varje rad — det är din kravspec, inte plattformens. Ändrar du en rad
        faller godkännandet, och raden ska godkännas på nytt.
      </p>

      {KINDS.map((kind) => {
        const rows = spec.criteria.filter((criterion) => criterion.kind === kind);
        if (rows.length === 0) return null;

        return (
          <div key={kind} data-testid="clause-group" data-kind={kind}>
            <h3>{CLAUSE_HEADINGS[kind]}</h3>
            {rows.map((criterion) => (
              <Row
                key={criterion.id}
                criterion={criterion}
                requestId={requestId}
                onDone={onDone}
                onError={onError}
              />
            ))}
          </div>
        );
      })}

      <AddCriterion requestId={requestId} onDone={onDone} onError={onError} />
    </section>
  );
}

function Row({
  criterion,
  requestId,
  onDone,
  onError,
}: {
  criterion: SpecCriterion;
  requestId: string;
  onDone: () => void;
  onError: (cause: unknown) => void;
}) {
  const token = useToken();
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState(criterion.statement);
  const [busy, setBusy] = useState(false);

  const base = `/requests/${requestId}/spec/criteria/${criterion.id}`;

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      setEditing(false);
      onDone();
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className={`clause${criterion.approvedAt ? ' clause--approved' : ''}`}
      data-testid="criterion"
      data-id={criterion.id}
      data-kind={criterion.kind}
      data-approved={criterion.approvedAt ? 'true' : 'false'}
    >
      <div className="clause__body">
        {editing ? (
          <textarea
            value={statement}
            onChange={(event) => setStatement(event.target.value)}
            data-testid="criterion-statement"
          />
        ) : (
          <p className="clause__statement">{criterion.statement}</p>
        )}

        {criterion.verification && !editing && (
          <p className="clause__how">
            <span className="eyebrow">Verifieras</span> {criterion.verification}
          </p>
        )}

        <div className="meta">
          <span className="mono">
            {criterion.origin === 'custom'
              ? 'Din egen rad'
              : `Ur mallen ${criterion.sourceTemplateKey}`}
          </span>
          {criterion.kind === 'criterion' && (
            <span data-testid="approval">
              {criterion.approvedAt ? `Godkänd ${formatDate(criterion.approvedAt)}` : 'Ej godkänd'}
            </span>
          )}
        </div>
      </div>

      <div className="clause__actions">
        {criterion.kind === 'criterion' && !criterion.approvedAt && !editing && (
          <button
            className="secondary"
            disabled={busy}
            data-testid="approve"
            onClick={() => void run(() => call(`${base}/approval`, { token, body: {} }))}
          >
            Godkänn
          </button>
        )}

        {editing ? (
          <button
            disabled={busy}
            data-testid="save-criterion"
            onClick={() =>
              void run(() => call(base, { token, method: 'PATCH', body: { statement } }))
            }
          >
            Spara raden
          </button>
        ) : (
          <button className="quiet" data-testid="edit-criterion" onClick={() => setEditing(true)}>
            Skriv om
          </button>
        )}

        <button
          className="quiet"
          disabled={busy}
          data-testid="strike-criterion"
          onClick={() => void run(() => call(base, { token, method: 'DELETE' }))}
        >
          Stryk
        </button>
      </div>
    </article>
  );
}

function AddCriterion({
  requestId,
  onDone,
  onError,
}: {
  requestId: string;
  onDone: () => void;
  onError: (cause: unknown) => void;
}) {
  const token = useToken();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const verification = String(data.get('verification') ?? '').trim();

    setBusy(true);
    try {
      await call(`/requests/${requestId}/spec/criteria`, {
        token,
        body: {
          kind: data.get('kind'),
          statement: data.get('statement'),
          ...(verification ? { verification } : {}),
        },
      });
      form.reset();
      onDone();
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit} style={{ marginTop: '1.5rem' }}>
      <h3>Lägg till en egen rad</h3>
      <div className="field-row">
        <label style={{ maxWidth: '18rem' }}>
          <span>Sort</span>
          <select name="kind" defaultValue="criterion" data-testid="new-criterion-kind">
            {KINDS.map((kind) => (
              <option value={kind} key={kind}>
                {CLAUSE_HEADINGS[kind]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        <span>Påstående</span>
        <textarea
          name="statement"
          required
          minLength={10}
          placeholder="När …, ska …"
          data-testid="new-criterion-statement"
        />
      </label>
      <label>
        <span>Hur verifieras det?</span>
        <input name="verification" data-testid="new-criterion-verification" />
      </label>
      <div className="actions">
        <button type="submit" disabled={busy} data-testid="add-criterion">
          Lägg till raden
        </button>
      </div>
    </form>
  );
}

/* ---------------------------------------------------------------- publicering */

function Publish({
  spec,
  requestId,
  onDone,
  onError,
}: {
  spec: Spec;
  requestId: string;
  onDone: () => void;
  onError: (cause: unknown) => void;
}) {
  const token = useToken();
  const [busy, setBusy] = useState(false);

  async function publish() {
    setBusy(true);
    try {
      await call(`/requests/${requestId}/spec/publication`, { token, body: {} });
      onDone();
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <h2>Publicera</h2>
      <p>
        Efter publiceringen är lydelsen låst, och anbuden binds till den. Behöver något
        ändras öppnar du en revision — den gällande versionen står kvar tills den nya
        publiceras.
      </p>
      <div className="actions">
        <button
          disabled={busy || !spec.completeness.publishable}
          onClick={() => void publish()}
          data-testid="publish-spec"
        >
          Publicera kravspecen
        </button>
      </div>
    </section>
  );
}

function Published({
  spec,
  requestId,
  onDone,
  onError,
}: {
  spec: Spec;
  requestId: string;
  onDone: () => void;
  onError: (cause: unknown) => void;
}) {
  const token = useToken();
  const [busy, setBusy] = useState(false);

  async function revise() {
    setBusy(true);
    try {
      await call(`/requests/${requestId}/spec/revisions`, { token, body: {} });
      onDone();
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SpecReading spec={spec} />
      <section className="section">
        <h2>Ändra något?</h2>
        <p>
          En revision öppnar nästa utkast som en kopia. Version {spec.version.version} gäller
          tills du publicerat den nya, så anbud som kommer in under tiden avser en lydelse
          som inte flyttar sig.
        </p>
        <div className="actions">
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void revise()}
            data-testid="open-revision"
          >
            Öppna en revision
          </button>
        </div>
      </section>
    </>
  );
}

/**
 * Kravspecen att läsa — för säljaren som ska prissätta den, och för köparen efter
 * publiceringen. Samma innehåll som utkastet, utan knappar.
 */
export function SpecReading({ spec }: { spec: Spec }) {
  const answered = spec.answers;

  return (
    <>
      <section className="section">
        <h2>Kriterierna</h2>
        {KINDS.map((kind) => {
          const rows = spec.criteria.filter((criterion) => criterion.kind === kind);
          if (rows.length === 0) return null;

          return (
            <div key={kind} data-testid="clause-group" data-kind={kind}>
              <h3>{CLAUSE_HEADINGS[kind]}</h3>
              <ul className="plain-list">
                {rows.map((criterion) => (
                  <li key={criterion.id} data-testid="criterion" data-kind={kind}>
                    {criterion.statement}
                    {criterion.verification && (
                      <span className="clause__how">
                        {' '}
                        <span className="eyebrow">Verifieras</span> {criterion.verification}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>

      <section className="section">
        <h2>Svaren</h2>
        {answered.length === 0 ? (
          <Empty>Inga frågor besvarade än.</Empty>
        ) : (
          <dl className="answers" data-testid="answers">
            {answered.map((answer) => (
              <div className="answers__row" key={answer.questionKey} data-testid="answer-row">
                <dt>{answer.prompt}</dt>
                <dd>{readable(answer.value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </>
  );
}

/** Svarets värde som text. Formen kommer ur frågetypen, så alla fem fallen finns här. */
function readable(value: unknown): string {
  if (value === true) return 'Ja';
  if (value === false) return 'Nej';
  if (Array.isArray(value)) return value.join(', ');
  return String(value ?? '—');
}
