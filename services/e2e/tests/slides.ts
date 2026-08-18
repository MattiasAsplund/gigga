import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test as base, type FullConfig, type Locator, type Page } from '@playwright/test';

/**
 * Bildspelet: en skärmbild strax före varje navigering, och en sida som pekar på den.
 * Sviten går README:ns flöde genom gränssnittet, så bilderna blir i praktiken en
 * dokumentation av flödet som går att bläddra igenom för hand.
 *
 * Två utskrifter av samma bilder, för att de duger till olika saker:
 *
 * - **flow.marp** — ett bildspel att presentera ur. Sliden är 16:9 och bilden får den
 *   plats som blir över, så en lång vy krymper.
 * - **flow.md** — ett vanligt dokument. Ingen sida att få plats på, så varje bild
 *   behåller sin egen höjd. Det är den som duger till de långa vyerna.
 *
 * Bilderna hamnar under bindmonteringen (services/e2e) och når därför värden direkt,
 * även när sviten körs i Playwrights container från AppHosten.
 *
 * "Strax före" är valt med flit: bilden visar sidan man lämnar, komplett med det som
 * fyllts i och klickats. En bild tagen *efter* navigeringen hade visat nästa sida i tomt
 * skick, och det man faktiskt gjorde hade aldrig synts.
 *
 * Av samma skäl fotas också formulär som skickas utan att adressen ändrar sig — konto,
 * anbud, ändrat anbud. Utan dem stod fälten aldrig ifyllda någonstans i utskriften:
 * bilden före visade ett tomt formulär och bilden efter kvittot, med formuläret
 * undanstoppat.
 *
 * Mappen ligger bredvid konfigurationen. Adressen tas ur Playwrights egen och inte ur
 * `import.meta.url`: paketet är CommonJS, och `__dirname` hade slutat gälla den dag det
 * blir ESM. `configFile` och inte `rootDir` — det senare är testkatalogen (./tests), och
 * bildspelet hör inte hemma bland testfilerna. globalSetup och arbetarna är skilda
 * processer och sätter adressen var för sig.
 */
let slides = '';
const sätt = (config: { configFile?: string; rootDir: string }): void => {
  slides = join(config.configFile ? dirname(config.configFile) : config.rootDir, 'slides');
};
const fil = (namn: string): string => join(slides, namn);
const DECK = 'flow.marp';
const DOK = 'flow.md';

let nummer = 0;
/** Skrivningarna köas: numreringen ska följa händelseordningen, inte diskens nycker. */
let kö: Promise<void> = Promise.resolve();

const köa = (jobb: () => Promise<void>): void => {
  kö = kö.then(jobb);
};

/** globalSetup: bildspelet börjar tomt vid varje körning. */
export default async function nyttBildspel(config: FullConfig): Promise<void> {
  sätt(config);
  await rm(slides, { recursive: true, force: true });
  await mkdir(slides, { recursive: true });

  const härkomst =
    '<!-- Genererad av services/e2e/tests/slides.ts vid varje körning av sviten. Ändringar för hand skrivs över. -->';

  await writeFile(
    fil(DECK),
    [
      '---',
      'marp: true',
      'theme: default',
      'paginate: true',
      'size: 16:9',
      '---',
      '',
      '<!-- _class: lead -->',
      '<!-- _paginate: false -->',
      '',
      '# fastgig',
      '',
      '## Flödet genom gränssnittet',
      '',
      'En bild per navigering, i den ordning Playwright-sviten går vägen.',
      '',
      härkomst,
      '',
    ].join('\n'),
  );

  await writeFile(
    fil(DOK),
    [
      // Sidformatet bor i dokumentet, som marp-deckets gör i sitt front matter. Pandoc
      // läser metadata som mallvariabler, och typst-mallen tar `margin` som en map —
      // därför här och inte som `-V margin=…`, som bara kan sätta enkla värden.
      // Måtten är valda efter bilderna: satsytan är vad de skalas till, och i typsts
      // standardmarginaler blev skärmbilderna för små att läsa.
      '---',
      'papersize: a4',
      'margin:',
      '  x: 1.5cm',
      '  y: 1.5cm',
      '---',
      '',
      '# fastgig — flödet genom gränssnittet',
      '',
      'En bild per navigering, i den ordning Playwright-sviten går vägen. Bilderna är',
      'tagna över hela sidan och inte bara det som ryms i fönstret, så höjden varierar',
      'med vyn och ingenting är avskuret.',
      '',
      härkomst,
      '',
    ].join('\n'),
  );
}

/**
 * Bara sökvägen: värdnamnet är containerns och säger inget för den som tittar. Id:n
 * kortas till sina första tecken — hela uuid:t säger inte mer än så, och obeskuret
 * radbryter det över halva sliden och tar plats från bilden.
 */
function sökväg(url: string): string {
  let path = url;
  try {
    const parsed = new URL(url);
    path = parsed.pathname + parsed.search;
  } catch {
    // Relativa adresser (page.goto('/login')) är redan sökvägen.
  }
  return path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (uuid) => `${uuid.slice(0, 8)}…`);
}

const tom = (url: string): boolean => url === '' || url === 'about:blank';

/**
 * Hela sidan, inte bara det som råkar synas. Flera vyer — ett anbud med dokument och
 * avtal, en katalog med flera rader — är längre än fönstret, och en beskuren bild klipper
 * bort just det steget handlar om. Bredden följer vyporten, höjden följer sidan.
 */
const foto = (page: Page): Promise<Buffer> => page.screenshot({ fullPage: true });

/** Vad bilden visar: varifrån, eventuellt vart, eller en anteckning i stället. */
interface Bildtext {
  från: string;
  till?: string;
  not?: string;
}

/** I bildspelet står texten i en smal spalt bredvid bilden — därför rad för rad. */
function marpText(text: Bildtext): string {
  const rader = [`\`${sökväg(text.från)}\``];
  if (text.till) rader.push('↓', `\`${sökväg(text.till)}\``);
  if (text.not) rader.push(`*${text.not}*`);
  return rader.join('\n\n');
}

/** I dokumentet är samma sak en rubrik, och där finns bredd för en enda rad. */
function dokRubrik(text: Bildtext): string {
  const från = `\`${sökväg(text.från)}\``;
  return text.till ? `${från} → \`${sökväg(text.till)}\`` : `${från} — ${text.not ?? ''}`;
}

/**
 * Testets namn står som sidfot i bildspelet och inte som rubrik: det upprepas på varje
 * slide, och som rubrik trängde det undan både bilden och steget den visar.
 */
function slide(shot: Buffer, rubrik: string, text: Bildtext): void {
  köa(async () => {
    nummer += 1;
    const namn = `${String(nummer).padStart(3, '0')}.png`;
    await writeFile(fil(namn), shot);
    await appendFile(
      fil(DECK),
      `\n---\n\n<!-- _footer: ${JSON.stringify(rubrik)} -->\n\n${marpText(text)}\n\n![bg right:68% fit](${namn})\n`,
    );
    await appendFile(fil(DOK), `\n### ${dokRubrik(text)}\n\n![](${namn})\n`);
  });
}

function avdelare(rubrik: string): void {
  köa(async () => {
    await appendFile(fil(DECK), `\n---\n\n<!-- _class: lead -->\n\n# ${rubrik}\n`);
    await appendFile(fil(DOK), `\n## ${rubrik}\n`);
  });
}

interface Väntande {
  shot: Buffer;
  från: string;
  /** Fylldes något i på sidan innan klicket? Då är bilden värd sin plats ändå. */
  ifylld: boolean;
}

/**
 * Håller reda på vad som är värt en bild. `page.goto()` och `page.reload()` är kända
 * navigeringar och skrivs direkt. Ett klick vet vi däremot inte om förrän efteråt — där
 * tas bilden på spekulation och behålls om adressen ändrade sig, eller om sidans
 * formulär hunnit fyllas i innan klicket.
 */
class Fotograf {
  private väntande: Väntande | null = null;
  /** Sant tills testet fått sin första bild: den sidan ska med, vad som än händer där. */
  private ingenBild = true;
  /** Sant när ett fält fyllts i sedan förra bilden. Nollställs när bilden tas. */
  private ifylld = false;

  constructor(
    private readonly page: Page,
    private readonly rubrik: string,
  ) {}

  /**
   * En känd navigering: bilden hör hit och kan skrivas med en gång. Före den allra
   * första navigeringen är sidan tom, och en bild på ingenting är ingen bild — då blir
   * det ingen, och sidan man kommer till fotas när den lämnas eller opereras.
   */
  async navigering(till: string): Promise<void> {
    this.lös();
    this.ifylld = false;
    if (tom(this.page.url())) return;
    this.bild(await foto(this.page), { från: this.page.url(), till });
  }

  /** Omladdning är också en navigering, men "hit → hit" säger inte vad som händer. */
  async omladdning(): Promise<void> {
    this.lös();
    this.ifylld = false;
    if (tom(this.page.url())) return;
    this.bild(await foto(this.page), { från: this.page.url(), not: 'sidan laddas om' });
  }

  /**
   * Sidan navigerade av egen kraft — klicket vi höll en bild för var alltså en väg
   * vidare. Samma adress som bilden togs på betyder att händelsen gäller något annat
   * (en sen `framenavigated` från föregående steg); då avvaktar vi hellre.
   */
  navigerade(till: string): void {
    const v = this.väntande;
    if (!v || v.från === till) return;
    this.väntande = null;
    this.bild(v.shot, { från: v.från, till });
  }

  /** Före ett klick: bilden hålls tills det visar sig om klicket navigerade. */
  async klick(): Promise<void> {
    this.lös();
    if (tom(this.page.url())) return;
    this.väntande = { shot: await foto(this.page), från: this.page.url(), ifylld: this.ifylld };
    this.ifylld = false;
  }

  /** Ett fält fylldes i. Nästa bild visar alltså ett ifyllt formulär. */
  fylldes(): void {
    this.ifylld = true;
  }

  /** Sista bilden: flödet slutar i ett läge, och det läget är poängen med att visa det. */
  async slut(): Promise<void> {
    this.lös();
    if (tom(this.page.url())) return;
    this.bild(await foto(this.page), {
      från: this.page.url(),
      not: 'läget när steget är klart',
    });
  }

  /**
   * Avgör en väntande bild på adressen: har den ändrats sedan klicket, så navigerade
   * klicket och bilden hör hemma i bildspelet.
   *
   * Stannade klicket kvar på samma adress behålls bilden ändå när ett fält hunnit fyllas
   * i: det är ett formulär som skickats, och den här bilden är det enda stället i
   * utskriften där dess fält står ifyllda. Övriga klick som stannar kvar (uppladdning,
   * namnbyte, en dialogruta) visar inget nytt och kastas — utom på testets första sida,
   * som annars aldrig hade synts.
   */
  private lös(): void {
    const v = this.väntande;
    this.väntande = null;
    if (!v) return;
    const nu = this.page.url();
    if (v.från !== nu) this.bild(v.shot, { från: v.från, till: nu });
    else if (v.ifylld) this.bild(v.shot, { från: v.från, not: 'ifyllt, innan det skickas' });
    else if (this.ingenBild) this.bild(v.shot, { från: v.från, not: 'startläget' });
  }

  private bild(shot: Buffer, text: Bildtext): void {
    this.ingenBild = false;
    slide(shot, this.rubrik, text);
  }
}

const fotografer = new WeakMap<Page, Fotograf>();
let lappad = false;

/**
 * Klicken går genom `Locator.click()` överallt i sviten, så prototypen är den enda punkt
 * där alla passerar. Alternativet vore ett anrop före varje klick som navigerar, och den
 * listan hade blivit fel den dag ett steg lades till.
 *
 * `fill()` och `selectOption()` lappas av samma skäl: bilden före klicket behöver veta
 * om den visar ett ifyllt formulär eller en sida någon bara klickade på.
 */
function lappaLocator(page: Page): void {
  if (lappad) return;
  lappad = true;

  const proto = Object.getPrototypeOf(page.locator('body')) as Pick<
    Locator,
    'click' | 'fill' | 'selectOption'
  >;

  const klick = proto.click;
  proto.click = async function (
    this: Locator,
    ...args: Parameters<Locator['click']>
  ): Promise<void> {
    await fotografer.get(this.page())?.klick();
    return klick.apply(this, args);
  };

  const fyll = proto.fill;
  proto.fill = async function (
    this: Locator,
    ...args: Parameters<Locator['fill']>
  ): Promise<void> {
    fotografer.get(this.page())?.fylldes();
    return fyll.apply(this, args);
  };

  const välj = proto.selectOption;
  proto.selectOption = async function (
    this: Locator,
    ...args: Parameters<Locator['selectOption']>
  ): Promise<string[]> {
    fotografer.get(this.page())?.fylldes();
    return välj.apply(this, args);
  };
}

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    sätt(testInfo.config);
    const fotograf = new Fotograf(page, testInfo.title);
    fotografer.set(page, fotograf);
    lappaLocator(page);

    const goto = page.goto.bind(page);
    page.goto = async (url, options) => {
      await fotograf.navigering(url);
      return goto(url, options);
    };

    const reload = page.reload.bind(page);
    page.reload = async (options) => {
      await fotograf.omladdning();
      return reload(options);
    };

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) fotograf.navigerade(frame.url());
    });

    avdelare(testInfo.title);
    await use(page);

    await fotograf.slut();
    fotografer.delete(page);
    // Kön väntas in här: annars kan nästa test hinna numrera före den här skrivningen.
    await kö;
  },
});

export { expect } from '@playwright/test';
