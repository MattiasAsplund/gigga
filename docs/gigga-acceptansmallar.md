# Acceptansmallar för gigga — förslag

## Designprincipen

Ett acceptanskriterium duger om **en utomstående som inte var med i samtalet kan läsa det och svara ja eller nej**. Klarar det inte det testet är det inte ett kriterium, det är en förhoppning.

Praktisk konsekvens: kriterier lagras som rader, inte som fritext. Varje rad har id, påstående, verifieringsmetod och status. Då blir acceptansen en checklista som båda parter bockar av, och en tvist handlar om enskilda rader istället för om hela leveransen.

## Tre lager

Problemet med "vilken sort som helst" är att typade mallar inte täcker allt, medan en enda generisk mall blir så vag att den inte hjälper. Lösningen är att dela upp:

1. **Basmall** — gäller varje gigg oavsett typ. Här ligger allt som handlar om själva affären.
2. **Typmall** — läggs ovanpå basen och innehåller det som är specifikt för leveranstypen.
3. **Fritt tillägg** — kundens egna kriterier, som måste passera samma formkrav som de genererade.

En gigg som inte matchar någon typ kör bas + fritt tillägg, med ett skärpt intervjusteg. Ingen förfrågan blir omöjlig att lägga in, men vagheten kostar extra frågor.

---

# Lager 1 — Basmallen

Fält som alltid fylls i, oavsett vad giggen handlar om.

## 1.1 Leveransobjekt

Vad som faktiskt överlämnas, konkret:

- Källkod i vilket repo, vilken branch, levererad hur (PR, tagg)
- Eventuella artefakter utöver kod (SQL-skript, konfiguration, migreringsfiler)
- Dokumentation: vad, i vilken omfattning, var
- Om något ska driftsättas — i vilken miljö, av vem

## 1.2 Verifieringsmiljö och verifieringsmetod

- I vilken miljö sker verifieringen (kundens testmiljö, leverantörens demomiljö, lokalt)
- Vem kör verifieringen
- Vilka testdata som används och vem som tillhandahåller dem
- Hur resultatet dokumenteras

Det här fältet är där de flesta fastprisaffärer havererar. "Det fungerar hos mig" är inte en acceptansgrund.

## 1.3 Acceptanskriterier

Skrivs i formen **När `<förutsättning>`, ska `<observerbart utfall>`**.

Exempel på duglig formulering:
- När en användare med rollen administratör öppnar sidan Kunder, ska en lista med samtliga aktiva kunder visas sorterad på namn.
- När importfilen innehåller en rad med ogiltigt personnummer, ska raden avvisas och övriga rader importeras.

Exempel på odugliga:
- Sidan ska vara snabb och användarvänlig.
- Integrationen ska fungera.

Plattformen bör aktivt vägra publicera kriterier utan observerbart utfall.

## 1.4 Alltid gällande minimikrav

Slipper skrivas om varje gång, men gäller ändå och kan pekas på vid tvist:

- Koden går att starta från rent läge enligt medföljande instruktion
- Inga hemligheter, nycklar eller lösenord i källkod eller repo
- Fel hanteras — applikationen kraschar inte på förutsägbara felfall
- Ingen befintlig funktionalitet som fanns före leveransen slutar fungera
- Tredjepartsberoenden är listade med licens

## 1.5 Ingår inte

Explicit lista över vad som ligger utanför. Minst lika viktig som kravlistan — vid fast pris är det oskrivna antaganden som äter marginalen.

Genereras som utkast av plattformen utifrån typen, och kunden får stryka eller lägga till.

## 1.6 Kundens åtaganden

Med tidsfrister:

- Åtkomster som ska tillhandahållas, senast när
- Testdata, testmiljö, testkonto
- Namngiven kontaktperson
- Svarstid på frågor under leveransen (förslag: två arbetsdagar)

## 1.7 Klockstopp

Om kunden inte levererar enligt 1.6 pausas leveranstiden, dag för dag. Utan den här regeln är det leverantören som betalar för kundens långsamhet, och det får du inte behålla bra leverantörer med.

## 1.8 Acceptansfönster

- Kunden har X dagar på sig att godkänna eller underkänna (förslag: fem arbetsdagar)
- Underkännande måste ange vilka kriterierader som inte uppfylls — inte en allmän missnöjesförklaring
- Uteblivet svar innebär automatisk acceptans
- Antal omtag som ingår i priset (förslag: två). Därefter blir det en ny gigg

## 1.9 Garanti

Avvikelser mot godkända acceptanskriterier åtgärdas utan kostnad inom 30 dagar efter acceptans. Nya önskemål är inte garantiärenden — de är nya giggar.

## 1.10 Rättigheter

- Vem äger den levererade koden
- Vilka tredjepartslicenser som accepteras och vilka som inte gör det
- Om leverantören återanvänder eget befintligt material, på vilka villkor

---

# Lager 2 — Typmallar

Varje typ har egna intervjufrågor och egna acceptanspunkter som läggs till basen. Nedan ett startbibliotek som täcker det mesta av korta uppdrag.

## Integration mellan två system

**Frågor:** Vilka två system? Riktning — enkelriktat eller åt båda håll? Vilket protokoll och vilken autentisering? Har du dokumentation för mottagande system? Finns testmiljö på båda sidor? Hur ofta ska data överföras? Vad ska hända vid fel — köa, larma, kasta?

**Extra acceptanspunkter:** Verifierad överföring av minst ett verkligt testfall i båda riktningarna. Definierat och verifierat beteende vid otillgängligt målsystem. Loggning som visar vad som överförts och när.

## Datamigrering eller import

**Frågor:** Från vilken källa och i vilket format? Ungefärlig datavolym? Vem definierar fältmappningen? Vad ska hända med rader som inte går att tolka? Ska migreringen kunna köras om utan dubbletter? Behövs återställningsmöjlighet?

**Extra acceptanspunkter:** Avstämning av antal poster mellan källa och mål. Definierad hantering av avvikande rader, med rapport. Omkörning ger samma resultat utan dubbletter.

## API-endpoint eller backend-funktion

**Frågor:** Vilken funktion, vilka in- och utdata? Autentisering och behörighet? Var ska den ligga — befintlig kodbas eller ny? Prestandakrav? Ska den dokumenteras i befintlig API-dokumentation?

**Extra acceptanspunkter:** Endpointen svarar enligt angivet kontrakt för giltiga anrop. Definierade felkoder vid ogiltiga anrop. Obehörig anropare nekas.

## Skärm, vy eller formulär

**Frågor:** Vilken design finns — skiss, befintligt designsystem, eller fritt? Vilka fält och vilken validering? Vilka roller ska se den? Ska den fungera på mobil? Vilka webbläsare?

**Extra acceptanspunkter:** Samtliga angivna fält finns med rätt validering. Vyn fungerar i angivna webbläsare och skärmstorlekar. Felmeddelanden visas vid ogiltig inmatning.

Det här är den typ där tvister oftast handlar om utseende. Kräv antingen en skiss eller en explicit skrivning om att utformningen är leverantörens val.

## Rapport, export eller dashboard

**Frågor:** Vilka siffror, från vilka källor, med vilka filter? Hur ofta uppdateras den? Vilket format — skärm, PDF, Excel, fil? Finns en befintlig rapport som resultatet ska stämma med?

**Extra acceptanspunkter:** Resultatet stämmer med en angiven referensberäkning för en angiven period. Filtren ger förväntat utfall för minst ett testfall per filter.

## Automatisering eller schemalagt jobb

**Frågor:** Vad ska köras, hur ofta, i vilken miljö? Vad händer om körningen misslyckas — larm till vem? Får jobbet köras om? Hur länge sparas loggar?

**Extra acceptanspunkter:** Jobbet kör enligt angivet schema i angiven miljö. Misslyckad körning larmar enligt överenskommelse. Manuell omkörning är möjlig.

## Buggfix i befintlig kod

**Frågor:** Hur återskapas felet, steg för steg? I vilken miljö uppträder det? Har du åtkomst till koden att ge? Finns tester sedan tidigare? Är det felet som ska bort, eller symtomet?

**Extra acceptanspunkter:** Det beskrivna återskapningsfallet ger inte längre felet. Ett regressionstest som fångar felet finns. Angivna angränsande funktioner fungerar oförändrat.

Här är avgränsningen svårast — utredningstiden är okänd innan man börjat. Överväg att sätta ett tak: om felet inte är lokaliserat inom X timmar övergår giggen till en betald felsökningsgigg.

## Prestanda eller optimering

**Frågor:** Vad är långsamt idag, uppmätt hur? Vilket är målvärdet? Under vilken last och med vilken datavolym mäts det? Får beteendet ändras för att nå målet?

**Extra acceptanspunkter:** Angiven mätning under angivna förutsättningar når målvärdet. Funktionellt utfall är oförändrat före och efter.

Den här typen får aldrig lämnas utan uppmätt utgångsläge. "Snabbare" är inte accepterbart.

## Miljö, uppgradering eller driftsättning

**Frågor:** Från vilken version till vilken? Vilken infrastruktur? Vem har åtkomst till målmiljön? Får driftstopp förekomma och i så fall när? Finns återställningsplan?

**Extra acceptanspunkter:** Målmiljön kör angiven version. Angiven rökteslista passerar efter uppgradering. Dokumenterad väg tillbaka finns.

## Förstudie eller utredning

Leveransobjektet är ett dokument, inte kod. Acceptansen blir därmed annorlunda.

**Frågor:** Vilka frågor ska besvaras? Vem ska läsa resultatet? Ska det innehålla rekommendation eller bara underlag? Ska det mynna ut i en kravspec som kan användas för nästa gigg?

**Extra acceptanspunkter:** Samtliga i förväg listade frågor är besvarade. Rekommendationen är motiverad och alternativen redovisade. Om kravspec ingår — den uppfyller plattformens formkrav för publicering.

Kom ihåg regeln om att den som gör förstudien inte ska ha förtur på bygget.

## Övrigt

Bas plus skärpt intervju. Här måste plattformen ställa de frågor typmallarna annars svarar på:

- Beskriv hur du kommer avgöra om det här är klart
- Vad är det minsta som måste fungera för att du ska betala
- Vad skulle göra dig besviken trots att allt du bett om är levererat
- Finns det något liknande som redan fungerar, som resultatet kan jämföras med

Sista frågan är den mest värdefulla av dem — den fångar outtalade förväntningar, som är det som sänker fastprisaffärer.

---

# Lager 3 — Intervjuflödet

**Steg 0. Fri beskrivning.** Kunden skriver med egna ord. Ingen struktur påtvingad.

**Steg 1. Klassificering.** Plattformen föreslår typ utifrån texten, kunden bekräftar eller ändrar. Flera typer får väljas — då slås frågorna ihop, dubbletter tas bort.

**Steg 2. Kontext.** Nytt eller befintligt system? Vilken stack? Vem har åtkomst? Vad händer om det inte blir gjort — ger en känsla för hur skarpt det är.

**Steg 3. Typspecifika frågor.** Enligt lager 2.

**Steg 4. Avgränsning.** Plattformen genererar ett utkast till "ingår inte" utifrån typen och det som sagts. Kunden stryker och lägger till. Det här steget upplevs som irriterande av kunden och är samtidigt det mest värdefulla — motstå frestelsen att göra det valfritt.

**Steg 5. Kriterieutkast.** Plattformen formulerar acceptanskriterierna som rader. Kunden redigerar och godkänner var och en. **Kunden måste aktivt godkänna** — det är också vad som håller ansvaret för kravspecen hos kunden och inte hos gigga.

**Steg 6. Publiceringskontroll.** Förfrågan kan inte publiceras om något blockerande fält saknas: leveransobjekt, verifieringsmiljö, minst tre acceptanskriterier med observerbart utfall, ingår-inte-lista, kundens åtaganden. Visa gärna en fullständighetsindikator under hela flödet — den driver beteende bättre än felmeddelanden i slutet.

**Steg 7. Publik frågefas.** Leverantörer ställer frågor, svaren syns för alla. Svar som ändrar omfattningen skrivs in i kriterierna och versionshanteras, så att alla anbud avser samma version.

---

# Noteringar för datamodellen

- Acceptanskriterium som egen entitet med status per rad, inte fritextfält på giggen
- Versionering av kravspecen, med anbud kopplade till en specifik version
- Typmallarna som data, inte kod — du kommer vilja lägga till typer utan att deploya
- Frågorna kopplade till typ med villkorslogik, så att flödet kan växa
- Kundens godkännande av kriterielistan loggas med tidsstämpel — det är ditt ansvarsskydd
